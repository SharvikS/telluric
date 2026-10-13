// Package engine is Telluric's core: a single goroutine that owns all state.
// It reads batches of frames from a capture source, decodes them, tracks
// flows, endpoints and processes, enriches them (geolocation, passive DNS,
// TLS/QUIC ClientHellos, process attribution), runs the detectors, and
// streams snapshots and deltas to subscribed clients.
//
// Nothing in the hot path takes a lock or sends on a channel per packet:
// slow work happens on helper goroutines whose results the loop drains
// between batches.
package engine

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"sync/atomic"
	"time"

	"github.com/SharvikS/telluric/internal/buildinfo"
	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/event"
	"github.com/SharvikS/telluric/internal/geo"
	"github.com/SharvikS/telluric/internal/procmap"
	"github.com/SharvikS/telluric/internal/wire"
)

// Locator geolocates addresses.
type Locator interface {
	Locate(ip netip.Addr) (geo.Location, bool)
}

// ProcAttributor resolves sockets to processes asynchronously.
type ProcAttributor interface {
	Submit([]procmap.Socket) bool
	Results() <-chan procmap.WorkerResult
}

// Client receives frames. Send must not block: it queues the frame and
// reports false once the client is gone. Droppable frames (packet shots)
// may be discarded by a congested client; state frames must not be.
type Client interface {
	Send(frame []byte, text, droppable bool) bool
}

// Config wires an engine.
type Config struct {
	Source   capture.Source
	Mode     string // live | replay | demo
	Locator  Locator
	Home     geo.Home
	Procs    ProcAttributor
	Observer event.Observer
	Hostname string
	Credits  []string
	Logf     func(format string, args ...any)
	// LocalAddrs lists this machine's addresses; it is polled every few
	// seconds. Nil means "learn them from outgoing packets".
	LocalAddrs func() []netip.Addr
}

// Engine is the event loop. Create it with New and start it with Run.
type Engine struct {
	cfg Config

	pkt   decode.Packet
	dnsm  decode.DNSMessage
	hello decode.ClientHello

	flows map[flowKey]*flow
	eps   map[netip.Addr]*endpoint
	procs map[procmap.Key]*proc

	nextFlow, nextEP, nextProc, nextAlert uint32

	clients   []Client
	subscribe chan Client
	homeCh    chan geo.Home
	geoReady  chan struct{}

	local   localAddrs
	ifnames map[int32]string

	shots   shotBatch
	pdns    passiveDNS
	dnsOut  []wire.DNSEvent
	dnsLog  []wire.DNSEvent // recent events for snapshots
	alerts  []wire.Alert    // recent alerts for snapshots
	alertQ  []wire.Alert    // pending broadcast
	gone    wire.Gone
	stats   globalStats
	history []wire.Stats

	procPending bool
	fv          event.Flow // reusable observer view
	alertKeys   map[string]alertRef

	now       int64 // engine clock (ns): wall time, or packet time if ahead
	pktTS     int64 // capture timestamp of the frame being processed
	lastRates int64
	lastDelta int64
	lastStats int64
	lastSweep int64
	lastSec   int64
	lastLocal int64

	frames atomic.Uint64
}

// New returns an engine ready to Run.
func New(cfg Config) *Engine {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	if cfg.Mode == "" {
		cfg.Mode = "live"
	}
	e := &Engine{
		cfg:       cfg,
		flows:     make(map[flowKey]*flow, 1024),
		eps:       make(map[netip.Addr]*endpoint, 512),
		procs:     make(map[procmap.Key]*proc, 64),
		subscribe: make(chan Client, 16),
		homeCh:    make(chan geo.Home, 1),
		geoReady:  make(chan struct{}, 1),
		ifnames:   map[int32]string{},
		pdns:      newPassiveDNS(),
	}
	e.shots.reset()
	if cfg.Observer != nil {
		cfg.Observer.Attach(e)
	}
	return e
}

// Subscribe registers a client. The engine sends it hello and a snapshot
// before any delta, so the client never sees a gap.
func (e *Engine) Subscribe(c Client) { e.subscribe <- c }

// SetHome updates the home location (for example once STUN answers).
func (e *Engine) SetHome(h geo.Home) {
	select {
	case e.homeCh <- h:
	default:
		<-e.homeCh
		e.homeCh <- h
	}
}

// GeoUpdated tells the engine new geolocation databases are available, so
// it re-locates endpoints it could not place before.
func (e *Engine) GeoUpdated() {
	select {
	case e.geoReady <- struct{}{}:
	default:
	}
}

// Frames returns the number of frames processed (safe from any goroutine).
func (e *Engine) Frames() uint64 { return e.frames.Load() }

const (
	shotEvery  = 50 * time.Millisecond
	deltaEvery = 250 * time.Millisecond
	statsEvery = 250 * time.Millisecond
	rateEvery  = 500 * time.Millisecond
	sweepEvery = time.Second
	localEvery = 5 * time.Second
)

// Run processes frames until ctx is done or the source fails. When a finite
// source (a replay) ends, Run keeps serving the final state until ctx ends.
func (e *Engine) Run(ctx context.Context) error {
	e.refreshLocal(time.Now().UnixNano())
	e.refreshIfnames()
	sourceDone := false
	lastShot := time.Now()
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		wait := time.Until(lastShot.Add(shotEvery))
		if wait < 0 {
			wait = 0
		}
		if !sourceDone {
			err := e.cfg.Source.Read(wait, e.handleFrame)
			switch {
			case errors.Is(err, io.EOF):
				e.cfg.Logf("source %s: end of capture", e.cfg.Source.Name())
				sourceDone = true
			case errors.Is(err, capture.ErrClosed):
				return nil
			case err != nil:
				return err
			}
		} else if wait > 0 {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return nil
			}
		}
		if now := time.Now(); now.Sub(lastShot) >= shotEvery {
			lastShot = now
			e.tick(now.UnixNano())
		}
	}
}

// tick runs the periodic work. It is called every ~50 ms.
func (e *Engine) tick(wall int64) {
	if wall > e.now {
		e.now = wall
	}
	e.drainAsync()
	e.flushShots()

	if e.now-e.lastRates >= int64(rateEvery) {
		e.updateRates()
	}
	if e.now-e.lastDelta >= int64(deltaEvery) {
		e.lastDelta = e.now
		e.flushDeltas()
	}
	if e.now-e.lastStats >= int64(statsEvery) {
		e.lastStats = e.now
		e.broadcast(wire.EncodeStats(e.statsMsg()), true, false)
	}
	if e.now-e.lastSweep >= int64(sweepEvery) {
		e.lastSweep = e.now
		e.sweep()
		e.requestProcs()
		if e.cfg.Observer != nil {
			e.cfg.Observer.Tick(e.now)
		}
		e.flushAlerts()
	}
	if e.now-e.lastSec >= int64(time.Second) {
		e.lastSec = e.now
		e.pushHistory()
	}
	if e.now-e.lastLocal >= int64(localEvery) {
		e.refreshLocal(e.now)
		e.refreshIfnames()
	}
}

// drainAsync applies results from helper goroutines and new subscriptions.
func (e *Engine) drainAsync() {
	for {
		select {
		case c := <-e.subscribe:
			e.welcome(c)
		case h := <-e.homeCh:
			e.cfg.Home = h
			e.broadcast(wire.EncodeHome(e.wireHome()), true, false)
		case <-e.geoReady:
			e.relocateAll()
		default:
			if e.cfg.Procs != nil {
				select {
				case r := <-e.cfg.Procs.Results():
					e.applyProcs(r)
					continue
				default:
				}
			}
			return
		}
	}
}

func (e *Engine) welcome(c Client) {
	ifaces := make([]string, 0, len(e.ifnames))
	for _, n := range e.ifnames {
		if n != "lo" {
			ifaces = append(ifaces, n)
		}
	}
	features := map[string]bool{
		"procs": e.cfg.Procs != nil,
		"geo":   e.cfg.Locator != nil,
		"intel": e.cfg.Observer != nil,
	}
	hello := wire.Hello{
		Server:   "telluric/" + buildinfo.Version,
		Mode:     e.cfg.Mode,
		Host:     e.cfg.Hostname,
		Now:      e.now / 1e6,
		Home:     e.wireHome(),
		Ifaces:   ifaces,
		Features: features,
		Credits:  e.cfg.Credits,
	}
	if !c.Send(wire.EncodeHello(hello), true, false) {
		return
	}
	if !c.Send(wire.EncodeSnapshot(e.snapshot()), true, false) {
		return
	}
	e.clients = append(e.clients, c)
}

func (e *Engine) broadcast(frame []byte, text, droppable bool) {
	kept := e.clients[:0]
	for _, c := range e.clients {
		if c.Send(frame, text, droppable) {
			kept = append(kept, c)
		}
	}
	clear(e.clients[len(kept):])
	e.clients = kept
}

func (e *Engine) wireHome() wire.Home {
	h := e.cfg.Home
	out := wire.Home{City: h.City, CC: h.CC, Src: h.Src}
	if out.Src == "" {
		out.Src = "none"
	}
	if h.Known {
		out.Lat, out.Lon = wire.Float(round(h.Lat, 4)), wire.Float(round(h.Lon, 4))
	}
	return out
}

func (e *Engine) refreshIfnames() {
	ifs, err := net.Interfaces()
	if err != nil {
		return
	}
	for _, ifc := range ifs {
		e.ifnames[int32(ifc.Index)] = ifc.Name
	}
}

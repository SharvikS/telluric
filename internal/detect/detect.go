// Package detect watches the engine's events for signs of trouble and
// raises scored alerts: threat-intelligence matches, beaconing, generated
// domains, DNS tunnels, scans, exfiltration, cleartext credentials, ARP
// spoofing, cryptominers, Tor, and statistical anomalies (streaming
// Half-Space Trees). It also maintains the global threat level.
package detect

import (
	"fmt"
	"math"
	"net/netip"

	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/event"
	"github.com/SharvikS/telluric/internal/intel"
)

// Hub fans engine events out to the individual detectors. It implements
// event.Observer and runs entirely on the engine goroutine.
type Hub struct {
	sink   event.Sink
	intel  *intel.Set
	beacon beaconDet
	dns    dnsDet
	scan   scanDet
	arp    arpDet
	exfil  exfilDet
	hst    *hsTrees

	recent    []scored
	torProcs  map[string]bool
	portSeen  map[string]bool
	hstLast   int64
	flowProcs map[uint32]procRef
	pending   map[uint32][]func(procRef) event.Alert
}

type scored struct {
	ts    int64
	score int
	sev   event.Severity
}

type procRef struct {
	id   uint32
	name string
	pid  int
}

// New returns a hub. set may be nil (no threat intelligence).
func New(set *intel.Set) *Hub {
	return &Hub{
		intel:     set,
		beacon:    newBeaconDet(),
		dns:       newDNSDet(),
		scan:      newScanDet(),
		arp:       arpDet{byIP: map[netip.Addr]*arpEntry{}},
		exfil:     exfilDet{seen: map[uint32]bool{}},
		hst:       newHSTrees(25, 10, 256, 7, 1),
		torProcs:  map[string]bool{},
		portSeen:  map[string]bool{},
		flowProcs: map[uint32]procRef{},
		pending:   map[uint32][]func(procRef) event.Alert{},
	}
}

// raiseFlow raises an alert about a flow now and, when the flow's process
// is not known yet (attribution lands a moment after the first packets),
// again under the same key once it is. build must not retain the
// engine-owned *event.Flow.
func (h *Hub) raiseFlow(now int64, f *event.Flow, build func(procRef) event.Alert) {
	p := h.procOf(f)
	h.raise(now, build(p))
	if p.name == "" && len(h.pending) < 4096 {
		h.pending[f.ID] = append(h.pending[f.ID], build)
	}
}

// Attach implements event.Observer.
func (h *Hub) Attach(s event.Sink) { h.sink = s }

func (h *Hub) raise(now int64, a event.Alert) {
	if h.sink == nil {
		return
	}
	switch {
	case a.Score >= 90:
		a.Sev = event.Critical
	case a.Score >= 70:
		a.Sev = event.High
	case a.Score >= 40:
		a.Sev = event.Medium
	case a.Score >= 20:
		a.Sev = event.Low
	default:
		a.Sev = event.Info
	}
	if h.sink.Raise(a) {
		h.recent = append(h.recent, scored{now, a.Score, a.Sev})
	}
}

// who renders "firefox (pid 4242)" or "an unidentified process".
func who(name string, pid int) string {
	if name == "" {
		return "an unidentified process"
	}
	return fmt.Sprintf("%s (pid %d)", name, pid)
}

func dest(f *event.Flow) string {
	s := f.Remote.String()
	if f.Name != "" && f.Name != f.Org && f.Name != f.Remote.Addr().String() {
		s += " " + f.Name
	}
	return s
}

// FlowStart implements event.Observer.
func (h *Hub) FlowStart(now int64, f *event.Flow) {
	h.checkIntelIP(now, f)
	h.checkPort(now, f)
	h.beacon.observe(f)
	h.scan.observe(now, f)
}

// FlowUpdate implements event.Observer.
func (h *Hub) FlowUpdate(now int64, f *event.Flow) {
	if f.ProcName != "" {
		p := procRef{f.Proc, f.ProcName, f.PID}
		h.flowProcs[f.ID] = p
		for _, build := range h.pending[f.ID] {
			h.raise(now, build(p))
		}
		delete(h.pending, f.ID)
		h.beacon.attribute(f)
		if f.ProcName == "tor" && !h.torProcs["tor"] && (f.Remote.Port() == 9001 || f.Remote.Port() == 9030 || f.Remote.Port() == 443) {
			h.torProcs["tor"] = true
			h.raise(now, event.Alert{
				Key: "tor:client", Kind: "tor", Score: 45, Flow: f.ID, Proc: f.Proc, Remote: f.Remote.Addr(),
				Title:    "Tor client building circuits",
				Detail:   fmt.Sprintf("%s → %s: traffic from this machine is being routed through Tor", who(f.ProcName, f.PID), f.Remote),
				Evidence: map[string]any{"relay": f.Remote.String()},
			})
		}
	}
	for _, name := range []string{f.SNI, f.HTTPHost} {
		if name == "" || h.intel == nil {
			continue
		}
		if hit, ok := h.intel.MatchDomain(name); ok {
			h.raise(now, event.Alert{
				Key: "intel:" + name, Kind: "intel", Score: 88, Flow: f.ID, Proc: f.Proc, Remote: f.Remote.Addr(),
				Title:    "Connection to a domain on a threat feed",
				Detail:   fmt.Sprintf("%s → %s (%s), listed by %s", who(f.ProcName, f.PID), name, f.Remote, hit.Source),
				Evidence: map[string]any{"domain": name, "feed": hit.Source},
			})
		}
	}
	h.checkIntelIP(now, f) // re-raise with the process attached
}

// FlowEnd implements event.Observer.
func (h *Hub) FlowEnd(now int64, f *event.Flow) {
	delete(h.flowProcs, f.ID)
	delete(h.pending, f.ID)
	if f.Scope != "public" || f.Proto != decode.ProtoTCP || f.PktsIn+f.PktsOut < 4 {
		return
	}
	score, ready := h.hst.update(flowFeatures(f))
	if !ready || score < 0.995 || now-h.hstLast < 30e9 {
		return // only the strangest half-percent, at most twice a minute
	}
	h.hstLast = now
	sev := 15
	if score >= 0.999 {
		sev = 24
	}
	h.raise(now, event.Alert{
		Key: fmt.Sprintf("anomaly:%d", f.ID), Kind: "anomaly", Score: sev,
		Flow: f.ID, Proc: f.Proc, Remote: f.Remote.Addr(),
		Title: "Unusual connection profile",
		Detail: fmt.Sprintf("%s → %s: %s up, %s down over %s — unlike recent traffic",
			who(f.ProcName, f.PID), dest(f), human(f.BytesOut), human(f.BytesIn), dur(f.Last-f.First)),
		Evidence: map[string]any{"isolation": math.Round(score*100) / 100},
	})
}

// DNS implements event.Observer.
func (h *Hub) DNS(now int64, d *event.DNS) {
	if h.intel != nil {
		for _, name := range append([]string{d.Name}, d.CNAMEs...) {
			if hit, ok := h.intel.MatchDomain(name); ok {
				h.raise(now, event.Alert{
					Key: "intel-dns:" + name, Kind: "intel", Score: 80, Proc: d.Proc,
					Title:    "Lookup of a domain on a threat feed",
					Detail:   fmt.Sprintf("%s resolved %s, listed by %s", who(d.ProcName, 0), name, hit.Source),
					Evidence: map[string]any{"domain": name, "feed": hit.Source},
				})
				break
			}
		}
	}
	h.dns.observe(now, d)
}

// ARP implements event.Observer.
func (h *Hub) ARP(now int64, a *decode.ARP, _ *capture.Frame) {
	if al, ok := h.arp.observe(now, a); ok {
		h.raise(now, al)
	}
}

// Cleartext implements event.Observer.
func (h *Hub) Cleartext(now int64, f *event.Flow, what string) {
	id, remote, d := f.ID, f.Remote.Addr(), dest(f)
	h.raiseFlow(now, f, func(p procRef) event.Alert {
		return event.Alert{
			Key: fmt.Sprintf("cleartext:%s:%s", remote, what), Kind: "cleartext", Score: 78,
			Flow: id, Proc: p.id, Remote: remote,
			Title:    "Password sent in clear text",
			Detail:   fmt.Sprintf("%s → %s: %s — anyone on the path can read it", who(p.name, p.pid), d, what),
			Evidence: map[string]any{"method": what},
		}
	})
}

// Miner implements event.Observer.
func (h *Hub) Miner(now int64, f *event.Flow) {
	id, remote, d := f.ID, f.Remote, dest(f)
	h.raiseFlow(now, f, func(p procRef) event.Alert {
		return event.Alert{
			Key: "miner:" + remote.String(), Kind: "miner", Score: 86, Flow: id, Proc: p.id, Remote: remote.Addr(),
			Title:    "Cryptocurrency miner detected",
			Detail:   fmt.Sprintf("%s → %s speaks the Stratum mining protocol", who(p.name, p.pid), d),
			Evidence: map[string]any{"pool": remote.String()},
		}
	})
}

// Volume implements event.Observer.
func (h *Hub) Volume(now int64, f *event.Flow) {
	if al, ok := h.exfil.observe(f); ok {
		h.raise(now, al)
	}
}

// Tick implements event.Observer.
func (h *Hub) Tick(now int64) {
	for _, a := range h.beacon.evaluate(now) {
		h.raise(now, a)
	}
	for _, a := range h.dns.evaluate(now) {
		h.raise(now, a)
	}
	for _, a := range h.scan.evaluate(now) {
		h.raise(now, a)
	}
	if h.sink != nil {
		h.sink.SetDefcon(h.defcon(now))
	}
}

func (h *Hub) procOf(f *event.Flow) procRef {
	if f.ProcName != "" {
		return procRef{f.Proc, f.ProcName, f.PID}
	}
	return h.flowProcs[f.ID]
}

func (h *Hub) checkIntelIP(now int64, f *event.Flow) {
	if h.intel == nil || f.Scope != "public" {
		return
	}
	hit, ok := h.intel.MatchIP(f.Remote.Addr())
	if !ok {
		return
	}
	a := event.Alert{
		Key: "intel:" + f.Remote.Addr().String(), Kind: "intel", Flow: f.ID, Proc: f.Proc, Remote: f.Remote.Addr(),
		Evidence: map[string]any{"feed": hit.Source, "ip": f.Remote.Addr().String()},
	}
	switch hit.Kind {
	case intel.KindC2:
		a.Score, a.Title = 95, "Connection to a known botnet command server"
	case intel.KindHijack:
		a.Score, a.Title = 82, "Connection into a hijacked network block"
	case intel.KindMalware:
		a.Score, a.Title = 85, "Connection to a malware distribution host"
	case intel.KindTor:
		a.Kind, a.Score, a.Title = "tor", 42, "Connection to a Tor exit relay"
	}
	if !f.Out {
		a.Title = "Inbound connection from a listed host"
		a.Score = max(a.Score-15, 30)
	}
	a.Detail = fmt.Sprintf("%s ↔ %s — listed by %s", who(f.ProcName, f.PID), dest(f), hit.Source)
	h.raise(now, a)
}

// suspiciousPorts are remote ports with a reputation.
var suspiciousPorts = map[uint16]string{
	4444: "Metasploit's default handler", 31337: "the classic \"elite\" backdoor port", 1337: "a backdoor favorite",
	6667: "IRC, a botnet command channel of old", 6697: "IRC over TLS", 5555: "Android Debug Bridge",
	2323: "Mirai's alternate Telnet", 23: "Telnet: an unencrypted remote shell", 9050: "a Tor SOCKS proxy",
	3333: "Stratum mining pools", 14444: "Monero mining pools", 45700: "Monero mining pools",
}

func (h *Hub) checkPort(now int64, f *event.Flow) {
	if !f.Out {
		return
	}
	why, ok := suspiciousPorts[f.Remote.Port()]
	if !ok {
		return
	}
	key := fmt.Sprintf("port:%s", f.Remote)
	if h.portSeen[key] {
		return
	}
	h.portSeen[key] = true
	id, remote, d := f.ID, f.Remote, dest(f)
	h.raiseFlow(now, f, func(p procRef) event.Alert {
		return event.Alert{
			Key: key, Kind: "port", Score: 30, Flow: id, Proc: p.id, Remote: remote.Addr(),
			Title:    fmt.Sprintf("Outbound connection to port %d", remote.Port()),
			Detail:   fmt.Sprintf("%s → %s: port %d is %s", who(p.name, p.pid), d, remote.Port(), why),
			Evidence: map[string]any{"port": remote.Port()},
		}
	})
}

// defcon folds recent alerts, decayed over a few minutes, into the
// 5 (calm) … 1 (critical) threat level.
func (h *Hub) defcon(now int64) int {
	const tau = 240e9
	weights := [...]float64{0, 0.3, 0.6, 1, 1.5}
	var s float64
	critical := false
	kept := h.recent[:0]
	for _, r := range h.recent {
		age := float64(now - r.ts)
		if age > 20*60e9 {
			continue
		}
		kept = append(kept, r)
		s += float64(r.score) * weights[r.sev] * math.Exp(-age/tau)
		if r.sev == event.Critical && age < 90e9 {
			critical = true
		}
	}
	h.recent = kept
	level := 5
	switch {
	case s >= 260:
		level = 1
	case s >= 140:
		level = 2
	case s >= 70:
		level = 3
	case s >= 30:
		level = 4
	}
	if critical {
		level = min(level, 2)
	}
	return level
}

func human(b uint64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(b)/(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(b)/(1<<20))
	case b >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(b)/(1<<10))
	}
	return fmt.Sprintf("%d B", b)
}

func dur(ns int64) string {
	s := float64(ns) / 1e9
	switch {
	case s >= 3600:
		return fmt.Sprintf("%.1f h", s/3600)
	case s >= 60:
		return fmt.Sprintf("%.1f min", s/60)
	}
	return fmt.Sprintf("%.1f s", s)
}

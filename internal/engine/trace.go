package engine

import (
	"net/netip"
	"slices"
	"time"

	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/geo"
	"github.com/SharvikS/telluric/internal/wire"
)

// Traceroute reconstruction. traceroute, mtr and tracepath send probes with
// small TTLs; each router where a probe's TTL runs out answers with an ICMP
// "time exceeded" that quotes the start of the probe. Matching the quote
// to the probe we saw leave gives the hop number (the probe's TTL) and the
// router's address — so a traceroute typed in a terminal draws its path,
// hop by hop, across the globe.

type probeKey struct {
	dst   netip.Addr
	proto uint8
	a, b  uint16 // UDP/TCP source and destination ports, or ICMP echo id and sequence
}

type probe struct {
	ttl uint8
	ts  int64
}

type traceHop struct {
	ip      netip.Addr
	rtt     float64 // ms
	loc     geo.Location
	located bool
	scope   string
}

type tracePath struct {
	id      uint32
	dst     netip.Addr
	hops    map[uint8]*traceHop
	reached uint8 // hop at which the destination itself answered
	last    int64
	dirty   bool
}

type tracer struct {
	probes map[probeKey]probe
	paths  map[netip.Addr]*tracePath
	next   uint32
}

const (
	maxProbeTTL   = 32
	maxProbes     = 8192
	probeLifetime = int64(10 * time.Second)
	traceLifetime = int64(90 * time.Second)
)

func newTracer() tracer {
	return tracer{probes: map[probeKey]probe{}, paths: map[netip.Addr]*tracePath{}}
}

func probeKeyOf(p *decode.Packet) (probeKey, bool) {
	k := probeKey{dst: p.Dst, proto: p.Proto}
	switch {
	case p.Has(decode.LayerUDP) || p.Has(decode.LayerTCP):
		k.a, k.b = p.SrcPort, p.DstPort
	case p.Has(decode.LayerICMP) && (p.ICMPType == 8 || p.ICMPType == 128):
		k.a, k.b = p.ICMPEchoID, p.ICMPEchoSeq
	default:
		return k, false
	}
	return k, true
}

// traceOut records an outgoing packet if it looks like a probe.
func (e *Engine) traceOut(p *decode.Packet) {
	if p.TTL == 0 || p.TTL > maxProbeTTL || len(e.trace.probes) >= maxProbes {
		return
	}
	if k, ok := probeKeyOf(p); ok {
		e.trace.probes[k] = probe{ttl: p.TTL, ts: e.pktTS}
	}
}

// traceIn matches ICMP errors and echo replies to recorded probes.
func (e *Engine) traceIn(p *decode.Packet) {
	if len(e.trace.probes) == 0 || !p.Has(decode.LayerICMP) {
		return
	}
	v6 := p.Proto == decode.ProtoICMPv6
	var k probeKey
	var router netip.Addr
	final := false
	switch {
	case p.ICMP.Valid && (!v6 && (p.ICMPType == 11 || p.ICMPType == 3) || v6 && (p.ICMPType == 3 || p.ICMPType == 1)):
		in := p.ICMP
		k = probeKey{dst: in.Dst, proto: in.Proto, a: in.SrcPort, b: in.DstPort}
		if in.Proto == decode.ProtoICMP || in.Proto == decode.ProtoICMPv6 {
			k.a, k.b = in.EchoID, in.EchoSeq
		}
		router = p.Src
		// Unreachable from the target itself means the probe arrived.
		final = (!v6 && p.ICMPType == 3 || v6 && p.ICMPType == 1) && p.Src == in.Dst
	case !v6 && p.ICMPType == 0 || v6 && p.ICMPType == 129:
		k = probeKey{dst: p.Src, proto: p.Proto, a: p.ICMPEchoID, b: p.ICMPEchoSeq}
		if v6 {
			k.proto = decode.ProtoICMPv6
		} else {
			k.proto = decode.ProtoICMP
		}
		router, final = p.Src, true
	default:
		return
	}
	pr, ok := e.trace.probes[k]
	if !ok {
		return
	}
	delete(e.trace.probes, k)
	path := e.trace.paths[k.dst]
	if path == nil {
		e.trace.next++
		path = &tracePath{id: e.trace.next, dst: k.dst, hops: map[uint8]*traceHop{}}
		e.trace.paths[k.dst] = path
	}
	path.last, path.dirty = e.now, true
	rtt := float64(e.pktTS-pr.ts) / 1e6
	if h := path.hops[pr.ttl]; h != nil && h.ip == router {
		h.rtt = min(h.rtt, rtt) // keep the best of repeated probes (mtr)
	} else {
		h := &traceHop{ip: router, rtt: rtt, scope: scopeOf(router, e.local.has(router))}
		if h.scope == "public" && e.cfg.Locator != nil {
			h.loc, h.located = e.cfg.Locator.Locate(router)
		}
		path.hops[pr.ttl] = h
	}
	if final && (path.reached == 0 || pr.ttl < path.reached) {
		path.reached = pr.ttl
	}
}

func (e *Engine) wireTrace(t *tracePath) wire.Trace {
	w := wire.Trace{ID: t.id, Dst: t.dst.String(), TS: t.last / 1e6, Done: t.reached > 0, Hops: []wire.Hop{}}
	if names := e.pdns.names(t.dst); len(names) > 0 {
		w.Name = names[0]
	}
	ttls := make([]uint8, 0, len(t.hops))
	for ttl := range t.hops {
		if t.reached == 0 || ttl <= t.reached {
			ttls = append(ttls, ttl)
		}
	}
	slices.Sort(ttls)
	for _, ttl := range ttls {
		h := t.hops[ttl]
		hop := wire.Hop{N: int(ttl), IP: h.ip.String(), RTT: round(h.rtt, 2), Scope: h.scope}
		if h.located && h.loc.HasCoord {
			hop.Lat, hop.Lon = wire.Float(round(h.loc.Lat, 4)), wire.Float(round(h.loc.Lon, 4))
			hop.City, hop.CC, hop.ASN, hop.Org = h.loc.City, h.loc.CC, h.loc.ASN, h.loc.Org
		}
		if names := e.pdns.names(h.ip); len(names) > 0 {
			hop.Name = names[0]
		}
		w.Hops = append(w.Hops, hop)
	}
	return w
}

// flushTraces sends changed paths and expires stale probes and paths.
func (e *Engine) flushTraces() {
	var items []wire.Trace
	for dst, t := range e.trace.paths {
		if t.dirty {
			t.dirty = false
			items = append(items, e.wireTrace(t))
		}
		if e.now-t.last > traceLifetime {
			delete(e.trace.paths, dst)
			e.gone.Traces = append(e.gone.Traces, t.id)
		}
	}
	if len(items) > 0 {
		e.broadcast(wire.EncodeTraces(items), true, false)
	}
	for k, pr := range e.trace.probes {
		if e.now-pr.ts > probeLifetime {
			delete(e.trace.probes, k)
		}
	}
}

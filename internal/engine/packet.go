package engine

import (
	"net/netip"

	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/procmap"
)

// maxFlows bounds the flow table; past it, new flows are not tracked (a
// scan or flood must not exhaust memory).
const maxFlows = 200_000

// handleFrame is the hot path: called for every captured frame.
func (e *Engine) handleFrame(f *capture.Frame) {
	e.frames.Add(1)
	e.pktTS = f.TS
	if f.TS > e.now {
		e.now = f.TS
	}
	if f.PktType == capture.PacketOtherHost {
		return // someone else's traffic (promiscuous capture)
	}
	// Container bridges and veth pairs carry traffic twice (before and after
	// NAT). Interface indexes only mean something for live capture: a
	// replay's indexes belong to the machine that recorded it.
	if e.cfg.Mode == "live" && ignoredIface(e.ifnames[f.Ifindex]) {
		return
	}
	p := &e.pkt
	if err := p.Decode(f.Proto, f.Data); err != nil {
		return
	}
	if p.Has(decode.LayerARP) {
		if e.cfg.Observer != nil {
			e.cfg.Observer.ARP(e.now, &p.ARP, f)
		}
		return
	}
	if !p.Has(decode.LayerIP) {
		return
	}
	if f.HAType == capture.ARPHRDLoopback || p.Src.IsLoopback() || p.Dst.IsLoopback() {
		// Only the stub resolver's DNS is interesting on loopback: it feeds
		// passive DNS but never becomes a flow on the globe.
		if (isDNSPort(p.SrcPort) || isDNSPort(p.DstPort)) && len(p.Payload) > 0 {
			e.handleDNS(nil, p, false)
		}
		return
	}

	out := e.outbound(f, p)
	var key flowKey
	key.proto = p.Proto
	if out {
		key.local = netip.AddrPortFrom(p.Src, p.SrcPort)
		key.remote = netip.AddrPortFrom(p.Dst, p.DstPort)
	} else {
		key.local = netip.AddrPortFrom(p.Dst, p.DstPort)
		key.remote = netip.AddrPortFrom(p.Src, p.SrcPort)
	}
	if p.Proto == decode.ProtoICMP || p.Proto == decode.ProtoICMPv6 {
		key.local = netip.AddrPortFrom(key.local.Addr(), 0)
		key.remote = netip.AddrPortFrom(key.remote.Addr(), 0)
	}

	size := uint64(f.WireLen)
	fl := e.flows[key]
	if fl == nil {
		if len(e.flows) >= maxFlows {
			return
		}
		fl = e.newFlow(key, p, out)
	}
	fl.last = max(fl.last, e.pktTS)
	ep := fl.ep
	ep.last = max(ep.last, e.pktTS)
	if out {
		fl.bytesOut += size
		fl.pktsOut++
		fl.accOut += size
		ep.bytesOut += size
		ep.accOut += size
		e.stats.txAcc += size
		e.stats.totals.TX += size
	} else {
		fl.bytesIn += size
		fl.pktsIn++
		fl.accIn += size
		ep.bytesIn += size
		ep.accIn += size
		e.stats.rxAcc += size
		e.stats.totals.RX += size
	}
	e.stats.totals.Pkts++
	e.stats.pktAcc++
	if pr := fl.proc; pr != nil {
		pr.last = e.now
		if out {
			pr.bytesOut += size
			pr.accOut += size
		} else {
			pr.bytesIn += size
			pr.accIn += size
		}
	}
	e.stats.appAcc(fl.app, size)

	if p.Has(decode.LayerTCP) {
		e.trackTCP(fl, p, out)
	}
	if len(p.Payload) > 0 {
		e.inspect(fl, p, out)
	}
	e.shots.add(fl, uint32(min(size, 1<<32-1)), !out, e.pktTS)
}

func isDNSPort(p uint16) bool { return p == 53 || p == 5353 || p == 5355 }

func ignoredIface(name string) bool {
	for _, pfx := range []string{"docker", "br-", "veth", "virbr", "vnet", "cni", "flannel", "cali"} {
		if len(name) >= len(pfx) && name[:len(pfx)] == pfx {
			return true
		}
	}
	return false
}

// outbound decides whether this machine sent the packet. Live captures say
// so exactly (the packet type); replays of plain Ethernet captures fall back
// to known local addresses and then to heuristics.
func (e *Engine) outbound(f *capture.Frame, p *decode.Packet) bool {
	switch f.PktType {
	case capture.PacketOutgoing:
		e.local.learn(p.Src)
		return true
	case capture.PacketHost, capture.PacketBroadcast, capture.PacketMulticast:
		return false
	}
	switch {
	case e.local.has(p.Src):
		return true
	case e.local.has(p.Dst):
		return false
	}
	sPriv, dPriv := private(p.Src), private(p.Dst)
	switch {
	case sPriv && !dPriv:
		return true
	case dPriv && !sPriv:
		return false
	}
	// Same class on both sides: the ephemeral port is the client, and we
	// treat the client as "this machine".
	return p.SrcPort > p.DstPort
}

func private(a netip.Addr) bool {
	return a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() || cgnat.Contains(a)
}

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

func scopeOf(a netip.Addr, local bool) string {
	switch {
	case local || a.IsLoopback():
		return "local"
	case a.IsMulticast() || a == netip.AddrFrom4([4]byte{255, 255, 255, 255}):
		return "multicast"
	case private(a) || a.IsUnspecified():
		return "lan"
	}
	return "public"
}

func (e *Engine) newFlow(key flowKey, p *decode.Packet, out bool) *flow {
	e.nextFlow++
	fl := &flow{
		id:      e.nextFlow,
		key:     key,
		out:     out,
		first:   e.pktTS,
		last:    e.pktTS,
		dirty:   true,
		app:     classifyPorts(key.proto, key.local.Port(), key.remote.Port()),
		shotIdx: [2]int32{-1, -1},
	}
	if key.proto == decode.ProtoTCP {
		// Mid-stream flows: whoever uses the well-known port is the server.
		if p.Flags&decode.SYN == 0 {
			fl.out = serverPort(key.remote.Port(), key.local.Port())
		}
	} else if key.proto == decode.ProtoUDP && !out && serverPort(key.remote.Port(), key.local.Port()) {
		fl.out = true // a response arriving first: we were still the client
	}
	ep := e.endpoint(key.remote.Addr())
	fl.ep = ep
	ep.flows++
	ep.idleSince = 0
	if dohResolvers[key.remote.Addr()] && key.remote.Port() == 443 {
		fl.app = AppDoH
	}
	if key.proto == decode.ProtoTCP || key.proto == decode.ProtoUDP {
		fl.procNext = e.now // attribute as soon as the next sweep runs
	}
	e.flows[key] = fl
	if e.cfg.Observer != nil {
		e.cfg.Observer.FlowStart(e.now, e.view(fl))
	}
	return fl
}

// serverPort reports whether remote looks like the server side of a
// conversation with local.
func serverPort(remote, local uint16) bool {
	if _, ok := wellKnownPorts[remote]; ok {
		return true
	}
	if _, ok := wellKnownPorts[local]; ok && local < 1024 {
		return false
	}
	return remote < local
}

func (e *Engine) endpoint(ip netip.Addr) *endpoint {
	if ep := e.eps[ip]; ep != nil {
		return ep
	}
	e.nextEP++
	ep := &endpoint{id: e.nextEP, ip: ip, first: e.pktTS, last: e.pktTS, dirty: true}
	ep.scope = scopeOf(ip, e.local.has(ip))
	e.locate(ep)
	if names := e.pdns.names(ip); len(names) > 0 {
		ep.names = names
		e.setName(ep, names[0], nameDNS)
	}
	e.eps[ip] = ep
	return ep
}

func (e *Engine) locate(ep *endpoint) {
	if ep.scope != "public" || e.cfg.Locator == nil {
		return
	}
	if loc, ok := e.cfg.Locator.Locate(ep.ip); ok {
		ep.loc, ep.located = loc, true
		if ep.svc == "" {
			ep.svc = serviceForOrg(loc.Org)
		}
		if ep.nameSrc < nameOrg && loc.Org != "" {
			ep.name, ep.nameSrc = loc.Org, nameOrg
		}
	}
}

func (e *Engine) relocateAll() {
	for _, ep := range e.eps {
		if !ep.located {
			e.locate(ep)
			if ep.located {
				ep.dirty = true
			}
		}
	}
}

// setName offers a name for an endpoint; better sources win.
func (e *Engine) setName(ep *endpoint, name string, src nameSource) {
	if name == "" || src < ep.nameSrc || (src == ep.nameSrc && name == ep.name) {
		return
	}
	ep.name, ep.nameSrc = name, src
	if svc := serviceForName(name); svc != "" {
		ep.svc = svc
	}
	ep.dirty = true
}

// trackTCP runs the connection state machine and measures handshake RTT.
func (e *Engine) trackTCP(fl *flow, p *decode.Packet, out bool) {
	fromClient := out == fl.out
	switch {
	case p.Flags&decode.RST != 0:
		if fl.state != tcpRst && fl.state != tcpClosed {
			fl.state, fl.dirty = tcpRst, true
			e.flowEnded(fl)
		}
	case p.Flags&decode.SYN != 0 && p.Flags&decode.ACK == 0:
		if fl.synTS != 0 {
			fl.synRetrans = true // Karn: no RTT sample from a retransmitted SYN
		}
		fl.synTS = e.pktTS
		if fl.state == tcpNone {
			fl.state, fl.out, fl.dirty = tcpSyn, out, true
		}
		fl.isn, fl.haveISN = p.Seq, true
	case p.Flags&decode.SYN != 0: // SYN/ACK
		if fl.state == tcpNone {
			fl.state, fl.out, fl.dirty = tcpSyn, !out, true
		}
		if !fl.haveISN {
			fl.isn, fl.haveISN = p.Ack-1, true
		}
		if fl.synTS != 0 && fl.synackTS == 0 && !fl.synRetrans && fl.out {
			fl.rtt = float64(e.pktTS-fl.synTS) / 1e6
			fl.dirty = true
		}
		fl.synackTS = e.pktTS
	case p.Flags&decode.FIN != 0:
		if out {
			fl.finOut = true
		} else {
			fl.finIn = true
		}
		if fl.state != tcpFin {
			fl.state, fl.dirty = tcpFin, true
		}
	default:
		if fl.state == tcpSyn || fl.state == tcpNone {
			// Inbound connection: SYN/ACK (ours) → ACK (theirs) is the RTT.
			if fl.state == tcpSyn && !fl.out && fromClient && fl.synackTS != 0 && fl.rtt == 0 {
				fl.rtt = float64(e.pktTS-fl.synackTS) / 1e6
			}
			fl.state, fl.dirty = tcpEst, true
		}
		if fl.state == tcpFin && fl.finIn && fl.finOut {
			fl.state, fl.dirty = tcpClosed, true
			e.flowEnded(fl)
		}
	}
}

func (e *Engine) flowEnded(fl *flow) {
	if e.cfg.Observer != nil {
		e.cfg.Observer.FlowEnd(e.now, e.view(fl))
	}
}

// inspect looks at payloads: DNS always, and the first client payloads of
// a flow for application identification, ClientHellos and cleartext secrets.
func (e *Engine) inspect(fl *flow, p *decode.Packet, out bool) {
	payload := p.Payload
	if isDNSPort(fl.key.remote.Port()) || isDNSPort(fl.key.local.Port()) {
		e.handleDNS(fl, p, out)
		return
	}
	fromClient := out == fl.out
	// QUIC handshake RTT: the client's first Initial to the server's first
	// long-header reply.
	if fl.app == AppQUIC && fl.rtt == 0 && len(payload) > 0 && payload[0]&0x80 != 0 {
		switch {
		case fromClient && fl.synTS == 0:
			fl.synTS = e.pktTS
		case !fromClient && fl.synTS != 0:
			fl.rtt, fl.dirty = float64(e.pktTS-fl.synTS)/1e6, true
		}
	}
	if !fromClient || fl.payloads >= 8 {
		if fl.hello != nil && fl.payloads >= 8 {
			e.releaseHello(fl)
		}
		return
	}
	fl.payloads++

	if fl.payloads <= 2 {
		if a := classifyPayload(fl.key.proto, payload); a != AppUnknown && a != fl.app {
			if !(fl.app == AppDoH && (a == AppTLS || a == AppQUIC)) {
				fl.app, fl.dirty = a, true
			}
		}
	}
	switch fl.app {
	case AppTLS, AppDoH, AppQUIC:
		if fl.sni == "" && fl.ja4 == "" {
			e.feedHello(fl, p)
		}
	case AppHTTP:
		if fl.httpHost == "" {
			if req, ok := decode.ParseHTTPRequest(payload); ok && req.Host != nil {
				fl.httpHost = string(req.Host)
				e.setName(fl.ep, stripPort(fl.httpHost), nameHTTP)
				fl.dirty = true
				if req.BasicAuth && e.cfg.Observer != nil {
					e.cfg.Observer.Cleartext(e.now, e.view(fl), "HTTP Basic authentication")
				}
			}
		}
	}
	if e.cfg.Observer != nil {
		if decode.CleartextLogin(fl.key.remote.Port(), payload) {
			e.cfg.Observer.Cleartext(e.now, e.view(fl), "plaintext "+fl.app.String()+" login")
		}
		if fl.key.proto == decode.ProtoTCP && decode.IsStratum(payload) {
			e.cfg.Observer.Miner(e.now, e.view(fl))
		}
	}
}

func stripPort(host string) string {
	if h, _, ok := cutLast(host, ':'); ok && h != "" && host[len(host)-1] != ']' {
		return h
	}
	return host
}

func cutLast(s string, c byte) (string, string, bool) {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == c {
			return s[:i], s[i+1:], true
		}
	}
	return s, "", false
}

// requestProcs sends unattributed flows to the attribution worker.
func (e *Engine) requestProcs() {
	if e.cfg.Procs == nil || e.procPending {
		return
	}
	var socks []procmap.Socket
	for _, fl := range e.flows {
		if fl.proc != nil || fl.procTries >= 4 || fl.procNext == 0 || fl.procNext > e.now {
			continue
		}
		if fl.key.proto != decode.ProtoTCP && fl.key.proto != decode.ProtoUDP {
			continue
		}
		fl.procTries++
		fl.procNext = e.now + int64(fl.procTries)*int64(rateEvery)
		socks = append(socks, procmap.Socket{Proto: fl.key.proto, Local: fl.key.local, Remote: fl.key.remote})
		if len(socks) == 512 {
			break
		}
	}
	socks = append(socks, e.extraSocks...)
	if len(socks) > 0 && e.cfg.Procs.Submit(socks) {
		e.procPending = true
		e.extraSocks = e.extraSocks[:0]
	}
}

// procFor returns the process entity for info, creating it if needed.
func (e *Engine) procFor(info *procmap.Process) *proc {
	pr := e.procs[info.Key]
	if pr == nil {
		e.nextProc++
		pr = &proc{id: e.nextProc, key: info.Key, info: *info, first: e.now, last: e.now, dirty: true, idleSince: e.now}
		e.procs[info.Key] = pr
	}
	return pr
}

func (e *Engine) applyProcs(r procmap.WorkerResult) {
	e.procPending = false
	for i, info := range r.Procs {
		if info == nil {
			continue
		}
		s := r.Sockets[i]
		fl := e.flows[flowKey{proto: s.Proto, local: s.Local, remote: s.Remote}]
		if fl == nil {
			e.attributeHeldDNS(s, info)
			continue
		}
		if fl.proc != nil {
			continue
		}
		pr := e.procFor(info)
		fl.proc = pr
		pr.flows++
		pr.idleSince = 0
		pr.bytesIn += fl.bytesIn
		pr.bytesOut += fl.bytesOut
		fl.dirty, pr.dirty = true, true
		if e.cfg.Observer != nil {
			e.cfg.Observer.FlowUpdate(e.now, e.view(fl))
		}
	}
}

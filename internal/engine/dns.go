package engine

import (
	"net/netip"
	"time"

	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/event"
	"github.com/SharvikS/telluric/internal/wire"
)

// passiveDNS remembers which names resolved to which addresses, learned by
// watching DNS responses go by.
type passiveDNS struct {
	byIP    map[netip.Addr]*pdnsEntry
	pending map[dnsTx]int64 // outstanding queries → time sent
	recent  map[string]int64
}

type pdnsEntry struct {
	names []string // most recent first
	seen  int64
}

type dnsTx struct {
	client netip.AddrPort
	server netip.AddrPort
	id     uint16
}

const (
	maxPDNS       = 100_000
	maxPending    = 8192
	maxDNSLog     = 64
	pdnsLifetime  = int64(6 * time.Hour)
	dnsDedupe     = int64(2 * time.Second)
	queryLifetime = int64(10 * time.Second)
)

func newPassiveDNS() passiveDNS {
	return passiveDNS{byIP: map[netip.Addr]*pdnsEntry{}, pending: map[dnsTx]int64{}, recent: map[string]int64{}}
}

func (d *passiveDNS) add(ip netip.Addr, name string, now int64) bool {
	ent := d.byIP[ip]
	if ent == nil {
		if len(d.byIP) >= maxPDNS {
			n := 0
			for k := range d.byIP { // map order is random: evict a random tenth
				delete(d.byIP, k)
				if n++; n > maxPDNS/10 {
					break
				}
			}
		}
		ent = &pdnsEntry{}
		d.byIP[ip] = ent
	}
	ent.seen = now
	if len(ent.names) > 0 && ent.names[0] == name {
		return false
	}
	for i, n := range ent.names {
		if n == name {
			copy(ent.names[1:i+1], ent.names[:i])
			ent.names[0] = name
			return true
		}
	}
	ent.names = append([]string{name}, ent.names[:min(len(ent.names), 3)]...)
	return true
}

func (d *passiveDNS) names(ip netip.Addr) []string {
	if ent := d.byIP[ip]; ent != nil {
		return ent.names
	}
	return nil
}

func (d *passiveDNS) sweep(now int64) {
	for k, t := range d.pending {
		if now-t > queryLifetime {
			delete(d.pending, k)
		}
	}
	for k, t := range d.recent {
		if now-t > dnsDedupe {
			delete(d.recent, k)
		}
	}
	for k, ent := range d.byIP {
		if now-ent.seen > pdnsLifetime {
			delete(d.byIP, k)
		}
	}
}

// handleDNS processes a DNS packet; fl is nil for loopback (stub resolver)
// traffic, which feeds passive DNS without creating a flow.
func (e *Engine) handleDNS(fl *flow, p *decode.Packet, _ bool) {
	m := &e.dnsm
	var err error
	if p.Proto == decode.ProtoTCP {
		err = m.ParseTCP(p.Payload)
	} else {
		err = m.Parse(p.Payload)
	}
	if err != nil || len(m.Questions) == 0 || m.Opcode != 0 {
		return
	}
	src := netip.AddrPortFrom(p.Src, p.SrcPort)
	dst := netip.AddrPortFrom(p.Dst, p.DstPort)
	if !m.Response {
		if len(e.pdns.pending) < maxPending {
			e.pdns.pending[dnsTx{src, dst, m.ID}] = e.pktTS
		}
		return
	}
	mdns := p.SrcPort == 5353 || p.DstPort == 5353
	tx := dnsTx{dst, src, m.ID}
	var ms *float64
	if t0, ok := e.pdns.pending[tx]; ok {
		ms = wire.Float(round(float64(e.pktTS-t0)/1e6, 2))
		delete(e.pdns.pending, tx)
	}

	q := m.Questions[0]
	qname := string(q.Name)
	var answers []netip.Addr
	var cnames []string
	for i := range m.Answers {
		rr := &m.Answers[i]
		switch {
		case rr.Addr.IsValid():
			answers = append(answers, rr.Addr)
		case rr.Type == decode.DNSTypeCNAME && len(rr.Target) > 0:
			cnames = append(cnames, string(rr.Target))
		}
		for _, h := range rr.Hints[:rr.NHints] {
			answers = append(answers, h)
		}
	}
	var eps []uint32
	answerStrs := make([]string, 0, len(answers))
	for _, a := range answers {
		answerStrs = append(answerStrs, a.String())
		if e.pdns.add(a, qname, e.now) {
			if ep := e.eps[a]; ep != nil {
				ep.names = e.pdns.names(a)
				e.setName(ep, qname, nameDNS)
				ep.dirty = true
			}
		}
		if ep := e.eps[a]; ep != nil {
			eps = append(eps, ep.id)
		}
	}

	if mdns {
		return // local service discovery: names learned, but not worth a label
	}

	// The stub resolver and its upstream query both show up; report a name
	// once per couple of seconds.
	dk := qname + "/" + decode.DNSTypeName(q.Type)
	if t, ok := e.pdns.recent[dk]; ok && e.now-t < dnsDedupe {
		return
	}
	e.pdns.recent[dk] = e.now

	var procID uint32
	var procName string
	if fl != nil && fl.proc != nil {
		procID, procName = fl.proc.id, fl.proc.info.Name
	}
	ev := wire.DNSEvent{
		TS:      e.now / 1e6,
		Q:       qname,
		QType:   decode.DNSTypeName(q.Type),
		Rcode:   decode.DNSRcodeName(m.Rcode),
		Answers: answerStrs,
		CNAME:   cnames,
		EPs:     eps,
		Server:  src.Addr().String(),
		MS:      ms,
		Proc:    procID,
	}
	if ev.EPs == nil {
		ev.EPs = []uint32{}
	}
	e.dnsOut = append(e.dnsOut, ev)
	e.dnsLog = append(e.dnsLog, ev)
	if len(e.dnsLog) > maxDNSLog {
		e.dnsLog = e.dnsLog[len(e.dnsLog)-maxDNSLog:]
	}
	if e.cfg.Observer != nil {
		e.cfg.Observer.DNS(e.now, &event.DNS{
			Client: dst, Server: src, Name: qname, QType: q.Type, Rcode: m.Rcode,
			Answers: answers, CNAMEs: cnames, Proc: procID, ProcName: procName,
		})
	}
}

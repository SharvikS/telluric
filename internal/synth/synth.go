package synth

import (
	"crypto/tls"
	"fmt"
	"math"
	"math/rand/v2"
	"net/netip"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/craft"
	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/procmap"
)

// pkt is one frame scheduled at an absolute time.
type pkt struct {
	at      int64
	out     bool
	et      uint16
	data    []byte
	wire    uint32 // on-the-wire length; 0 means len(data)
	pktType uint8  // override (multicast/broadcast); 0xff = derive from out
}

type session struct {
	script []pkt
	gen    func(now int64, s *session) bool // emits into s.script; false when finished
}

// Source is a capture.Source producing the demo world's traffic in real time.
type Source struct {
	mu       sync.Mutex
	rng      *rand.Rand
	sessions []*session
	start    int64
	last     int64
	port     uint16
	hellos   map[string][]byte
	qhellos  map[string][]byte
	attrib   *Attributor
	out      []pkt
	frames   []capture.Frame
	closed   atomic.Bool
	received atomic.Uint64

	nextBrowse, nextBackground, nextIncident int64
	incident                                 int
	beaconRunning                            bool
}

// New returns a demo source; the same seed replays the same world.
func New(seed uint64) *Source {
	s := &Source{
		rng:     rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15)),
		port:    40000,
		hellos:  map[string][]byte{},
		qhellos: map[string][]byte{},
		attrib:  newAttributor(),
	}
	return s
}

// Name implements capture.Source.
func (s *Source) Name() string { return "demo" }

// Stats implements capture.Source.
func (s *Source) Stats() capture.Stats { return capture.Stats{Received: s.received.Load()} }

// Close implements capture.Source.
func (s *Source) Close() error { s.closed.Store(true); return nil }

// Attributor returns the demo world's process attribution.
func (s *Source) Attributor() *Attributor { return s.attrib }

// Read implements capture.Source: it generates everything due up to now.
func (s *Source) Read(timeout time.Duration, fn func(*capture.Frame)) error {
	if s.closed.Load() {
		return capture.ErrClosed
	}
	if timeout > 10*time.Millisecond {
		timeout = 10 * time.Millisecond
	}
	time.Sleep(timeout)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixNano()
	if s.start == 0 {
		s.start = now
		s.boot(now)
	}
	s.direct(now)
	s.out = s.out[:0]
	kept := s.sessions[:0]
	for _, ss := range s.sessions {
		if ss.gen != nil && !ss.gen(now, ss) {
			ss.gen = nil
		}
		i := 0
		for i < len(ss.script) && ss.script[i].at <= now {
			s.out = append(s.out, ss.script[i])
			i++
		}
		ss.script = ss.script[i:]
		if len(ss.script) > 0 || ss.gen != nil {
			kept = append(kept, ss)
		}
	}
	clear(s.sessions[len(kept):])
	s.sessions = kept
	slices.SortStableFunc(s.out, func(a, b pkt) int { return int(a.at - b.at) })
	for _, p := range s.out {
		f := capture.Frame{TS: p.at, Proto: p.et, HAType: capture.ARPHRDEther, HALen: 6, Data: p.data, WireLen: p.wire}
		if f.WireLen == 0 {
			f.WireLen = uint32(len(p.data))
		}
		switch {
		case p.pktType != 0xff:
			f.PktType = p.pktType
		case p.out:
			f.PktType = capture.PacketOutgoing
			copy(f.HAddr[:], myMAC[:])
		default:
			f.PktType = capture.PacketHost
			copy(f.HAddr[:], routerMAC[:])
		}
		fn(&f)
	}
	s.received.Add(uint64(len(s.out)))
	s.last = now
	return nil
}

func (s *Source) add(ss *session) { s.sessions = append(s.sessions, ss) }

func (s *Source) ephemeral() uint16 {
	s.port++
	if s.port > 60999 {
		s.port = 40000
	}
	return s.port
}

func (s *Source) jitter(base time.Duration, frac float64) int64 {
	return int64(float64(base) * (1 + frac*(2*s.rng.Float64()-1)))
}

// ---------------------------------------------------------------- building blocks

func etFor(a netip.Addr) uint16 {
	if a.Is4() {
		return decode.EtherTypeIPv4
	}
	return decode.EtherTypeIPv6
}

// rttTo estimates a round trip from Frankfurt to a place: light in fiber
// covers ~100 km per millisecond of RTT, plus routing overhead.
func rttTo(p place) int64 {
	const r = 6371.0
	la1, lo1 := Home.Lat*math.Pi/180, Home.Lon*math.Pi/180
	la2, lo2 := p.lat*math.Pi/180, p.lon*math.Pi/180
	h := math.Pow(math.Sin((la2-la1)/2), 2) + math.Cos(la1)*math.Cos(la2)*math.Pow(math.Sin((lo2-lo1)/2), 2)
	km := 2 * r * math.Asin(math.Sqrt(h))
	return int64((4 + km/100*1.15) * float64(time.Millisecond))
}

type tcpc struct {
	cli, srv    netip.AddrPort
	weAreClient bool
	cseq, sseq  uint32
}

func (t *tcpc) seg(fromClient bool, flags uint8, payload []byte, logical int, at int64) pkt {
	src, dst := t.cli, t.srv
	seq, ack := t.cseq, t.sseq
	if !fromClient {
		src, dst = t.srv, t.cli
		seq, ack = t.sseq, t.cseq
	}
	var opts []byte
	if flags&craft.SYN != 0 {
		opts = craft.SYNOptions(1460, 7)
		if fromClient {
			ack = 0
		}
	}
	if flags&craft.SYN == 0 || !fromClient {
		flags |= craft.ACK
	}
	data := craft.TCP{Src: src.Addr(), Dst: dst.Addr(), SrcPort: src.Port(), DstPort: dst.Port(),
		Seq: seq, Ack: ack, Flags: flags, Options: opts, Payload: payload}.Packet()
	adv := uint32(max(logical, len(payload)))
	if flags&(craft.SYN|craft.FIN) != 0 {
		adv++
	}
	if fromClient {
		t.cseq += adv
	} else {
		t.sseq += adv
	}
	p := pkt{at: at, out: fromClient == t.weAreClient, et: etFor(src.Addr()), data: data, pktType: 0xff}
	if logical > len(payload) {
		p.wire = uint32(len(data) + logical - len(payload))
	}
	return p
}

// burst sends n bytes from one side as MSS segments, coalescing big
// transfers into GRO-sized super-packets like a real NIC hands the capture
// ring, with ACKs flowing back. It returns the time the burst ends.
func (t *tcpc) burst(ss *session, fromClient bool, n int, at, rate int64) int64 {
	const mss = 1448
	segs := (n + mss - 1) / mss
	per := 1
	if segs > 24 {
		per = 16 // 23 KB super-packets
	}
	if rate <= 0 {
		rate = 12 << 20
	}
	for sent := 0; sent < n; {
		chunk := min(n-sent, per*mss)
		ss.script = append(ss.script, t.seg(fromClient, craft.PSH, make([]byte, min(chunk, 64)), chunk, at))
		sent += chunk
		at += int64(float64(chunk) / float64(rate) * 1e9)
		if (sent/mss)%2 == 0 || sent >= n {
			ss.script = append(ss.script, t.seg(!fromClient, 0, nil, 0, at+int64(200*time.Microsecond)))
		}
	}
	return at
}

func udpPkt(src, dst netip.AddrPort, payload []byte, at int64, out bool, wire int) pkt {
	data := craft.UDP{Src: src.Addr(), Dst: dst.Addr(), SrcPort: src.Port(), DstPort: dst.Port(), Payload: payload}.Packet()
	p := pkt{at: at, out: out, et: etFor(src.Addr()), data: data, pktType: 0xff}
	if wire > len(data) {
		p.wire = uint32(wire)
	}
	return p
}

func (s *Source) myAddr(remote netip.Addr) netip.Addr {
	if remote.Is6() {
		return me6
	}
	return me4
}

// lookup schedules the DNS transaction that precedes a connection.
func (s *Source) lookup(ss *session, sv *service, at int64) int64 {
	if sv.name == "" {
		return at
	}
	id := uint16(s.rng.Uint32())
	port := s.ephemeral()
	s.attrib.set(17, port, pResolved)
	qt := decode.DNSTypeA
	if sv.ip.Is6() {
		qt = decode.DNSTypeAAAA
	}
	var rrs []craft.RR
	owner := sv.name
	for _, c := range sv.cnames {
		rrs = append(rrs, craft.RR{Name: owner, Type: decode.DNSTypeCNAME, TTL: 300, Target: c})
		owner = c
	}
	rrs = append(rrs, craft.RR{Name: owner, Type: qt, TTL: 60, Addr: sv.ip})
	cli := netip.AddrPortFrom(me4, port)
	srv := netip.AddrPortFrom(router, 53)
	lat := s.jitter(14*time.Millisecond, 0.8)
	ss.script = append(ss.script,
		udpPkt(cli, srv, craft.DNSQuery(id, sv.name, qt), at, true, 0),
		udpPkt(srv, cli, craft.DNSResponse(id, sv.name, qt, 0, rrs...), at+lat, false, 0))
	return at + lat + int64(time.Millisecond)
}

func (s *Source) clientHello(sni string, alpn []string) []byte {
	key := sni + fmt.Sprint(alpn)
	if h, ok := s.hellos[key]; ok {
		return h
	}
	h, err := craft.TLSClientHello(&tls.Config{ServerName: sni, NextProtos: alpn})
	if err != nil {
		h = []byte{0x16, 3, 1, 0, 0}
	}
	s.hellos[key] = h
	return h
}

func (s *Source) quicInitial(sni string) []byte {
	hello, ok := s.qhellos[sni]
	if !ok {
		var err error
		if hello, err = craft.QUICClientHello(&tls.Config{ServerName: sni, NextProtos: []string{"h3"}}); err != nil {
			return nil
		}
		s.qhellos[sni] = hello
	}
	dcid := make([]byte, 8)
	for i := range dcid {
		dcid[i] = byte(s.rng.Uint32())
	}
	// Split and shuffle the CRYPTO frames the way Chrome does.
	cut := len(hello) / 2
	frames := append(craft.CryptoFrame(uint64(cut), hello[cut:]), 0x01)
	frames = append(frames, craft.CryptoFrame(0, hello[:cut])...)
	return craft.QUICInitial{DCID: dcid, SCID: dcid[:4], Frames: frames, PadTo: max(1250, len(hello)+120)}.Bytes()
}

// conn describes one connection to a service.
type conn struct {
	sv        *service
	p         *procmap.Process
	exchanges int     // request/response rounds
	resp      int     // typical response size
	bulkIn    int64   // bytes to download after the exchanges
	bulkOut   int64   // bytes to upload
	rate      float64 // bulk rate in bytes/s
	linger    time.Duration
	noDNS     bool
	cleartext []byte        // first client payload for non-TLS TCP
	every     time.Duration // heartbeat interval: a small exchange this often…
	life      time.Duration // …for this long, then close
}

// tcp schedules a whole TCP (optionally TLS) connection.
func (s *Source) tcp(c conn, at int64) {
	ss := &session{}
	if !c.noDNS {
		at = s.lookup(ss, c.sv, at)
	}
	lport := s.ephemeral()
	s.attrib.set(6, lport, c.p)
	rtt := s.jitter(time.Duration(rttTo(c.sv.at)), 0.08)
	t := &tcpc{
		cli:         netip.AddrPortFrom(s.myAddr(c.sv.ip), lport),
		srv:         netip.AddrPortFrom(c.sv.ip, c.sv.port),
		weAreClient: true,
		cseq:        s.rng.Uint32(), sseq: s.rng.Uint32(),
	}
	ss.script = append(ss.script,
		t.seg(true, craft.SYN, nil, 0, at),
		t.seg(false, craft.SYN, nil, 0, at+rtt),
		t.seg(true, 0, nil, 0, at+rtt+int64(100*time.Microsecond)))
	at += rtt + int64(200*time.Microsecond)
	tlsConn := c.cleartext == nil && c.sv.port != 22 && c.sv.port != 80 && c.sv.port != 3333
	switch {
	case tlsConn:
		hello := s.clientHello(c.sv.name, c.sv.alpn)
		for i, part := range craft.SplitSegments(hello, 1448) {
			ss.script = append(ss.script, t.seg(true, craft.PSH, part, 0, at+int64(i)*int64(20*time.Microsecond)))
		}
		at = t.burst(ss, false, 3200+s.rng.IntN(2400), at+rtt, 0) // ServerHello … Finished
	case c.sv.port == 22:
		ss.script = append(ss.script, t.seg(false, craft.PSH, []byte("SSH-2.0-babeld-f5e31a8b\r\n"), 0, at))
		ss.script = append(ss.script, t.seg(true, craft.PSH, []byte("SSH-2.0-OpenSSH_10.1\r\n"), 0, at+int64(time.Millisecond)))
		at += rtt * 3
	case c.cleartext != nil:
		ss.script = append(ss.script, t.seg(true, craft.PSH, c.cleartext, 0, at))
		at += rtt
	}
	for range c.exchanges {
		at += s.jitter(400*time.Millisecond, 0.9)
		ss.script = append(ss.script, t.seg(true, craft.PSH, make([]byte, 300+s.rng.IntN(900)), 0, at))
		at = t.burst(ss, false, max(200, int(float64(c.resp)*(0.3+1.4*s.rng.Float64()))), at+rtt, 0)
	}
	endBulk := func(at int64) {
		at += int64(c.linger)
		ss.script = append(ss.script,
			t.seg(true, craft.FIN, nil, 0, at),
			t.seg(false, craft.FIN, nil, 0, at+rtt),
			t.seg(true, 0, nil, 0, at+rtt+int64(100*time.Microsecond)))
	}
	if c.bulkIn == 0 && c.bulkOut == 0 && c.every == 0 {
		endBulk(at)
		s.add(ss)
		return
	}
	// Bulk transfers and heartbeats are generated lazily, a slice at a time.
	remainIn, remainOut := c.bulkIn, c.bulkOut
	cursor := at
	hbNext, hbEnd := at+int64(c.every), at+int64(c.life)
	ss.gen = func(now int64, ss *session) bool {
		for c.every > 0 && hbNext <= now+int64(50*time.Millisecond) && hbNext < hbEnd {
			ss.script = append(ss.script, t.seg(true, craft.PSH, make([]byte, 40+s.rng.IntN(160)), 0, hbNext))
			t.burst(ss, false, 60+s.rng.IntN(2400), hbNext+rtt, 0)
			hbNext += s.jitter(c.every, 0.15)
		}
		if c.every > 0 && hbNext < hbEnd {
			return true
		}
		if c.every > 0 {
			endBulk(hbNext)
			return false
		}
		for cursor < now+int64(50*time.Millisecond) && (remainIn > 0 || remainOut > 0) {
			step := int64(c.rate * 0.02) // 20 ms worth
			wobble := 0.6 + 0.8*s.rng.Float64()
			if remainIn > 0 {
				n := min(remainIn, int64(float64(step)*wobble))
				t.burst(ss, false, int(n), cursor, int64(c.rate))
				remainIn -= n
			}
			if remainOut > 0 {
				n := min(remainOut, int64(float64(step)*wobble))
				t.burst(ss, true, int(n), cursor, int64(c.rate))
				remainOut -= n
			}
			cursor += int64(20 * time.Millisecond)
		}
		if remainIn <= 0 && remainOut <= 0 {
			endBulk(cursor)
			return false
		}
		return true
	}
	s.add(ss)
}

// quic schedules an HTTP/3 connection: an encrypted Initial carrying the
// ClientHello, then short-header packets.
func (s *Source) quic(c conn, at int64) {
	ss := &session{}
	if !c.noDNS {
		at = s.lookup(ss, c.sv, at)
	}
	lport := s.ephemeral()
	s.attrib.set(17, lport, c.p)
	rtt := s.jitter(time.Duration(rttTo(c.sv.at)), 0.08)
	cli := netip.AddrPortFrom(s.myAddr(c.sv.ip), lport)
	srv := netip.AddrPortFrom(c.sv.ip, c.sv.port)
	initial := s.quicInitial(c.sv.name)
	if initial == nil {
		return
	}
	ss.script = append(ss.script, udpPkt(cli, srv, initial, at, true, 0))
	for i := range 3 { // the server's Initial + Handshake flight
		ss.script = append(ss.script, udpPkt(srv, cli, s.long(1200), at+rtt+int64(i)*int64(200*time.Microsecond), false, 0))
	}
	at += rtt + int64(time.Millisecond)
	shortBurst := func(fromClient bool, n int, at int64, rate float64) int64 {
		for n > 0 {
			sz := min(n, 1350)
			wire := 0
			if n > 20*1350 {
				sz, wire = 1350, 16*1350 // GSO/GRO batch
			}
			if fromClient {
				ss.script = append(ss.script, udpPkt(cli, srv, s.short(min(sz, 1350)), at, true, wire))
			} else {
				ss.script = append(ss.script, udpPkt(srv, cli, s.short(min(sz, 1350)), at, false, wire))
			}
			moved := max(sz, wire)
			n -= moved
			at += int64(float64(moved) / rate * 1e9)
			if !fromClient && s.rng.IntN(4) == 0 {
				ss.script = append(ss.script, udpPkt(cli, srv, s.short(40), at, true, 0))
			}
		}
		return at
	}
	for range c.exchanges {
		at += s.jitter(500*time.Millisecond, 0.9)
		ss.script = append(ss.script, udpPkt(cli, srv, s.short(200+s.rng.IntN(600)), at, true, 0))
		at = shortBurst(false, max(300, int(float64(c.resp)*(0.3+1.4*s.rng.Float64()))), at+rtt, 8<<20)
	}
	if c.bulkIn == 0 {
		s.add(ss)
		return
	}
	remain := c.bulkIn
	cursor := at
	ss.gen = func(now int64, ss *session) bool {
		for cursor < now+int64(50*time.Millisecond) && remain > 0 {
			// Video arrives in bursts: a segment every couple of seconds.
			seg := int64(c.rate * 2 * (0.7 + 0.6*s.rng.Float64()))
			n := min(remain, seg)
			shortBurst(false, int(n), cursor, c.rate*6)
			remain -= n
			cursor += s.jitter(2*time.Second, 0.25)
		}
		return remain > 0
	}
	s.add(ss)
}

// long returns a QUIC v1 long-header (Handshake) packet of n bytes.
func (s *Source) long(n int) []byte {
	b := make([]byte, n)
	b[0] = 0xe0 | byte(s.rng.IntN(4))
	b[4] = 1 // version 1
	b[5] = 8
	for i := 6; i < min(n, 32); i++ {
		b[i] = byte(s.rng.Uint32())
	}
	return b
}

// short returns a QUIC short-header packet body of n bytes.
func (s *Source) short(n int) []byte {
	b := make([]byte, n)
	b[0] = 0x40 | byte(s.rng.IntN(0x20))
	for i := 1; i < min(n, 24); i++ {
		b[i] = byte(s.rng.Uint32())
	}
	return b
}

// Attributor answers process attribution for the demo world.
type Attributor struct {
	mu    sync.Mutex
	ports map[uint32]*procmap.Process // proto<<16 | local port
	res   chan procmap.WorkerResult
}

func newAttributor() *Attributor {
	return &Attributor{ports: map[uint32]*procmap.Process{}, res: make(chan procmap.WorkerResult, 8)}
}

func (a *Attributor) set(proto uint8, port uint16, p *procmap.Process) {
	if p == nil {
		return
	}
	a.mu.Lock()
	a.ports[uint32(proto)<<16|uint32(port)] = p
	a.mu.Unlock()
}

// Submit implements engine.ProcAttributor.
func (a *Attributor) Submit(socks []procmap.Socket) bool {
	a.mu.Lock()
	out := make([]*procmap.Process, len(socks))
	for i, sk := range socks {
		out[i] = a.ports[uint32(sk.Proto)<<16|uint32(sk.Local.Port())]
	}
	a.mu.Unlock()
	select {
	case a.res <- procmap.WorkerResult{Sockets: socks, Procs: out}:
		return true
	default:
		return false
	}
}

// Results implements engine.ProcAttributor.
func (a *Attributor) Results() <-chan procmap.WorkerResult { return a.res }

package engine

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/craft"
	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/geo"
	"github.com/SharvikS/telluric/internal/wire"
)

// sliceSource replays a fixed list of frames, then reports EOF.
type sliceSource struct {
	frames []capture.Frame
	done   bool
}

func (s *sliceSource) Name() string { return "test" }
func (s *sliceSource) Read(timeout time.Duration, fn func(*capture.Frame)) error {
	if s.done {
		return io.EOF
	}
	for i := range s.frames {
		fn(&s.frames[i])
	}
	s.done = true
	return nil
}
func (s *sliceSource) Stats() capture.Stats { return capture.Stats{} }
func (s *sliceSource) Close() error         { return nil }

type fakeLocator map[netip.Addr]geo.Location

func (f fakeLocator) Locate(ip netip.Addr) (geo.Location, bool) {
	l, ok := f[ip]
	return l, ok
}

// recorder is a Client that keeps every frame.
type recorder struct {
	mu     sync.Mutex
	text   [][]byte
	binary [][]byte
}

func (r *recorder) Send(frame []byte, text, _ bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if text {
		r.text = append(r.text, frame)
	} else {
		r.binary = append(r.binary, frame)
	}
	return true
}

// state folds the recorded frames the way the browser does.
type state struct {
	hello   wire.Hello
	eps     map[uint32]wire.Endpoint
	flows   map[uint32]wire.Flow
	dns     []wire.DNSEvent
	shots   int
	shotSum uint64
	types   []string
}

func (r *recorder) fold(t *testing.T) state {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := state{eps: map[uint32]wire.Endpoint{}, flows: map[uint32]wire.Flow{}}
	for _, raw := range r.text {
		var head struct {
			T string `json:"t"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			t.Fatalf("bad JSON frame %s: %v", raw, err)
		}
		st.types = append(st.types, head.T)
		switch head.T {
		case "hello":
			json.Unmarshal(raw, &st.hello)
		case "snapshot":
			var s wire.Snapshot
			json.Unmarshal(raw, &s)
			for _, e := range s.Endpoints {
				st.eps[e.ID] = e
			}
			for _, f := range s.Flows {
				st.flows[f.ID] = f
			}
			st.dns = append(st.dns, s.DNS...)
		case "ep":
			var m struct{ Items []wire.Endpoint }
			json.Unmarshal(raw, &m)
			for _, e := range m.Items {
				st.eps[e.ID] = e
			}
		case "flow":
			var m struct{ Items []wire.Flow }
			json.Unmarshal(raw, &m)
			for _, f := range m.Items {
				st.flows[f.ID] = f
			}
		case "dns":
			var m struct{ Items []wire.DNSEvent }
			json.Unmarshal(raw, &m)
			st.dns = append(st.dns, m.Items...)
		}
	}
	for _, b := range r.binary {
		if b[0] != wire.MsgPkts || b[1] != 1 {
			t.Fatalf("unexpected binary frame %x", b[:2])
		}
		n := int(binary.LittleEndian.Uint16(b[2:4]))
		if len(b) != wire.PktsHeaderSize+n*wire.PktsRecordSize {
			t.Fatalf("PKTS length %d for %d records", len(b), n)
		}
		if base := math.Float64frombits(binary.LittleEndian.Uint64(b[4:12])); base < 1.7e12 {
			t.Fatalf("PKTS base %v is not Unix milliseconds", base)
		}
		for i := range n {
			rec := b[12+i*12:]
			st.shotSum += uint64(binary.LittleEndian.Uint32(rec[4:8]))
		}
		st.shots += n
	}
	return st
}

var (
	me     = netip.MustParseAddr("192.168.29.35")
	router = netip.MustParseAddr("192.168.29.1")
	yt     = netip.MustParseAddr("142.250.183.14")
)

func TestEngineEndToEnd(t *testing.T) {
	now := time.Now().UnixNano()
	var frames []capture.Frame
	at := func(ms int) int64 { return now + int64(ms)*int64(time.Millisecond) }
	add := func(ms int, outgoing bool, pkt []byte) {
		pt := capture.PacketHost
		if outgoing {
			pt = capture.PacketOutgoing
		}
		et := uint16(decode.EtherTypeIPv4)
		if pkt[0]>>4 == 6 {
			et = decode.EtherTypeIPv6
		}
		frames = append(frames, capture.Frame{TS: at(ms), Ifindex: 3, PktType: pt, Proto: et, HAType: capture.ARPHRDEther, WireLen: uint32(len(pkt)), Data: pkt})
	}

	// 1. DNS: www.youtube.com → CNAME → 142.250.183.14, answered in 12 ms.
	add(0, true, craft.UDP{Src: me, Dst: router, SrcPort: 40000, DstPort: 53, Payload: craft.DNSQuery(0x1234, "www.youtube.com", decode.DNSTypeA)}.Packet())
	add(12, false, craft.UDP{Src: router, Dst: me, SrcPort: 53, DstPort: 40000, Payload: craft.DNSResponse(0x1234, "www.youtube.com", decode.DNSTypeA, 0,
		craft.RR{Name: "www.youtube.com", Type: decode.DNSTypeCNAME, TTL: 300, Target: "youtube-ui.l.google.com"},
		craft.RR{Name: "youtube-ui.l.google.com", Type: decode.DNSTypeA, TTL: 60, Addr: yt})}.Packet())

	// 2. TCP handshake with a 40 ms RTT and a ClientHello split over two segments.
	hello, err := craft.TLSClientHello(&tls.Config{ServerName: "www.youtube.com", NextProtos: []string{"h2", "http/1.1"}})
	if err != nil {
		t.Fatal(err)
	}
	add(20, true, craft.TCP{Src: me, Dst: yt, SrcPort: 51234, DstPort: 443, Seq: 1000, Flags: craft.SYN, Options: craft.SYNOptions(1460, 7)}.Packet())
	add(60, false, craft.TCP{Src: yt, Dst: me, SrcPort: 443, DstPort: 51234, Seq: 5000, Ack: 1001, Flags: craft.SYN | craft.ACK}.Packet())
	add(61, true, craft.TCP{Src: me, Dst: yt, SrcPort: 51234, DstPort: 443, Seq: 1001, Ack: 5001, Flags: craft.ACK}.Packet())
	segs := craft.SplitSegments(hello, 1000)
	add(62, true, craft.TCP{Src: me, Dst: yt, SrcPort: 51234, DstPort: 443, Seq: 1001 + 1000, Ack: 5001, Flags: craft.ACK, Payload: segs[1]}.Packet()) // out of order
	add(63, true, craft.TCP{Src: me, Dst: yt, SrcPort: 51234, DstPort: 443, Seq: 1001, Ack: 5001, Flags: craft.ACK | craft.PSH, Payload: segs[0]}.Packet())
	for i := range 3 {
		add(110+i, false, craft.TCP{Src: yt, Dst: me, SrcPort: 443, DstPort: 51234, Seq: uint32(5001 + i*1400), Ack: 3000, Flags: craft.ACK, Payload: make([]byte, 1400)}.Packet())
	}

	// 3. HTTP/3: a QUIC Initial to a googlevideo host the browser never resolved.
	qhello, err := craft.QUICClientHello(&tls.Config{ServerName: "rr3---sn-cvh7knzl.googlevideo.com", NextProtos: []string{"h3"}})
	if err != nil {
		t.Fatal(err)
	}
	gv := netip.MustParseAddr("2404:6800:4009:82a::200e")
	me6 := netip.MustParseAddr("2405:201:1d:5111::35")
	initial := craft.QUICInitial{DCID: []byte{1, 2, 3, 4, 5, 6, 7, 8}, Frames: craft.CryptoFrame(0, qhello), PadTo: max(1250, len(qhello)+100)}.Bytes()
	add(200, true, craft.UDP{Src: me6, Dst: gv, SrcPort: 50123, DstPort: 443, Payload: initial}.Packet())

	src := &sliceSource{frames: frames}
	loc := fakeLocator{
		yt: {HasCoord: true, Lat: 19.076, Lon: 72.8777, City: "Mumbai", CC: "IN", Country: "India", ASN: 15169, Org: "Google LLC"},
		gv: {HasCoord: true, Lat: 19.076, Lon: 72.8777, City: "Mumbai", CC: "IN", ASN: 15169, Org: "Google LLC"},
	}
	eng := New(Config{Source: src, Mode: "replay", Locator: loc, Hostname: "testbox",
		Home: geo.Home{Lat: 19.08, Lon: 73.1, Known: true, Src: "flag"}})
	rec := &recorder{}
	eng.Subscribe(rec)
	ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	if err := eng.Run(ctx); err != nil {
		t.Fatal(err)
	}

	st := rec.fold(t)
	if len(st.types) < 2 || st.types[0] != "hello" || st.types[1] != "snapshot" {
		t.Fatalf("first frames %v, want hello then snapshot", st.types[:min(len(st.types), 3)])
	}
	if st.hello.Mode != "replay" || st.hello.Host != "testbox" || st.hello.Home.Src != "flag" || *st.hello.Home.Lat != 19.08 {
		t.Fatalf("hello %+v", st.hello)
	}

	var ytEP, gvEP, rtrEP *wire.Endpoint
	for _, e := range st.eps {
		switch e.IP {
		case yt.String():
			ytEP = &e
		case gv.String():
			gvEP = &e
		case router.String():
			rtrEP = &e
		}
	}
	if ytEP == nil || ytEP.Name != "www.youtube.com" || ytEP.Svc != "youtube" || ytEP.City != "Mumbai" || ytEP.Scope != "public" || ytEP.Lat == nil {
		t.Fatalf("youtube endpoint %+v", ytEP)
	}
	if gvEP == nil || gvEP.Name != "rr3---sn-cvh7knzl.googlevideo.com" || gvEP.Svc != "youtube" {
		t.Fatalf("googlevideo endpoint %+v", gvEP)
	}
	if rtrEP == nil || rtrEP.Scope != "lan" || rtrEP.Lat != nil {
		t.Fatalf("router endpoint %+v", rtrEP)
	}

	var tlsFlow, quicFlow *wire.Flow
	for _, f := range st.flows {
		switch {
		case f.RPort == 443 && f.Proto == "tcp":
			tlsFlow = &f
		case f.RPort == 443 && f.Proto == "udp":
			quicFlow = &f
		}
	}
	if tlsFlow == nil || tlsFlow.SNI != "www.youtube.com" || tlsFlow.ALPN != "h2" || tlsFlow.TLSv != "1.3" || !tlsFlow.PQ ||
		tlsFlow.Dir != "out" || tlsFlow.State != "est" || tlsFlow.App != "tls" || len(tlsFlow.JA4) != 36 {
		t.Fatalf("TLS flow %+v", tlsFlow)
	}
	if tlsFlow.RTT == nil || math.Abs(*tlsFlow.RTT-40) > 0.01 {
		t.Fatalf("handshake RTT %v, want 40 ms", tlsFlow.RTT)
	}
	if tlsFlow.BytesIn < 3*1400 || tlsFlow.PktsOut != 4 || tlsFlow.PktsIn != 4 {
		t.Fatalf("counters in=%d pktsIn=%d pktsOut=%d", tlsFlow.BytesIn, tlsFlow.PktsIn, tlsFlow.PktsOut)
	}
	if quicFlow == nil || quicFlow.App != "quic" || quicFlow.SNI != "rr3---sn-cvh7knzl.googlevideo.com" || quicFlow.JA4[:4] != "q13d" {
		t.Fatalf("QUIC flow %+v", quicFlow)
	}

	var ev *wire.DNSEvent
	for i := range st.dns {
		if st.dns[i].Q == "www.youtube.com" {
			ev = &st.dns[i]
		}
	}
	if ev == nil || ev.Rcode != "NOERROR" || len(ev.Answers) != 1 || ev.Answers[0] != yt.String() || ev.MS == nil || *ev.MS != 12 ||
		len(ev.CNAME) != 1 || ev.Server != router.String() {
		t.Fatalf("DNS event %+v", ev)
	}
	var wireBytes uint64
	for _, f := range frames {
		wireBytes += uint64(f.WireLen)
	}
	if st.shots == 0 || st.shotSum != wireBytes {
		t.Fatalf("%d shots carrying %d bytes, want all %d bytes", st.shots, st.shotSum, wireBytes)
	}
}

func TestShotAggregation(t *testing.T) {
	var b shotBatch
	b.reset()
	fl := &flow{id: 7, shotIdx: [2]int32{-1, -1}}
	for i := range 100 {
		b.add(fl, 1500, true, int64(i)*int64(time.Millisecond))
	}
	b.add(fl, 60, false, 0)
	if len(b.shots) != maxShotsPerFlowDir+1 {
		t.Fatalf("%d shots, want %d individual + 1", len(b.shots), maxShotsPerFlowDir)
	}
	var sum uint64
	pkts := 0
	for _, s := range b.shots {
		sum += uint64(s.Bytes)
		pkts += int(s.Pkts)
	}
	if sum != 100*1500+60 || pkts != 101 {
		t.Fatalf("aggregated %d bytes / %d packets", sum, pkts)
	}
	b.reset()
	if fl.shotIdx != [2]int32{-1, -1} || len(b.shots) != 0 {
		t.Fatal("reset left state behind")
	}
}

func TestServices(t *testing.T) {
	for name, want := range map[string]string{
		"rr3---sn-cvh7knzl.googlevideo.com": "youtube", "api.anthropic.com": "anthropic", "WWW.GitHub.COM.": "github",
		"edge-chat.facebook.com": "meta", "example.org": "",
	} {
		if got := serviceForName(name); got != want {
			t.Errorf("%s → %q, want %q", name, got, want)
		}
	}
	if serviceForOrg("Cloudflare, Inc.") != "cloudflare" || serviceForOrg("Reliance Jio Infocomm Limited") != "jio" {
		t.Error("org mapping")
	}
}

func TestTracerouteReconstruction(t *testing.T) {
	now := time.Now().UnixNano()
	target := netip.MustParseAddr("8.8.8.8")
	routers := []netip.Addr{router, netip.MustParseAddr("49.44.18.1"), netip.MustParseAddr("172.26.75.6"), netip.MustParseAddr("72.14.212.37")}
	var frames []capture.Frame
	add := func(ms int, out bool, pkt []byte) {
		pt := capture.PacketHost
		if out {
			pt = capture.PacketOutgoing
		}
		frames = append(frames, capture.Frame{TS: now + int64(ms)*int64(time.Millisecond), PktType: pt, Proto: decode.EtherTypeIPv4, WireLen: uint32(len(pkt)), Data: pkt})
	}
	for ttl := 1; ttl <= 5; ttl++ {
		probe := craft.UDP{Src: me, Dst: target, SrcPort: 45000, DstPort: uint16(33433 + ttl), Payload: make([]byte, 32), TTL: uint8(ttl)}.Packet()
		add(ttl*10, true, probe)
		if ttl <= len(routers) { // time exceeded in transit, from the router at this hop
			add(ttl*10+ttl*3, false, craft.ICMPError(routers[ttl-1], me, 11, 0, probe))
		} else { // the target itself: port unreachable
			add(ttl*10+17, false, craft.ICMPError(target, me, 3, 3, probe))
		}
	}
	loc := fakeLocator{routers[1]: {HasCoord: true, Lat: 19.07, Lon: 72.87, City: "Mumbai", CC: "IN", ASN: 55836, Org: "Reliance Jio"}}
	eng := New(Config{Source: &sliceSource{frames: frames}, Mode: "replay", Locator: loc})
	rec := &recorder{}
	eng.Subscribe(rec)
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	eng.Run(ctx)

	var last wire.Trace
	for _, raw := range rec.text {
		var m struct {
			T     string
			Items []wire.Trace
		}
		if json.Unmarshal(raw, &m) == nil && m.T == "trace" {
			last = m.Items[len(m.Items)-1]
		}
	}
	if last.Dst != "8.8.8.8" || !last.Done || len(last.Hops) != 5 {
		t.Fatalf("trace %+v", last)
	}
	for i, h := range last.Hops {
		if h.N != i+1 {
			t.Fatalf("hop order %+v", last.Hops)
		}
	}
	if last.Hops[0].Scope != "lan" || last.Hops[1].City != "Mumbai" || last.Hops[4].IP != "8.8.8.8" {
		t.Fatalf("hops %+v", last.Hops)
	}
	if math.Abs(last.Hops[2].RTT-9) > 0.01 {
		t.Fatalf("hop 3 RTT %v, want 9 ms", last.Hops[2].RTT)
	}
}

package decode

import (
	"bytes"
	"net/netip"
	"testing"

	"github.com/SharvikS/telluric/internal/craft"
)

var (
	v4a = netip.MustParseAddr("192.168.29.35")
	v4b = netip.MustParseAddr("142.250.183.14")
	v6a = netip.MustParseAddr("2405:201:1d:5111::35")
	v6b = netip.MustParseAddr("2606:4700::6810:84e5")
)

func TestIPv4TCPSyn(t *testing.T) {
	raw := craft.TCP{
		Src: v4a, Dst: v4b, SrcPort: 51234, DstPort: 443,
		Seq: 1000, Flags: craft.SYN, Window: 64240,
		Options: craft.SYNOptions(1460, 7), TTL: 64,
	}.Packet()

	var p Packet
	if err := p.Decode(EtherTypeIPv4, raw); err != nil {
		t.Fatal(err)
	}
	if !p.Has(LayerIP|LayerTCP) || p.Version != 4 || p.Proto != ProtoTCP {
		t.Fatalf("layers=%b version=%d proto=%d", p.Layers, p.Version, p.Proto)
	}
	if p.Src != v4a || p.Dst != v4b || p.SrcPort != 51234 || p.DstPort != 443 {
		t.Fatalf("tuple %v:%d → %v:%d", p.Src, p.SrcPort, p.Dst, p.DstPort)
	}
	if p.Seq != 1000 || p.Flags != SYN || p.Window != 64240 || p.TTL != 64 {
		t.Fatalf("seq=%d flags=%#x win=%d ttl=%d", p.Seq, p.Flags, p.Window, p.TTL)
	}
	if p.MSS != 1460 || p.WScale != 7 {
		t.Fatalf("mss=%d wscale=%d", p.MSS, p.WScale)
	}
	if len(p.Payload) != 0 || p.PayloadLen != 0 || p.IPLen != len(raw) {
		t.Fatalf("payload=%d/%d iplen=%d", len(p.Payload), p.PayloadLen, p.IPLen)
	}
}

func TestIPv6UDP(t *testing.T) {
	raw := craft.UDP{Src: v6a, Dst: v6b, SrcPort: 40000, DstPort: 443, Payload: []byte("hello quic")}.Packet()
	var p Packet
	if err := p.DecodeIP(raw); err != nil {
		t.Fatal(err)
	}
	if !p.Has(LayerIP|LayerUDP) || p.Version != 6 || p.Src != v6a || p.Dst != v6b {
		t.Fatalf("got %+v", p)
	}
	if string(p.Payload) != "hello quic" || p.PayloadLen != 10 {
		t.Fatalf("payload %q len %d", p.Payload, p.PayloadLen)
	}
	if p.WScale != -1 {
		t.Fatalf("wscale should default to -1, got %d", p.WScale)
	}
}

func TestIPv6ExtensionHeaders(t *testing.T) {
	udp := craft.UDP{Src: v6a, Dst: v6b, SrcPort: 5353, DstPort: 5353, Payload: []byte{1, 2, 3}}.Packet()[40:]

	// Hop-by-hop (8 bytes, PadN) → fragment header (first fragment) → UDP.
	ext := []byte{
		44, 0, 1, 4, 0, 0, 0, 0, // HBH: next=fragment, len=0, PadN(4)
		17, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef, // fragment: next=UDP, offset 0
	}
	raw := craft.IPv6(v6a, v6b, 0, 255, append(ext, udp...))
	var p Packet
	if err := p.Decode(EtherTypeIPv6, raw); err != nil {
		t.Fatal(err)
	}
	if p.Proto != ProtoUDP || !p.Has(LayerUDP) || p.Fragment || p.SrcPort != 5353 {
		t.Fatalf("got proto=%d layers=%b frag=%v sport=%d", p.Proto, p.Layers, p.Fragment, p.SrcPort)
	}

	// A non-first fragment has no transport header.
	ext[10], ext[11] = 0x05, 0x00 // offset 160
	raw = craft.IPv6(v6a, v6b, 0, 255, append(ext, udp...))
	if err := p.Decode(EtherTypeIPv6, raw); err != nil {
		t.Fatal(err)
	}
	if !p.Fragment || p.Has(LayerUDP) || p.Proto != ProtoUDP {
		t.Fatalf("non-first fragment decoded as %+v", p)
	}
}

func TestIPv6ExtensionHeaderLoopIsBounded(t *testing.T) {
	var chain []byte
	for range 20 {
		chain = append(chain, 0, 0, 1, 4, 0, 0, 0, 0) // hop-by-hop → hop-by-hop → …
	}
	var p Packet
	if err := p.Decode(EtherTypeIPv6, craft.IPv6(v6a, v6b, 0, 64, chain)); err != ErrMalformed {
		t.Fatalf("want ErrMalformed for a 20-deep chain, got %v", err)
	}
}

func TestVLANTags(t *testing.T) {
	ip := craft.UDP{Src: v4a, Dst: v4b, SrcPort: 1, DstPort: 53, Payload: []byte{0}}.Packet()
	tagged := append([]byte{0x00, 0x64, 0x81, 0x00, 0x00, 0x65, 0x08, 0x00}, ip...) // QinQ: VLAN 100 → VLAN 101 → IPv4
	var p Packet
	if err := p.Decode(EtherTypeQinQ, tagged); err != nil {
		t.Fatal(err)
	}
	if p.DstPort != 53 || p.Version != 4 {
		t.Fatalf("got %+v", p)
	}
}

func TestEthernetPaddingIsTrimmed(t *testing.T) {
	raw := craft.TCP{Src: v4a, Dst: v4b, SrcPort: 1, DstPort: 2, Flags: craft.ACK}.Packet()
	padded := append(raw, make([]byte, 6)...) // minimum-size Ethernet frames carry padding
	var p Packet
	if err := p.Decode(EtherTypeIPv4, padded); err != nil {
		t.Fatal(err)
	}
	if len(p.Payload) != 0 || p.PayloadLen != 0 {
		t.Fatalf("padding leaked into payload: %d bytes", len(p.Payload))
	}
}

func TestTruncatedCaptureKeepsClaimedLength(t *testing.T) {
	body := bytes.Repeat([]byte{0xab}, 1000)
	raw := craft.TCP{Src: v4a, Dst: v4b, SrcPort: 1, DstPort: 2, Flags: craft.ACK | craft.PSH, Payload: body}.Packet()
	var p Packet
	if err := p.Decode(EtherTypeIPv4, raw[:200]); err != nil {
		t.Fatal(err)
	}
	if p.PayloadLen != 1000 || len(p.Payload) != 160 || p.IPLen != len(raw) {
		t.Fatalf("payloadLen=%d captured=%d iplen=%d", p.PayloadLen, len(p.Payload), p.IPLen)
	}
}

func TestARP(t *testing.T) {
	gwMAC := [6]byte{0x8c, 0xa3, 0x99, 0x01, 0x02, 0x03}
	raw := craft.ARP(2, gwMAC, netip.MustParseAddr("192.168.29.1"), [6]byte{1, 2, 3, 4, 5, 6}, v4a)
	var p Packet
	if err := p.Decode(EtherTypeARP, raw); err != nil {
		t.Fatal(err)
	}
	if !p.Has(LayerARP) || p.ARP.Op != 2 || p.ARP.SenderMAC != gwMAC || p.ARP.SenderIP.String() != "192.168.29.1" || p.ARP.TargetIP != v4a {
		t.Fatalf("got %+v", p.ARP)
	}
}

func TestICMPErrorQuotesOffendingFlow(t *testing.T) {
	probe := craft.UDP{Src: v4a, Dst: v4b, SrcPort: 33434, DstPort: 33435, Payload: make([]byte, 32), TTL: 3}.Packet()
	router := netip.MustParseAddr("49.44.18.1")
	raw := craft.ICMPError(router, v4a, 11, 0, probe) // time exceeded in transit
	var p Packet
	if err := p.Decode(EtherTypeIPv4, raw); err != nil {
		t.Fatal(err)
	}
	if p.ICMPType != 11 || !p.ICMP.Valid {
		t.Fatalf("type=%d inner=%+v", p.ICMPType, p.ICMP)
	}
	in := p.ICMP
	if in.Src != v4a || in.Dst != v4b || in.Proto != ProtoUDP || in.SrcPort != 33434 || in.DstPort != 33435 {
		t.Fatalf("inner %+v", in)
	}

	// Echo messages are not errors and carry no quote.
	if err := p.Decode(EtherTypeIPv6, craft.ICMPEcho(v6a, v6b, false, 7, 1, []byte("ping"))); err != nil {
		t.Fatal(err)
	}
	if p.ICMPType != 128 || p.ICMP.Valid {
		t.Fatalf("echo request decoded as %+v", p)
	}
}

func TestEveryTruncationIsSafe(t *testing.T) {
	packets := [][]byte{
		craft.TCP{Src: v4a, Dst: v4b, SrcPort: 1, DstPort: 2, Flags: craft.SYN, Options: craft.SYNOptions(1460, 7), Payload: []byte("x")}.Packet(),
		craft.TCP{Src: v6a, Dst: v6b, SrcPort: 1, DstPort: 2, Flags: craft.SYN, Options: craft.SYNOptions(1440, 9)}.Packet(),
		craft.UDP{Src: v6a, Dst: v6b, SrcPort: 1, DstPort: 2, Payload: []byte("abc")}.Packet(),
		craft.ICMPError(v4b, v4a, 3, 3, craft.UDP{Src: v4a, Dst: v4b, SrcPort: 9, DstPort: 9}.Packet()),
	}
	var p Packet
	for _, raw := range packets {
		for n := range len(raw) {
			_ = p.DecodeIP(raw[:n]) // must not panic; errors are expected
		}
	}
}

func TestMalformedHeaders(t *testing.T) {
	raw := craft.TCP{Src: v4a, Dst: v4b, SrcPort: 1, DstPort: 2, Flags: craft.ACK}.Packet()
	bad := bytes.Clone(raw)
	bad[0] = 0x44 // IHL 16 bytes
	var p Packet
	if err := p.Decode(EtherTypeIPv4, bad); err != ErrMalformed {
		t.Fatalf("IHL<5: got %v", err)
	}
	bad = bytes.Clone(raw)
	bad[20+12] = 0x40 // TCP data offset 16 bytes
	if err := p.Decode(EtherTypeIPv4, bad); err != ErrMalformed {
		t.Fatalf("doff<5: got %v", err)
	}
	if err := p.Decode(0x88cc, raw); err != ErrUnsupported { // LLDP
		t.Fatalf("LLDP: got %v", err)
	}
}

func FuzzDecode(f *testing.F) {
	f.Add(uint16(EtherTypeIPv4), craft.TCP{Src: v4a, Dst: v4b, SrcPort: 1, DstPort: 443, Flags: craft.SYN, Options: craft.SYNOptions(1460, 7)}.Packet())
	f.Add(uint16(EtherTypeIPv6), craft.UDP{Src: v6a, Dst: v6b, SrcPort: 1, DstPort: 53, Payload: []byte{1, 2}}.Packet())
	f.Add(uint16(EtherTypeARP), craft.ARP(1, [6]byte{}, v4a, [6]byte{}, v4b))
	f.Add(uint16(EtherTypeIPv4), craft.ICMPError(v4b, v4a, 3, 3, craft.UDP{Src: v4a, Dst: v4b, SrcPort: 9, DstPort: 9}.Packet()))
	f.Add(uint16(EtherTypeVLAN), []byte{0, 1, 0x86, 0xdd})
	f.Fuzz(func(t *testing.T, et uint16, data []byte) {
		var p Packet
		if p.Decode(et, data) != nil {
			return
		}
		// Payload must alias the input, never extend beyond it.
		if len(p.Payload) > 0 {
			end := &p.Payload[len(p.Payload)-1]
			inside := false
			for i := range data {
				if &data[i] == end {
					inside = true
					break
				}
			}
			if !inside {
				t.Fatalf("payload escapes input buffer")
			}
		}
		if p.PayloadLen < 0 || p.PayloadLen < len(p.Payload) {
			t.Fatalf("PayloadLen %d < captured %d", p.PayloadLen, len(p.Payload))
		}
	})
}

func BenchmarkDecodeIPv4TCP(b *testing.B) {
	raw := craft.TCP{Src: v4a, Dst: v4b, SrcPort: 51234, DstPort: 443, Flags: craft.ACK | craft.PSH, Payload: make([]byte, 1400)}.Packet()
	benchDecode(b, EtherTypeIPv4, raw)
}

func BenchmarkDecodeIPv6UDP(b *testing.B) {
	raw := craft.UDP{Src: v6a, Dst: v6b, SrcPort: 443, DstPort: 51234, Payload: make([]byte, 1250)}.Packet()
	benchDecode(b, EtherTypeIPv6, raw)
}

func benchDecode(b *testing.B, et uint16, raw []byte) {
	var p Packet
	b.ReportAllocs()
	b.SetBytes(int64(len(raw)))
	for b.Loop() {
		if err := p.Decode(et, raw); err != nil {
			b.Fatal(err)
		}
	}
}

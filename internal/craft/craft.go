// Package craft builds well-formed network packets with correct checksums.
// It powers the decoder tests, the Wireshark differential tests and the
// synthetic traffic generator behind --demo.
package craft

import (
	"encoding/binary"
	"net/netip"
)

// TCP flag bits, matching decode.FIN… .
const (
	FIN uint8 = 1 << iota
	SYN
	RST
	PSH
	ACK
)

// IP wraps a transport payload in an IPv4 or IPv6 header chosen by the
// address family of src.
func IP(src, dst netip.Addr, proto uint8, ttl uint8, payload []byte) []byte {
	if src.Is4() {
		return IPv4(src, dst, proto, ttl, 0, payload)
	}
	return IPv6(src, dst, proto, ttl, payload)
}

// IPv4 builds an IPv4 packet with a valid header checksum.
func IPv4(src, dst netip.Addr, proto, ttl uint8, id uint16, payload []byte) []byte {
	b := make([]byte, 20+len(payload))
	b[0] = 0x45
	binary.BigEndian.PutUint16(b[2:], uint16(len(b)))
	binary.BigEndian.PutUint16(b[4:], id)
	b[6] = 0x40 // don't fragment
	b[8] = ttl
	b[9] = proto
	s, d := src.As4(), dst.As4()
	copy(b[12:16], s[:])
	copy(b[16:20], d[:])
	binary.BigEndian.PutUint16(b[10:], checksum(0, b[:20]))
	copy(b[20:], payload)
	return b
}

// IPv6 builds an IPv6 packet.
func IPv6(src, dst netip.Addr, next, hop uint8, payload []byte) []byte {
	b := make([]byte, 40+len(payload))
	b[0] = 0x60
	binary.BigEndian.PutUint16(b[4:], uint16(len(payload)))
	b[6] = next
	b[7] = hop
	s, d := src.As16(), dst.As16()
	copy(b[8:24], s[:])
	copy(b[24:40], d[:])
	copy(b[40:], payload)
	return b
}

// TCP describes a TCP segment.
type TCP struct {
	Src, Dst         netip.Addr
	SrcPort, DstPort uint16
	Seq, Ack         uint32
	Flags            uint8
	Window           uint16
	Options          []byte // raw options, padded to a multiple of 4 by Packet
	Payload          []byte
	TTL              uint8
}

// Packet returns the complete IP packet carrying the segment.
func (t TCP) Packet() []byte {
	opts := t.Options
	if pad := len(opts) % 4; pad != 0 {
		opts = append(append([]byte(nil), opts...), make([]byte, 4-pad)...)
	}
	hl := 20 + len(opts)
	seg := make([]byte, hl+len(t.Payload))
	binary.BigEndian.PutUint16(seg[0:], t.SrcPort)
	binary.BigEndian.PutUint16(seg[2:], t.DstPort)
	binary.BigEndian.PutUint32(seg[4:], t.Seq)
	binary.BigEndian.PutUint32(seg[8:], t.Ack)
	seg[12] = byte(hl/4) << 4
	seg[13] = t.Flags
	w := t.Window
	if w == 0 {
		w = 64240
	}
	binary.BigEndian.PutUint16(seg[14:], w)
	copy(seg[20:], opts)
	copy(seg[hl:], t.Payload)
	binary.BigEndian.PutUint16(seg[16:], checksum(pseudoHeader(t.Src, t.Dst, 6, len(seg)), seg))
	return IP(t.Src, t.Dst, 6, ttlOr(t.TTL), seg)
}

// SYNOptions returns the option block a modern Linux client sends on SYN:
// MSS, SACK permitted, timestamps and window scale.
func SYNOptions(mss uint16, wscale uint8) []byte {
	return []byte{
		2, 4, byte(mss >> 8), byte(mss),
		4, 2,
		8, 10, 0, 0, 0, 1, 0, 0, 0, 0,
		1,
		3, 3, wscale,
	}
}

// UDP describes a UDP datagram.
type UDP struct {
	Src, Dst         netip.Addr
	SrcPort, DstPort uint16
	Payload          []byte
	TTL              uint8
}

// Packet returns the complete IP packet carrying the datagram.
func (u UDP) Packet() []byte {
	seg := make([]byte, 8+len(u.Payload))
	binary.BigEndian.PutUint16(seg[0:], u.SrcPort)
	binary.BigEndian.PutUint16(seg[2:], u.DstPort)
	binary.BigEndian.PutUint16(seg[4:], uint16(len(seg)))
	copy(seg[8:], u.Payload)
	c := checksum(pseudoHeader(u.Src, u.Dst, 17, len(seg)), seg)
	if c == 0 {
		c = 0xffff
	}
	binary.BigEndian.PutUint16(seg[6:], c)
	return IP(u.Src, u.Dst, 17, ttlOr(u.TTL), seg)
}

// ICMPEcho builds an ICMP (v4) or ICMPv6 echo request or reply.
func ICMPEcho(src, dst netip.Addr, reply bool, id, seq uint16, data []byte) []byte {
	m := make([]byte, 8+len(data))
	switch {
	case src.Is4() && reply:
		m[0] = 0
	case src.Is4():
		m[0] = 8
	case reply:
		m[0] = 129
	default:
		m[0] = 128
	}
	binary.BigEndian.PutUint16(m[4:], id)
	binary.BigEndian.PutUint16(m[6:], seq)
	copy(m[8:], data)
	if src.Is4() {
		binary.BigEndian.PutUint16(m[2:], checksum(0, m))
		return IPv4(src, dst, 1, 64, 0, m)
	}
	binary.BigEndian.PutUint16(m[2:], checksum(pseudoHeader(src, dst, 58, len(m)), m))
	return IPv6(src, dst, 58, 64, m)
}

// ICMPError builds an ICMP error (type/code) quoting the start of orig, the
// offending IP packet, as routers do.
func ICMPError(src, dst netip.Addr, typ, code uint8, orig []byte) []byte {
	quote := orig
	if len(quote) > 28+20 {
		quote = quote[:48]
	}
	m := make([]byte, 8+len(quote))
	m[0], m[1] = typ, code
	copy(m[8:], quote)
	if src.Is4() {
		binary.BigEndian.PutUint16(m[2:], checksum(0, m))
		return IPv4(src, dst, 1, 64, 0, m)
	}
	binary.BigEndian.PutUint16(m[2:], checksum(pseudoHeader(src, dst, 58, len(m)), m))
	return IPv6(src, dst, 58, 64, m)
}

// ARP builds an Ethernet/IPv4 ARP message (op 1 request, 2 reply).
func ARP(op uint16, senderMAC [6]byte, senderIP netip.Addr, targetMAC [6]byte, targetIP netip.Addr) []byte {
	b := make([]byte, 28)
	binary.BigEndian.PutUint16(b[0:], 1)
	binary.BigEndian.PutUint16(b[2:], 0x0800)
	b[4], b[5] = 6, 4
	binary.BigEndian.PutUint16(b[6:], op)
	copy(b[8:14], senderMAC[:])
	s, t := senderIP.As4(), targetIP.As4()
	copy(b[14:18], s[:])
	copy(b[18:24], targetMAC[:])
	copy(b[24:28], t[:])
	return b
}

// Ethernet wraps a network-layer payload in an Ethernet II header.
func Ethernet(dst, src [6]byte, etherType uint16, payload []byte) []byte {
	b := make([]byte, 14+len(payload))
	copy(b[0:6], dst[:])
	copy(b[6:12], src[:])
	binary.BigEndian.PutUint16(b[12:], etherType)
	copy(b[14:], payload)
	return b
}

func ttlOr(t uint8) uint8 {
	if t == 0 {
		return 64
	}
	return t
}

// pseudoHeader returns the partial checksum of the TCP/UDP pseudo-header.
func pseudoHeader(src, dst netip.Addr, proto uint8, length int) uint32 {
	var sum uint32
	add := func(b []byte) {
		for i := 0; i+1 < len(b); i += 2 {
			sum += uint32(b[i])<<8 | uint32(b[i+1])
		}
	}
	if src.Is4() {
		s, d := src.As4(), dst.As4()
		add(s[:])
		add(d[:])
	} else {
		s, d := src.As16(), dst.As16()
		add(s[:])
		add(d[:])
	}
	sum += uint32(proto)
	sum += uint32(length)
	return sum
}

// checksum computes the Internet checksum (RFC 1071) of b, seeded with a
// partial sum.
func checksum(sum uint32, b []byte) uint16 {
	for len(b) >= 2 {
		sum += uint32(b[0])<<8 | uint32(b[1])
		b = b[2:]
	}
	if len(b) == 1 {
		sum += uint32(b[0]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}

// Package decode parses captured frames into a flat Packet value.
//
// The hot path never allocates: Packet is a plain value the caller reuses,
// addresses are netip.Addr values, and Payload aliases the caller's buffer.
// Anything that must outlive the frame has to be copied by the caller.
package decode

import (
	"encoding/binary"
	"errors"
	"net/netip"
)

var (
	// ErrTruncated means the captured bytes end before a header does.
	ErrTruncated = errors.New("decode: truncated")
	// ErrMalformed means a header field is impossible.
	ErrMalformed = errors.New("decode: malformed")
	// ErrUnsupported means the network protocol is not one we decode.
	ErrUnsupported = errors.New("decode: unsupported protocol")
)

// EtherType values for the network layer.
const (
	EtherTypeIPv4 uint16 = 0x0800
	EtherTypeARP  uint16 = 0x0806
	EtherTypeVLAN uint16 = 0x8100
	EtherTypeIPv6 uint16 = 0x86DD
	EtherTypeQinQ uint16 = 0x88A8
)

// IP protocol numbers.
const (
	ProtoICMP   uint8 = 1
	ProtoTCP    uint8 = 6
	ProtoUDP    uint8 = 17
	ProtoESP    uint8 = 50
	ProtoICMPv6 uint8 = 58
)

// TCP header flags.
const (
	FIN uint8 = 1 << iota
	SYN
	RST
	PSH
	ACK
	URG
	ECE
	CWR
)

// Layers records which headers were decoded.
type Layers uint8

const (
	LayerIP Layers = 1 << iota
	LayerTCP
	LayerUDP
	LayerICMP
	LayerARP
)

// ARP holds an Ethernet/IPv4 ARP message.
type ARP struct {
	Op        uint16 // 1 request, 2 reply
	SenderMAC [6]byte
	SenderIP  netip.Addr
	TargetMAC [6]byte
	TargetIP  netip.Addr
}

// ICMPInner is the start of the datagram quoted by an ICMP error message
// (destination unreachable, time exceeded, …), which ties the error to the
// flow that caused it.
type ICMPInner struct {
	Valid            bool
	Src, Dst         netip.Addr
	Proto            uint8
	SrcPort, DstPort uint16
}

// Packet is the decoded form of one frame. Reuse it across frames; Decode
// resets it first.
type Packet struct {
	Layers Layers

	// Network layer.
	Version  uint8 // 4 or 6
	Src, Dst netip.Addr
	Proto    uint8 // transport protocol, after IPv6 extension headers
	TTL      uint8 // TTL or hop limit
	Fragment bool  // a non-first fragment: no transport header follows
	IPLen    int   // network-layer length claimed by the header

	// Transport layer.
	SrcPort, DstPort uint16
	Seq, Ack         uint32
	Flags            uint8
	Window           uint16
	MSS              uint16 // from the SYN options, 0 if absent
	WScale           int8   // window scale shift from the SYN options, -1 if absent

	ICMPType, ICMPCode uint8
	ICMP               ICMPInner

	// Payload is the transport payload as captured. When the capture was
	// truncated it is shorter than PayloadLen, the length the headers claim.
	Payload    []byte
	PayloadLen int

	ARP ARP
}

// Decode parses data, which starts at the network-layer header identified by
// etherType (as delivered by a cooked AF_PACKET socket or a Linux SLL capture).
func (p *Packet) Decode(etherType uint16, data []byte) error {
	*p = Packet{WScale: -1}
	for etherType == EtherTypeVLAN || etherType == EtherTypeQinQ {
		if len(data) < 4 {
			return ErrTruncated
		}
		etherType = binary.BigEndian.Uint16(data[2:4])
		data = data[4:]
	}
	switch etherType {
	case EtherTypeIPv4:
		return p.decodeIPv4(data)
	case EtherTypeIPv6:
		return p.decodeIPv6(data)
	case EtherTypeARP:
		return p.decodeARP(data)
	}
	return ErrUnsupported
}

// DecodeIP parses a raw IP packet, choosing the version from its first nibble.
func (p *Packet) DecodeIP(data []byte) error {
	if len(data) == 0 {
		*p = Packet{WScale: -1}
		return ErrTruncated
	}
	switch data[0] >> 4 {
	case 4:
		return p.Decode(EtherTypeIPv4, data)
	case 6:
		return p.Decode(EtherTypeIPv6, data)
	}
	*p = Packet{WScale: -1}
	return ErrUnsupported
}

func (p *Packet) decodeIPv4(b []byte) error {
	if len(b) < 20 {
		return ErrTruncated
	}
	if b[0]>>4 != 4 {
		return ErrMalformed
	}
	ihl := int(b[0]&0x0f) * 4
	if ihl < 20 {
		return ErrMalformed
	}
	if len(b) < ihl {
		return ErrTruncated
	}
	p.Layers |= LayerIP
	p.Version = 4
	p.TTL = b[8]
	p.Proto = b[9]
	p.Src = netip.AddrFrom4([4]byte(b[12:16]))
	p.Dst = netip.AddrFrom4([4]byte(b[16:20]))

	// The total length can be 0 (TSO) or smaller than the capture (Ethernet
	// padding); trust it only when it is sane.
	total := int(binary.BigEndian.Uint16(b[2:4]))
	end := len(b)
	if total >= ihl {
		p.IPLen = total
		if total < end {
			end = total
		}
	} else {
		p.IPLen = len(b)
	}
	if binary.BigEndian.Uint16(b[6:8])&0x1fff != 0 {
		p.Fragment = true
		p.Payload = b[ihl:end]
		p.PayloadLen = p.IPLen - ihl
		return nil
	}
	return p.decodeTransport(b[ihl:end], p.IPLen-ihl)
}

// maxExtHeaders bounds the IPv6 extension-header walk so a crafted chain can't
// keep the decoder busy.
const maxExtHeaders = 8

func (p *Packet) decodeIPv6(b []byte) error {
	if len(b) < 40 {
		return ErrTruncated
	}
	if b[0]>>4 != 6 {
		return ErrMalformed
	}
	p.Layers |= LayerIP
	p.Version = 6
	p.TTL = b[7]
	p.Src = netip.AddrFrom16([16]byte(b[8:24]))
	p.Dst = netip.AddrFrom16([16]byte(b[24:40]))

	plen := int(binary.BigEndian.Uint16(b[4:6]))
	end := len(b)
	if plen == 0 { // jumbogram or BIG TCP: the capture length is all we know
		p.IPLen = len(b)
	} else {
		p.IPLen = 40 + plen
		if p.IPLen < end {
			end = p.IPLen
		}
	}

	next := b[6]
	off := 40
	for i := 0; ; i++ {
		switch next {
		case 0, 43, 60, 135, 139, 140: // hop-by-hop, routing, dest opts, mobility, HIP, shim6
			if i == maxExtHeaders {
				return ErrMalformed
			}
			if end < off+8 {
				return ErrTruncated
			}
			next = b[off]
			off += (int(b[off+1]) + 1) * 8
		case 44: // fragment
			if i == maxExtHeaders {
				return ErrMalformed
			}
			if end < off+8 {
				return ErrTruncated
			}
			next = b[off]
			fragOff := binary.BigEndian.Uint16(b[off+2:off+4]) >> 3
			off += 8
			if fragOff != 0 {
				p.Proto = next
				p.Fragment = true
				p.Payload = b[off:end]
				p.PayloadLen = p.IPLen - off
				return nil
			}
		case 51: // authentication header: length in 4-octet units, minus 2
			if i == maxExtHeaders {
				return ErrMalformed
			}
			if end < off+8 {
				return ErrTruncated
			}
			next = b[off]
			off += (int(b[off+1]) + 2) * 4
		default:
			if off > end {
				return ErrTruncated
			}
			p.Proto = next
			return p.decodeTransport(b[off:end], p.IPLen-off)
		}
		if off > end {
			return ErrTruncated
		}
	}
}

// decodeTransport parses the transport header in b; l4len is the transport
// length the IP header claims (b may be shorter if the capture was cut).
func (p *Packet) decodeTransport(b []byte, l4len int) error {
	switch p.Proto {
	case ProtoTCP:
		return p.decodeTCP(b, l4len)
	case ProtoUDP:
		return p.decodeUDP(b, l4len)
	case ProtoICMP, ProtoICMPv6:
		return p.decodeICMP(b, l4len)
	}
	p.Payload = b
	p.PayloadLen = max(l4len, len(b))
	return nil
}

func (p *Packet) decodeTCP(b []byte, l4len int) error {
	if len(b) < 20 {
		return ErrTruncated
	}
	doff := int(b[12]>>4) * 4
	if doff < 20 {
		return ErrMalformed
	}
	if len(b) < doff {
		return ErrTruncated
	}
	p.Layers |= LayerTCP
	p.SrcPort = binary.BigEndian.Uint16(b[0:2])
	p.DstPort = binary.BigEndian.Uint16(b[2:4])
	p.Seq = binary.BigEndian.Uint32(b[4:8])
	p.Ack = binary.BigEndian.Uint32(b[8:12])
	p.Flags = b[13]
	p.Window = binary.BigEndian.Uint16(b[14:16])
	if p.Flags&SYN != 0 {
		p.parseTCPOptions(b[20:doff])
	}
	p.Payload = b[doff:]
	p.PayloadLen = max(l4len-doff, len(p.Payload))
	return nil
}

func (p *Packet) parseTCPOptions(o []byte) {
	for len(o) > 0 {
		kind := o[0]
		if kind == 0 { // end of option list
			return
		}
		if kind == 1 { // no-op
			o = o[1:]
			continue
		}
		if len(o) < 2 || int(o[1]) < 2 || int(o[1]) > len(o) {
			return
		}
		body := o[2:o[1]]
		switch {
		case kind == 2 && len(body) == 2:
			p.MSS = binary.BigEndian.Uint16(body)
		case kind == 3 && len(body) == 1:
			p.WScale = int8(min(body[0], 14))
		}
		o = o[o[1]:]
	}
}

func (p *Packet) decodeUDP(b []byte, l4len int) error {
	if len(b) < 8 {
		return ErrTruncated
	}
	p.Layers |= LayerUDP
	p.SrcPort = binary.BigEndian.Uint16(b[0:2])
	p.DstPort = binary.BigEndian.Uint16(b[2:4])
	ulen := int(binary.BigEndian.Uint16(b[4:6]))
	switch {
	case ulen >= 8 && ulen <= len(b):
		p.Payload = b[8:ulen]
		p.PayloadLen = ulen - 8
	case ulen >= 8:
		p.Payload = b[8:]
		p.PayloadLen = ulen - 8
	default: // 0 for UDP GSO / jumbograms
		p.Payload = b[8:]
		p.PayloadLen = max(l4len-8, len(p.Payload))
	}
	return nil
}

func (p *Packet) decodeICMP(b []byte, l4len int) error {
	if len(b) < 4 {
		return ErrTruncated
	}
	p.Layers |= LayerICMP
	p.ICMPType = b[0]
	p.ICMPCode = b[1]
	if len(b) >= 8 {
		p.Payload = b[8:]
		p.PayloadLen = max(l4len-8, len(p.Payload))
	}
	if p.isICMPError() {
		p.ICMP = quotedDatagram(p.Payload)
	}
	return nil
}

func (p *Packet) isICMPError() bool {
	if p.Proto == ProtoICMP {
		switch p.ICMPType {
		case 3, 4, 5, 11, 12: // unreachable, source quench, redirect, time exceeded, parameter problem
			return true
		}
		return false
	}
	return p.ICMPType < 128 // ICMPv6 error messages are types 1–127
}

// quotedDatagram parses the IP + transport header quoted inside an ICMP error.
func quotedDatagram(b []byte) ICMPInner {
	var in ICMPInner
	if len(b) == 0 {
		return in
	}
	var l4 []byte
	switch b[0] >> 4 {
	case 4:
		if len(b) < 20 {
			return in
		}
		ihl := int(b[0]&0x0f) * 4
		if ihl < 20 || len(b) < ihl {
			return in
		}
		in.Proto = b[9]
		in.Src = netip.AddrFrom4([4]byte(b[12:16]))
		in.Dst = netip.AddrFrom4([4]byte(b[16:20]))
		l4 = b[ihl:]
	case 6:
		if len(b) < 40 {
			return in
		}
		in.Proto = b[6]
		in.Src = netip.AddrFrom16([16]byte(b[8:24]))
		in.Dst = netip.AddrFrom16([16]byte(b[24:40]))
		l4 = b[40:]
	default:
		return in
	}
	in.Valid = true
	if (in.Proto == ProtoTCP || in.Proto == ProtoUDP) && len(l4) >= 4 {
		in.SrcPort = binary.BigEndian.Uint16(l4[0:2])
		in.DstPort = binary.BigEndian.Uint16(l4[2:4])
	}
	return in
}

func (p *Packet) decodeARP(b []byte) error {
	if len(b) < 8 {
		return ErrTruncated
	}
	htype := binary.BigEndian.Uint16(b[0:2])
	ptype := binary.BigEndian.Uint16(b[2:4])
	if htype != 1 || ptype != EtherTypeIPv4 || b[4] != 6 || b[5] != 4 {
		return ErrUnsupported
	}
	if len(b) < 28 {
		return ErrTruncated
	}
	p.Layers |= LayerARP
	p.ARP.Op = binary.BigEndian.Uint16(b[6:8])
	copy(p.ARP.SenderMAC[:], b[8:14])
	p.ARP.SenderIP = netip.AddrFrom4([4]byte(b[14:18]))
	copy(p.ARP.TargetMAC[:], b[18:24])
	p.ARP.TargetIP = netip.AddrFrom4([4]byte(b[24:28]))
	return nil
}

// Has reports whether all layers in l were decoded.
func (p *Packet) Has(l Layers) bool { return p.Layers&l == l }

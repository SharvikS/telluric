package craft

import (
	"encoding/binary"
	"net/netip"
	"strings"
)

// RR is a resource record for DNSResponse.
type RR struct {
	Name   string
	Type   uint16
	TTL    uint32
	Addr   netip.Addr // A, AAAA
	Target string     // CNAME, PTR, NS
	Data   []byte     // raw RDATA for any other type
}

// DNSQuery builds a recursive query for name.
func DNSQuery(id uint16, name string, qtype uint16) []byte {
	b := dnsHeader(id, 0x0100, 1, 0)
	b = appendName(b, name)
	return binary.BigEndian.AppendUint32(b, uint32(qtype)<<16|1)
}

// DNSResponse builds a response to a query for name. Answer owner names
// equal to the question name are compressed with a pointer to it, as real
// resolvers do.
func DNSResponse(id uint16, name string, qtype uint16, rcode uint8, answers ...RR) []byte {
	b := dnsHeader(id, 0x8180|uint16(rcode), 1, len(answers))
	b = appendName(b, name)
	b = binary.BigEndian.AppendUint32(b, uint32(qtype)<<16|1)
	for _, rr := range answers {
		if strings.EqualFold(rr.Name, name) {
			b = append(b, 0xc0, 12)
		} else {
			b = appendName(b, rr.Name)
		}
		b = binary.BigEndian.AppendUint16(b, rr.Type)
		b = binary.BigEndian.AppendUint16(b, 1)
		b = binary.BigEndian.AppendUint32(b, rr.TTL)
		var rd []byte
		switch {
		case rr.Addr.Is4():
			a := rr.Addr.As4()
			rd = a[:]
		case rr.Addr.Is6():
			a := rr.Addr.As16()
			rd = a[:]
		case rr.Target != "":
			rd = appendName(nil, rr.Target)
		default:
			rd = rr.Data
		}
		b = binary.BigEndian.AppendUint16(b, uint16(len(rd)))
		b = append(b, rd...)
	}
	return b
}

// HTTPSRecord builds the RDATA of an HTTPS record (RFC 9460) for the
// service itself (target "."), with ALPN, address hints and optionally an
// ECH configuration.
func HTTPSRecord(alpn []string, hints []netip.Addr, ech bool) []byte {
	b := []byte{0, 1, 0} // priority 1, target "."
	param := func(key uint16, v []byte) {
		b = binary.BigEndian.AppendUint16(b, key)
		b = binary.BigEndian.AppendUint16(b, uint16(len(v)))
		b = append(b, v...)
	}
	var a []byte
	for _, p := range alpn {
		a = append(append(a, byte(len(p))), p...)
	}
	param(1, a)
	var v4, v6 []byte
	for _, h := range hints {
		if h.Is4() {
			x := h.As4()
			v4 = append(v4, x[:]...)
		} else {
			x := h.As16()
			v6 = append(v6, x[:]...)
		}
	}
	if len(v4) > 0 {
		param(4, v4)
	}
	if ech {
		param(5, []byte{0, 4, 0xfe, 0x0d, 0, 0})
	}
	if len(v6) > 0 {
		param(6, v6)
	}
	return b
}

// TCPFramed prefixes a DNS message with its length, as DNS over TCP does.
func TCPFramed(msg []byte) []byte {
	return append(binary.BigEndian.AppendUint16(nil, uint16(len(msg))), msg...)
}

func dnsHeader(id, flags uint16, qd, an int) []byte {
	b := make([]byte, 12, 512)
	binary.BigEndian.PutUint16(b[0:], id)
	binary.BigEndian.PutUint16(b[2:], flags)
	binary.BigEndian.PutUint16(b[4:], uint16(qd))
	binary.BigEndian.PutUint16(b[6:], uint16(an))
	return b
}

func appendName(b []byte, name string) []byte {
	for label := range strings.SplitSeq(strings.TrimSuffix(name, "."), ".") {
		if label == "" {
			continue
		}
		b = append(b, byte(len(label)))
		b = append(b, label...)
	}
	return append(b, 0)
}

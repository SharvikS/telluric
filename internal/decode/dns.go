package decode

import (
	"encoding/binary"
	"net/netip"
	"strconv"
)

// DNS record types we interpret.
const (
	DNSTypeA     uint16 = 1
	DNSTypeNS    uint16 = 2
	DNSTypeCNAME uint16 = 5
	DNSTypeSOA   uint16 = 6
	DNSTypePTR   uint16 = 12
	DNSTypeMX    uint16 = 15
	DNSTypeTXT   uint16 = 16
	DNSTypeAAAA  uint16 = 28
	DNSTypeSRV   uint16 = 33
	DNSTypeDNAME uint16 = 39
	DNSTypeOPT   uint16 = 41
	DNSTypeSVCB  uint16 = 64
	DNSTypeHTTPS uint16 = 65
	DNSTypeANY   uint16 = 255
)

// DNS response codes.
const (
	DNSRcodeNoError  uint8 = 0
	DNSRcodeFormErr  uint8 = 1
	DNSRcodeServFail uint8 = 2
	DNSRcodeNXDomain uint8 = 3
	DNSRcodeNotImp   uint8 = 4
	DNSRcodeRefused  uint8 = 5
)

const (
	maxDNSQuestions = 8
	maxDNSAnswers   = 64
	maxNameHops     = 64
	maxHints        = 4
)

// DNSQuestion is one entry of the question section.
type DNSQuestion struct {
	Name  []byte // lower-cased, dot-separated, no trailing dot
	Type  uint16
	Class uint16
}

// DNSRecord is one resource record of the answer section.
type DNSRecord struct {
	Name   []byte
	Type   uint16
	Class  uint16
	TTL    uint32
	Addr   netip.Addr // A, AAAA
	Target []byte     // CNAME, DNAME, PTR, NS, MX exchange, SRV/SVCB/HTTPS target
	Data   []byte     // raw RDATA (aliases the message)
	// Hints are the ipv4hint/ipv6hint addresses of SVCB/HTTPS records:
	// browsers connect to them without a separate A/AAAA lookup.
	Hints  [maxHints]netip.Addr
	NHints int
	ECH    bool // an HTTPS/SVCB record advertising an ECH config
}

// DNSMessage is a parsed DNS message. Reuse it across messages: names are
// decoded into an internal arena that the next Parse overwrites.
type DNSMessage struct {
	ID        uint16
	Response  bool
	Opcode    uint8
	Rcode     uint8
	Truncated bool
	Questions []DNSQuestion
	Answers   []DNSRecord

	names []byte
}

// Parse decodes a DNS message (as carried by UDP, or by TCP after the
// two-byte length prefix). Only the question and answer sections are
// decoded.
func (m *DNSMessage) Parse(b []byte) error {
	if m.names == nil {
		m.names = make([]byte, 0, 1024)
	}
	m.names = m.names[:0]
	m.Questions = m.Questions[:0]
	m.Answers = m.Answers[:0]
	if len(b) < 12 {
		return ErrTruncated
	}
	m.ID = binary.BigEndian.Uint16(b[0:2])
	flags := binary.BigEndian.Uint16(b[2:4])
	m.Response = flags&0x8000 != 0
	m.Opcode = uint8(flags>>11) & 0x0f
	m.Truncated = flags&0x0200 != 0
	m.Rcode = uint8(flags & 0x0f)
	qd := int(binary.BigEndian.Uint16(b[4:6]))
	an := int(binary.BigEndian.Uint16(b[6:8]))
	if qd > maxDNSQuestions {
		return ErrMalformed
	}

	off := 12
	for range qd {
		name, next, err := m.readName(b, off)
		if err != nil {
			return err
		}
		if next+4 > len(b) {
			return ErrTruncated
		}
		m.Questions = append(m.Questions, DNSQuestion{
			Name:  name,
			Type:  binary.BigEndian.Uint16(b[next:]),
			Class: binary.BigEndian.Uint16(b[next+2:]) & 0x7fff, // mDNS uses the top bit
		})
		off = next + 4
	}

	for range min(an, maxDNSAnswers) {
		name, next, err := m.readName(b, off)
		if err != nil {
			return err
		}
		if next+10 > len(b) {
			return ErrTruncated
		}
		rr := DNSRecord{
			Name:  name,
			Type:  binary.BigEndian.Uint16(b[next:]),
			Class: binary.BigEndian.Uint16(b[next+2:]) & 0x7fff,
			TTL:   binary.BigEndian.Uint32(b[next+4:]),
		}
		rdlen := int(binary.BigEndian.Uint16(b[next+8:]))
		rdOff := next + 10
		if rdOff+rdlen > len(b) {
			return ErrTruncated
		}
		rr.Data = b[rdOff : rdOff+rdlen]
		if err := m.parseRData(b, rdOff, &rr); err != nil {
			return err
		}
		m.Answers = append(m.Answers, rr)
		off = rdOff + rdlen
	}
	return nil
}

// ParseTCP decodes a DNS message carried over TCP, which is prefixed with
// its length. It returns ErrTruncated until the whole message is present.
func (m *DNSMessage) ParseTCP(b []byte) error {
	if len(b) < 2 {
		return ErrTruncated
	}
	n := int(binary.BigEndian.Uint16(b))
	if len(b) < 2+n {
		return ErrTruncated
	}
	return m.Parse(b[2 : 2+n])
}

func (m *DNSMessage) parseRData(msg []byte, off int, rr *DNSRecord) error {
	rd := rr.Data
	var err error
	switch rr.Type {
	case DNSTypeA:
		if len(rd) == 4 {
			rr.Addr = netip.AddrFrom4([4]byte(rd))
		}
	case DNSTypeAAAA:
		if len(rd) == 16 {
			rr.Addr = netip.AddrFrom16([16]byte(rd))
		}
	case DNSTypeCNAME, DNSTypeDNAME, DNSTypePTR, DNSTypeNS:
		rr.Target, _, err = m.readName(msg, off)
	case DNSTypeMX:
		if len(rd) >= 3 {
			rr.Target, _, err = m.readName(msg, off+2)
		}
	case DNSTypeSRV:
		if len(rd) >= 7 {
			rr.Target, _, err = m.readName(msg, off+6)
		}
	case DNSTypeSVCB, DNSTypeHTTPS:
		err = m.parseSVCB(rd, rr)
	}
	return err
}

// parseSVCB decodes SVCB/HTTPS RDATA (RFC 9460): priority, an uncompressed
// target name, then SvcParams.
func (m *DNSMessage) parseSVCB(rd []byte, rr *DNSRecord) error {
	if len(rd) < 3 {
		return ErrTruncated
	}
	target, next, err := m.readName(rd, 2) // compression is forbidden here
	if err != nil {
		return err
	}
	rr.Target = target
	p := rd[next:]
	for len(p) >= 4 {
		key := binary.BigEndian.Uint16(p[0:2])
		n := int(binary.BigEndian.Uint16(p[2:4]))
		if 4+n > len(p) {
			return ErrTruncated
		}
		v := p[4 : 4+n]
		switch key {
		case 4: // ipv4hint
			for i := 0; i+4 <= len(v) && rr.NHints < maxHints; i += 4 {
				rr.Hints[rr.NHints] = netip.AddrFrom4([4]byte(v[i : i+4]))
				rr.NHints++
			}
		case 5: // ech
			rr.ECH = true
		case 6: // ipv6hint
			for i := 0; i+16 <= len(v) && rr.NHints < maxHints; i += 16 {
				rr.Hints[rr.NHints] = netip.AddrFrom16([16]byte(v[i : i+16]))
				rr.NHints++
			}
		}
		p = p[4+n:]
	}
	return nil
}

// readName decodes a possibly compressed domain name starting at off. It
// returns the name (in the arena) and the offset just past the name in the
// original position.
func (m *DNSMessage) readName(msg []byte, off int) ([]byte, int, error) {
	start := len(m.names)
	next := -1
	for hops := 0; ; {
		if off >= len(msg) {
			return nil, 0, ErrTruncated
		}
		l := int(msg[off])
		switch l & 0xc0 {
		case 0x00:
			if l == 0 {
				if next < 0 {
					next = off + 1
				}
				return m.names[start:len(m.names):len(m.names)], next, nil
			}
			off++
			if off+l > len(msg) {
				return nil, 0, ErrTruncated
			}
			if len(m.names) > start {
				m.names = append(m.names, '.')
			}
			for _, c := range msg[off : off+l] {
				switch {
				case 'A' <= c && c <= 'Z':
					c += 'a' - 'A'
				case c <= ' ' || c == '.' || c >= 0x7f:
					c = '?'
				}
				m.names = append(m.names, c)
			}
			if len(m.names)-start > 255 {
				return nil, 0, ErrMalformed
			}
			off += l
		case 0xc0:
			if off+1 >= len(msg) {
				return nil, 0, ErrTruncated
			}
			if next < 0 {
				next = off + 2
			}
			if hops++; hops > maxNameHops {
				return nil, 0, ErrMalformed
			}
			off = int(binary.BigEndian.Uint16(msg[off:]) & 0x3fff)
		default:
			return nil, 0, ErrMalformed // extended label types are obsolete
		}
	}
}

// DNSTypeName returns the mnemonic of a record type.
func DNSTypeName(t uint16) string {
	switch t {
	case DNSTypeA:
		return "A"
	case DNSTypeNS:
		return "NS"
	case DNSTypeCNAME:
		return "CNAME"
	case DNSTypeSOA:
		return "SOA"
	case DNSTypePTR:
		return "PTR"
	case DNSTypeMX:
		return "MX"
	case DNSTypeTXT:
		return "TXT"
	case DNSTypeAAAA:
		return "AAAA"
	case DNSTypeSRV:
		return "SRV"
	case DNSTypeDNAME:
		return "DNAME"
	case DNSTypeOPT:
		return "OPT"
	case DNSTypeSVCB:
		return "SVCB"
	case DNSTypeHTTPS:
		return "HTTPS"
	case DNSTypeANY:
		return "ANY"
	case 10:
		return "NULL"
	case 13:
		return "HINFO"
	case 43:
		return "DS"
	case 46:
		return "RRSIG"
	case 47:
		return "NSEC"
	case 48:
		return "DNSKEY"
	case 257:
		return "CAA"
	}
	return "TYPE" + strconv.Itoa(int(t))
}

// DNSRcodeName returns the mnemonic of a response code.
func DNSRcodeName(r uint8) string {
	switch r {
	case DNSRcodeNoError:
		return "NOERROR"
	case DNSRcodeFormErr:
		return "FORMERR"
	case DNSRcodeServFail:
		return "SERVFAIL"
	case DNSRcodeNXDomain:
		return "NXDOMAIN"
	case DNSRcodeNotImp:
		return "NOTIMP"
	case DNSRcodeRefused:
		return "REFUSED"
	}
	return "RCODE" + strconv.Itoa(int(r))
}

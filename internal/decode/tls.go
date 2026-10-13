package decode

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"slices"
)

const (
	maxCiphers = 128
	maxExts    = 64
	maxSigAlgs = 64
	maxGroups  = 32
)

// TLS extension types we interpret.
const (
	extServerName          uint16 = 0x0000
	extSupportedGroups     uint16 = 0x000a
	extSignatureAlgorithms uint16 = 0x000d
	extALPN                uint16 = 0x0010
	extSupportedVersions   uint16 = 0x002b
	extKeyShare            uint16 = 0x0033
	extECH                 uint16 = 0xfe0d
)

// ClientHello is the part of a TLS ClientHello that identifies where a
// connection goes and what kind of client opened it. Slices alias the input.
type ClientHello struct {
	LegacyVersion uint16
	Version       uint16 // highest version offered, GREASE excluded
	HasSNI        bool
	SNI           []byte
	ALPN          []byte // first offered protocol
	ALPNList      []byte // the raw protocol_name_list
	ECH           bool   // offers Encrypted Client Hello (SNI is then the public name)
	PQ            bool   // offers a post-quantum hybrid key exchange (ML-KEM)
	QUIC          bool   // carried in QUIC CRYPTO frames rather than TLS records

	// Non-GREASE values in the order they appear. N* counts every value
	// even past the storage capacity.
	Ciphers  [maxCiphers]uint16
	NCiphers int
	Exts     [maxExts]uint16
	NExts    int
	SigAlgs  [maxSigAlgs]uint16
	NSigAlgs int
	Groups   [maxGroups]uint16
	NGroups  int
}

// IsGREASE reports whether v is a GREASE value (RFC 8701), which clients
// sprinkle into lists to keep servers tolerant of unknown values.
func IsGREASE(v uint16) bool { return v&0x0f0f == 0x0a0a && v>>8 == v&0xff }

// TLSHandshake extracts the first handshake message from the beginning of a
// client→server TLS byte stream. A ClientHello carrying post-quantum key
// shares is larger than one TCP segment, and may even span several TLS
// records; records are concatenated into scratch when needed. It returns
// ErrTruncated while more bytes are needed and ErrMalformed if the stream
// is not TLS.
func TLSHandshake(stream, scratch []byte) ([]byte, []byte, error) {
	need := -1
	single := true
	scratch = scratch[:0]
	var first []byte
	for off := 0; ; {
		if len(stream)-off < 5 {
			return nil, scratch, ErrTruncated
		}
		h := stream[off : off+5]
		if h[0] != 0x16 || h[1] != 3 || h[2] > 4 {
			return nil, scratch, ErrMalformed
		}
		n := int(binary.BigEndian.Uint16(h[3:5]))
		if n == 0 || n > 1<<14+256 {
			return nil, scratch, ErrMalformed
		}
		if len(stream)-off-5 < n {
			return nil, scratch, ErrTruncated
		}
		frag := stream[off+5 : off+5+n]
		off += 5 + n
		if first == nil {
			first = frag
		} else {
			if single {
				scratch = append(scratch, first...)
				single = false
			}
			scratch = append(scratch, frag...)
		}
		cur := first
		if !single {
			cur = scratch
		}
		if need < 0 && len(cur) >= 4 {
			need = 4 + (int(cur[1])<<16 | int(cur[2])<<8 | int(cur[3]))
		}
		if need >= 0 && len(cur) >= need {
			return cur[:need], scratch, nil
		}
	}
}

// HandshakeLen returns the total length (header included) of the handshake
// message that starts b, or -1 if fewer than four bytes are present.
func HandshakeLen(b []byte) int {
	if len(b) < 4 {
		return -1
	}
	return 4 + (int(b[1])<<16 | int(b[2])<<8 | int(b[3]))
}

// Parse decodes a ClientHello handshake message (type 1 with its 4-byte header).
func (ch *ClientHello) Parse(hs []byte) error {
	quic := ch.QUIC
	*ch = ClientHello{QUIC: quic}
	if len(hs) < 4 {
		return ErrTruncated
	}
	if hs[0] != 1 {
		return ErrMalformed
	}
	n := HandshakeLen(hs)
	if len(hs) < n {
		return ErrTruncated
	}
	b := hs[4:n]
	if len(b) < 35 {
		return ErrMalformed
	}
	ch.LegacyVersion = binary.BigEndian.Uint16(b)
	ch.Version = ch.LegacyVersion
	p := 34
	p += 1 + int(b[p]) // session id
	if p+2 > len(b) {
		return ErrMalformed
	}
	cl := int(binary.BigEndian.Uint16(b[p:]))
	p += 2
	if cl%2 != 0 || p+cl > len(b) {
		return ErrMalformed
	}
	for i := p; i < p+cl; i += 2 {
		if v := binary.BigEndian.Uint16(b[i:]); !IsGREASE(v) {
			if ch.NCiphers < maxCiphers {
				ch.Ciphers[ch.NCiphers] = v
			}
			ch.NCiphers++
		}
	}
	p += cl
	if p >= len(b) {
		return ErrMalformed
	}
	p += 1 + int(b[p]) // compression methods
	if p > len(b) {
		return ErrMalformed
	}
	if p == len(b) {
		return nil // no extensions (SSLv3 / ancient clients)
	}
	if p+2 > len(b) {
		return ErrMalformed
	}
	el := int(binary.BigEndian.Uint16(b[p:]))
	p += 2
	if p+el > len(b) {
		return ErrMalformed
	}
	ext := b[p : p+el]
	for len(ext) >= 4 {
		typ := binary.BigEndian.Uint16(ext)
		l := int(binary.BigEndian.Uint16(ext[2:]))
		if 4+l > len(ext) {
			return ErrMalformed
		}
		body := ext[4 : 4+l]
		ext = ext[4+l:]
		if IsGREASE(typ) {
			continue
		}
		if ch.NExts < maxExts {
			ch.Exts[ch.NExts] = typ
		}
		ch.NExts++
		switch typ {
		case extServerName:
			ch.HasSNI = true
			ch.SNI = parseSNI(body)
		case extALPN:
			if len(body) >= 3 {
				list := body[2:]
				ch.ALPNList = list
				if n := int(list[0]); n > 0 && 1+n <= len(list) {
					ch.ALPN = list[1 : 1+n]
				}
			}
		case extSupportedVersions:
			if len(body) >= 1 {
				best := uint16(0)
				vs := body[1:min(len(body), 1+int(body[0]))]
				for i := 0; i+1 < len(vs); i += 2 {
					if v := binary.BigEndian.Uint16(vs[i:]); !IsGREASE(v) && versionRank(v) > versionRank(best) {
						best = v
					}
				}
				if best != 0 {
					ch.Version = best
				}
			}
		case extSignatureAlgorithms:
			ch.NSigAlgs = appendU16List(body, ch.SigAlgs[:], ch.NSigAlgs)
		case extSupportedGroups:
			ch.NGroups = appendU16List(body, ch.Groups[:], ch.NGroups)
			for i := range min(ch.NGroups, maxGroups) {
				if isPQGroup(ch.Groups[i]) {
					ch.PQ = true
				}
			}
		case extKeyShare:
			if len(body) >= 2 {
				ks := body[2:]
				for len(ks) >= 4 {
					if isPQGroup(binary.BigEndian.Uint16(ks)) {
						ch.PQ = true
					}
					kl := int(binary.BigEndian.Uint16(ks[2:]))
					if 4+kl > len(ks) {
						break
					}
					ks = ks[4+kl:]
				}
			}
		case extECH:
			ch.ECH = true
		}
	}
	return nil
}

func parseSNI(body []byte) []byte {
	if len(body) < 2 {
		return nil
	}
	list := body[2:min(len(body), 2+int(binary.BigEndian.Uint16(body)))]
	for len(list) >= 3 {
		typ, n := list[0], int(binary.BigEndian.Uint16(list[1:]))
		if 3+n > len(list) {
			return nil
		}
		if typ == 0 {
			return list[3 : 3+n]
		}
		list = list[3+n:]
	}
	return nil
}

// appendU16List decodes a 2-byte-length-prefixed list of uint16 values,
// skipping GREASE, into dst starting at n; it returns the new count.
func appendU16List(body []byte, dst []uint16, n int) int {
	if len(body) < 2 {
		return n
	}
	l := min(len(body)-2, int(binary.BigEndian.Uint16(body)))
	for i := 2; i+1 < 2+l; i += 2 {
		if v := binary.BigEndian.Uint16(body[i:]); !IsGREASE(v) {
			if n < len(dst) {
				dst[n] = v
			}
			n++
		}
	}
	return n
}

func isPQGroup(g uint16) bool {
	switch g {
	case 0x11ec, 0x11eb, 0x11ed, // X25519MLKEM768, SecP256r1MLKEM768, SecP384r1MLKEM1024
		0x0200, 0x0201, 0x0202, // ML-KEM-512/768/1024
		0x6399, 0x639a: // X25519Kyber768Draft00, SecP256r1Kyber768Draft00
		return true
	}
	return false
}

func versionRank(v uint16) int {
	switch v {
	case 0x0304:
		return 6
	case 0x0303:
		return 5
	case 0x0302:
		return 4
	case 0x0301:
		return 3
	case 0x0300:
		return 2
	case 0x0002:
		return 1
	}
	return 0
}

// TLSVersionName renders a protocol version for humans ("1.3").
func TLSVersionName(v uint16) string {
	switch v {
	case 0x0304:
		return "1.3"
	case 0x0303:
		return "1.2"
	case 0x0302:
		return "1.1"
	case 0x0301:
		return "1.0"
	case 0x0300:
		return "SSL3"
	case 0x0002:
		return "SSL2"
	}
	return ""
}

// JA4 computes the JA4 TLS client fingerprint (FoxIO, BSD-3-Clause spec):
//
//	t13d1516h2_8daaf6152771_e5627efa2ab1
//	│││ │ │ │  │            └ SHA-256/12 of sorted extensions (minus SNI, ALPN) + "_" + signature algorithms
//	│││ │ │ │  └ SHA-256/12 of the sorted cipher suites
//	│││ │ │ └ first and last character of the first ALPN value
//	│││ │ └ number of extensions
//	│││ └ number of cipher suites
//	││└ d: SNI present, i: absent
//	│└ highest TLS version offered
//	└ t: TCP, q: QUIC
func (ch *ClientHello) JA4() string {
	out := make([]byte, 0, 36)
	if ch.QUIC {
		out = append(out, 'q')
	} else {
		out = append(out, 't')
	}
	out = append(out, ja4Version(ch.Version)...)
	if ch.HasSNI {
		out = append(out, 'd')
	} else {
		out = append(out, 'i')
	}
	out = appendTwoDigits(out, ch.NCiphers)
	out = appendTwoDigits(out, ch.NExts)
	out = appendALPNChars(out, ch.ALPN)
	out = append(out, '_')

	ciphers := slices.Clone(ch.Ciphers[:min(ch.NCiphers, maxCiphers)])
	slices.Sort(ciphers)
	out = appendTruncHash(out, hexList(nil, ciphers), len(ciphers) == 0)
	out = append(out, '_')

	exts := make([]uint16, 0, maxExts)
	for _, e := range ch.Exts[:min(ch.NExts, maxExts)] {
		if e != extServerName && e != extALPN {
			exts = append(exts, e)
		}
	}
	slices.Sort(exts)
	s := hexList(nil, exts)
	if ch.NSigAlgs > 0 {
		s = append(s, '_')
		s = hexList(s, ch.SigAlgs[:min(ch.NSigAlgs, maxSigAlgs)])
	}
	return string(appendTruncHash(out, s, len(exts) == 0))
}

func ja4Version(v uint16) string {
	switch v {
	case 0x0304:
		return "13"
	case 0x0303:
		return "12"
	case 0x0302:
		return "11"
	case 0x0301:
		return "10"
	case 0x0300:
		return "s3"
	case 0x0002:
		return "s2"
	case 0xfeff:
		return "d1"
	case 0xfefd:
		return "d2"
	case 0xfefc:
		return "d3"
	}
	return "00"
}

func appendTwoDigits(b []byte, n int) []byte {
	n = min(n, 99)
	return append(b, byte('0'+n/10), byte('0'+n%10))
}

func isAlnum(c byte) bool {
	return '0' <= c && c <= '9' || 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z'
}

func appendALPNChars(b, alpn []byte) []byte {
	if len(alpn) == 0 {
		return append(b, '0', '0')
	}
	first, last := alpn[0], alpn[len(alpn)-1]
	if isAlnum(first) && isAlnum(last) {
		return append(b, first, last)
	}
	h := hex.EncodeToString(alpn)
	return append(b, h[0], h[len(h)-1])
}

func hexList(b []byte, vals []uint16) []byte {
	const digits = "0123456789abcdef"
	for i, v := range vals {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, digits[v>>12], digits[v>>8&0xf], digits[v>>4&0xf], digits[v&0xf])
	}
	return b
}

func appendTruncHash(b, s []byte, empty bool) []byte {
	if empty {
		return append(b, "000000000000"...)
	}
	sum := sha256.Sum256(s)
	return hex.AppendEncode(b, sum[:6])
}

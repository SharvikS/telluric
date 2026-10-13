package decode

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

// QUIC versions whose Initial packets we can decrypt.
const (
	QUICv1 uint32 = 0x00000001 // RFC 9000
	QUICv2 uint32 = 0x6b3343cf // RFC 9369
)

var (
	// RFC 9001 §5.2 and RFC 9369 §3.3.1.
	quicV1Salt = []byte{0x38, 0x76, 0x2c, 0xf7, 0xf5, 0x59, 0x34, 0xb3, 0x4d, 0x17, 0x9a, 0xe6, 0xa4, 0xc8, 0x0c, 0xad, 0xcc, 0xbb, 0x7f, 0x0a}
	quicV2Salt = []byte{0x0d, 0xed, 0xe3, 0xde, 0xf7, 0x00, 0xa6, 0xdb, 0x81, 0x93, 0x81, 0xbe, 0x6e, 0x26, 0x9d, 0xcb, 0xf9, 0xbd, 0x2e, 0xd9}

	// ErrNotInitial means the datagram does not start with a client Initial
	// packet of a version we know.
	ErrNotInitial = errors.New("decode: not a QUIC Initial packet")
	// ErrDecrypt means AEAD authentication failed: wrong keys or corruption.
	ErrDecrypt = errors.New("decode: QUIC Initial packet failed authentication")
)

// QUICHeader is the long header of a QUIC packet.
type QUICHeader struct {
	Version uint32
	Type    uint8 // version-independent: 0 Initial, 1 0-RTT, 2 Handshake, 3 Retry
	DCID    []byte
	SCID    []byte
	Token   []byte
	PN      uint64 // packet number (after header protection is removed)
	// PNOffset is where the packet number starts; Length counts the packet
	// number and payload.
	PNOffset int
	Length   int
}

// ParseQUICLongHeader parses the unprotected part of a long-header packet.
func ParseQUICLongHeader(b []byte) (QUICHeader, error) {
	var h QUICHeader
	if len(b) < 7 || b[0]&0x80 == 0 {
		return h, ErrNotInitial
	}
	h.Version = binary.BigEndian.Uint32(b[1:5])
	t := (b[0] >> 4) & 3
	switch h.Version {
	case QUICv1:
		h.Type = t
	case QUICv2: // v2 permutes the type bits: Initial=1, 0-RTT=2, Handshake=3, Retry=0
		h.Type = (t + 3) & 3
	default:
		return h, ErrNotInitial
	}
	p := 5
	dl := int(b[p])
	p++
	if dl > 20 || p+dl+1 > len(b) {
		return h, ErrMalformed
	}
	h.DCID = b[p : p+dl]
	p += dl
	sl := int(b[p])
	p++
	if sl > 20 || p+sl > len(b) {
		return h, ErrMalformed
	}
	h.SCID = b[p : p+sl]
	p += sl
	if h.Type != 0 { // only Initial packets carry a token
		return h, ErrNotInitial
	}
	tl, n := quicVarint(b[p:])
	if n == 0 || p+n+int(tl) > len(b) {
		return h, ErrMalformed
	}
	p += n
	h.Token = b[p : p+int(tl)]
	p += int(tl)
	l, n := quicVarint(b[p:])
	if n == 0 {
		return h, ErrMalformed
	}
	p += n
	h.PNOffset = p
	h.Length = int(l)
	if h.Length < 20 || p+h.Length > len(b) { // 1–4 bytes PN + ≥16 bytes AEAD tag
		return h, ErrMalformed
	}
	return h, nil
}

// InitialKeys are the client Initial packet protection keys for one
// connection. Anyone who sees the client's first Destination Connection ID
// can derive them; that is by design (RFC 9001 §5.2) and is what lets
// middleboxes — and Telluric — read the ClientHello of HTTP/3 connections.
type InitialKeys struct {
	version uint32
	aead    cipher.AEAD
	hp      cipher.Block
	iv      [12]byte
}

// NewInitialKeys derives the client Initial keys for dcid.
func NewInitialKeys(version uint32, dcid []byte) (*InitialKeys, error) {
	key, iv, hp, err := initialSecrets(version, dcid)
	if err != nil {
		return nil, err
	}
	k := &InitialKeys{version: version}
	copy(k.iv[:], iv)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if k.aead, err = cipher.NewGCM(block); err != nil {
		return nil, err
	}
	if k.hp, err = aes.NewCipher(hp); err != nil {
		return nil, err
	}
	return k, nil
}

// initialSecrets runs the RFC 9001 §5.2 key schedule: HKDF-Extract with the
// version's salt over the DCID, then HKDF-Expand-Label down to the client's
// packet key, IV and header-protection key.
func initialSecrets(version uint32, dcid []byte) (key, iv, hp []byte, err error) {
	salt, keyL, ivL, hpL := quicV1Salt, "quic key", "quic iv", "quic hp"
	switch version {
	case QUICv1:
	case QUICv2:
		salt, keyL, ivL, hpL = quicV2Salt, "quicv2 key", "quicv2 iv", "quicv2 hp"
	default:
		return nil, nil, nil, ErrNotInitial
	}
	initial, err := hkdf.Extract(sha256.New, dcid, salt)
	if err != nil {
		return nil, nil, nil, err
	}
	client, err := expandLabel(initial, "client in", 32)
	if err != nil {
		return nil, nil, nil, err
	}
	if key, err = expandLabel(client, keyL, 16); err != nil {
		return nil, nil, nil, err
	}
	if iv, err = expandLabel(client, ivL, 12); err != nil {
		return nil, nil, nil, err
	}
	hp, err = expandLabel(client, hpL, 16)
	return key, iv, hp, err
}

// expandLabel is HKDF-Expand-Label from TLS 1.3 (RFC 8446 §7.1) with an
// empty context.
func expandLabel(secret []byte, label string, length int) ([]byte, error) {
	full := "tls13 " + label
	info := make([]byte, 0, 4+len(full))
	info = binary.BigEndian.AppendUint16(info, uint16(length))
	info = append(info, byte(len(full)))
	info = append(info, full...)
	info = append(info, 0)
	return hkdf.Expand(sha256.New, secret, string(info), length)
}

// Open removes header protection from the Initial packet at the start of
// datagram and decrypts its payload into dst. It returns the plaintext
// frames, the parsed header and the rest of the datagram (coalesced
// packets). The datagram is not modified.
func (k *InitialKeys) Open(dst, datagram []byte) ([]byte, QUICHeader, []byte, error) {
	h, err := ParseQUICLongHeader(datagram)
	if err != nil {
		return nil, h, nil, err
	}
	if h.Version != k.version {
		return nil, h, nil, ErrNotInitial
	}
	end := h.PNOffset + h.Length
	sampleAt := h.PNOffset + 4
	if sampleAt+16 > end {
		return nil, h, nil, ErrMalformed
	}
	var mask [16]byte
	k.hp.Encrypt(mask[:], datagram[sampleAt:sampleAt+16])

	// Rebuild the header with protection removed: it is the AEAD's
	// associated data.
	first := datagram[0] ^ (mask[0] & 0x0f)
	pnLen := int(first&3) + 1
	hdr := make([]byte, 0, h.PNOffset+4)
	hdr = append(hdr, first)
	hdr = append(hdr, datagram[1:h.PNOffset]...)
	var pn uint64
	for i := range pnLen {
		b := datagram[h.PNOffset+i] ^ mask[1+i]
		hdr = append(hdr, b)
		pn = pn<<8 | uint64(b)
	}
	h.PN = pn

	var nonce [12]byte
	nonce = k.iv
	for i := range 8 {
		nonce[11-i] ^= byte(pn >> (8 * i))
	}
	plain, err := k.aead.Open(dst[:0], nonce[:], datagram[h.PNOffset+pnLen:end], hdr)
	if err != nil {
		return nil, h, nil, ErrDecrypt
	}
	return plain, h, datagram[end:], nil
}

// QUICCryptoFrames calls fn for every CRYPTO frame in decrypted Initial
// packet payload. Only frame types permitted in Initial packets are
// expected (RFC 9000 §12.4).
func QUICCryptoFrames(payload []byte, fn func(offset uint64, data []byte)) error {
	for p := 0; p < len(payload); {
		typ := payload[p]
		p++
		switch {
		case typ == 0x00 || typ == 0x01: // PADDING, PING
		case typ == 0x02 || typ == 0x03: // ACK, ACK with ECN counts
			var fields [4]uint64
			for i := range fields {
				v, n := quicVarint(payload[p:])
				if n == 0 {
					return ErrMalformed
				}
				fields[i] = v
				p += n
			}
			ranges := fields[2]
			if ranges > 256 {
				return ErrMalformed
			}
			extra := int(ranges) * 2
			if typ == 0x03 {
				extra += 3
			}
			for range extra {
				_, n := quicVarint(payload[p:])
				if n == 0 {
					return ErrMalformed
				}
				p += n
			}
		case typ == 0x06: // CRYPTO
			off, n := quicVarint(payload[p:])
			if n == 0 {
				return ErrMalformed
			}
			p += n
			l, n := quicVarint(payload[p:])
			if n == 0 || p+n+int(l) > len(payload) {
				return ErrMalformed
			}
			p += n
			fn(off, payload[p:p+int(l)])
			p += int(l)
		case typ == 0x1c: // CONNECTION_CLOSE
			for range 2 {
				_, n := quicVarint(payload[p:])
				if n == 0 {
					return ErrMalformed
				}
				p += n
			}
			l, n := quicVarint(payload[p:])
			if n == 0 || p+n+int(l) > len(payload) {
				return ErrMalformed
			}
			p += n + int(l)
		default:
			return ErrMalformed
		}
	}
	return nil
}

// quicVarint decodes a QUIC variable-length integer (RFC 9000 §16) and
// returns its value and size, or size 0 if b is too short.
func quicVarint(b []byte) (uint64, int) {
	if len(b) == 0 {
		return 0, 0
	}
	n := 1 << (b[0] >> 6)
	if len(b) < n {
		return 0, 0
	}
	v := uint64(b[0] & 0x3f)
	for _, c := range b[1:n] {
		v = v<<8 | uint64(c)
	}
	return v, n
}

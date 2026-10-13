package craft

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/binary"
)

// QUIC versions.
const (
	QUICv1 uint32 = 0x00000001
	QUICv2 uint32 = 0x6b3343cf
)

// QUICInitial describes a client Initial packet. This implementation is
// deliberately independent of the decoder's so tests can't share a bug.
type QUICInitial struct {
	Version uint32 // default QUICv1
	DCID    []byte
	SCID    []byte
	PN      uint32
	Frames  []byte // plaintext frames
	PadTo   int    // pad the datagram to this size (default 1200, the RFC minimum)
}

// CryptoFrame encodes a CRYPTO frame.
func CryptoFrame(offset uint64, data []byte) []byte {
	b := []byte{0x06}
	b = appendVarint(b, offset)
	b = appendVarint(b, uint64(len(data)))
	return append(b, data...)
}

// Bytes returns the protected packet.
func (q QUICInitial) Bytes() []byte {
	v := q.Version
	if v == 0 {
		v = QUICv1
	}
	pad := q.PadTo
	if pad == 0 {
		pad = 1200
	}
	const pnLen = 4
	typeBits := byte(0) // Initial
	salt, kl, il, hl := []byte{0x38, 0x76, 0x2c, 0xf7, 0xf5, 0x59, 0x34, 0xb3, 0x4d, 0x17, 0x9a, 0xe6, 0xa4, 0xc8, 0x0c, 0xad, 0xcc, 0xbb, 0x7f, 0x0a}, "quic key", "quic iv", "quic hp"
	if v == QUICv2 {
		typeBits = 1
		salt, kl, il, hl = []byte{0x0d, 0xed, 0xe3, 0xde, 0xf7, 0x00, 0xa6, 0xdb, 0x81, 0x93, 0x81, 0xbe, 0x6e, 0x26, 0x9d, 0xcb, 0xf9, 0xbd, 0x2e, 0xd9}, "quicv2 key", "quicv2 iv", "quicv2 hp"
	}
	initial, _ := hkdf.Extract(sha256.New, q.DCID, salt)
	client := label(initial, "client in", 32)
	key, iv, hp := label(client, kl, 16), label(client, il, 12), label(client, hl, 16)

	hdr := []byte{0xc0 | typeBits<<4 | (pnLen - 1)}
	hdr = binary.BigEndian.AppendUint32(hdr, v)
	hdr = append(hdr, byte(len(q.DCID)))
	hdr = append(hdr, q.DCID...)
	hdr = append(hdr, byte(len(q.SCID)))
	hdr = append(hdr, q.SCID...)
	hdr = append(hdr, 0) // token length
	// Size the payload so the whole datagram reaches the padding target.
	payload := append([]byte(nil), q.Frames...)
	overhead := len(hdr) + 2 + pnLen + 16
	if n := pad - overhead - len(payload); n > 0 {
		payload = append(payload, make([]byte, n)...) // PADDING frames
	}
	length := pnLen + len(payload) + 16
	hdr = append(hdr, 0x40|byte(length>>8), byte(length)) // 2-byte varint
	pnOff := len(hdr)
	hdr = binary.BigEndian.AppendUint32(hdr, q.PN)

	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	nonce := append([]byte(nil), iv...)
	for i := range 8 {
		nonce[11-i] ^= byte(uint64(q.PN) >> (8 * i))
	}
	ct := aead.Seal(nil, nonce, payload, hdr)

	hpBlock, _ := aes.NewCipher(hp)
	var mask [16]byte
	hpBlock.Encrypt(mask[:], ct[4-pnLen:4-pnLen+16])
	hdr[0] ^= mask[0] & 0x0f
	for i := range pnLen {
		hdr[pnOff+i] ^= mask[1+i]
	}
	return append(hdr, ct...)
}

func label(secret []byte, l string, n int) []byte {
	full := "tls13 " + l
	info := binary.BigEndian.AppendUint16(nil, uint16(n))
	info = append(info, byte(len(full)))
	info = append(info, full...)
	info = append(info, 0)
	out, _ := hkdf.Expand(sha256.New, secret, string(info), n)
	return out
}

func appendVarint(b []byte, v uint64) []byte {
	switch {
	case v < 1<<6:
		return append(b, byte(v))
	case v < 1<<14:
		return append(b, 0x40|byte(v>>8), byte(v))
	case v < 1<<30:
		return append(b, 0x80|byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
	}
	return append(b, 0xc0|byte(v>>56), byte(v>>48), byte(v>>40), byte(v>>32), byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}

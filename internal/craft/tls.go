package craft

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"time"
)

// TLSClientHello returns the first TLS record a crypto/tls client sends for
// cfg: a real ClientHello, with GREASE-free Go defaults including the
// X25519MLKEM768 post-quantum key share.
func TLSClientHello(cfg *tls.Config) ([]byte, error) {
	c, s := net.Pipe()
	defer c.Close()
	defer s.Close()
	go func() { _ = tls.Client(c, cfg).Handshake() }()
	_ = s.SetReadDeadline(time.Now().Add(5 * time.Second))
	hdr := make([]byte, 5)
	if _, err := io.ReadFull(s, hdr); err != nil {
		return nil, err
	}
	if hdr[0] != 0x16 {
		return nil, errors.New("craft: client did not start with a handshake record")
	}
	body := make([]byte, binary.BigEndian.Uint16(hdr[3:5]))
	if _, err := io.ReadFull(s, body); err != nil {
		return nil, err
	}
	return append(hdr, body...), nil
}

// QUICClientHello returns the ClientHello handshake message a crypto/tls
// QUIC client produces for cfg (carried in CRYPTO frames, no record layer).
func QUICClientHello(cfg *tls.Config) ([]byte, error) {
	c := cfg.Clone()
	if c.MinVersion < tls.VersionTLS13 {
		c.MinVersion = tls.VersionTLS13
	}
	qc := tls.QUICClient(&tls.QUICConfig{TLSConfig: c})
	// A plausible transport parameter block: max_idle_timeout,
	// initial_max_data, initial_max_streams_bidi.
	qc.SetTransportParameters([]byte{0x01, 0x04, 0x80, 0x00, 0x75, 0x30, 0x04, 0x04, 0x80, 0xf0, 0x00, 0x00, 0x08, 0x02, 0x40, 0x64})
	if err := qc.Start(context.Background()); err != nil {
		return nil, err
	}
	defer qc.Close()
	var hello []byte
	for {
		ev := qc.NextEvent()
		switch ev.Kind {
		case tls.QUICNoEvent:
			if len(hello) == 0 {
				return nil, errors.New("craft: QUIC client produced no ClientHello")
			}
			return hello, nil
		case tls.QUICWriteData:
			if ev.Level == tls.QUICEncryptionLevelInitial {
				hello = append(hello, ev.Data...)
			}
		}
	}
}

// SplitSegments cuts a byte stream into TCP-sized pieces.
func SplitSegments(stream []byte, mss int) [][]byte {
	var out [][]byte
	for len(stream) > mss {
		out = append(out, stream[:mss])
		stream = stream[mss:]
	}
	return append(out, stream)
}

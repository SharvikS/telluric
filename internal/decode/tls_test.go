package decode

import (
	"bytes"
	"crypto/tls"
	"encoding/hex"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/craft"
)

func mustHex(s string) []byte {
	b, err := hex.DecodeString(strings.ReplaceAll(s, " ", ""))
	if err != nil {
		panic(err)
	}
	return b
}

func goClientHello(t testing.TB, sni string, alpn ...string) []byte {
	t.Helper()
	rec, err := craft.TLSClientHello(&tls.Config{ServerName: sni, NextProtos: alpn})
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func TestClientHelloFromCryptoTLS(t *testing.T) {
	rec := goClientHello(t, "www.youtube.com", "h2", "http/1.1")
	hs, _, err := TLSHandshake(rec, nil)
	if err != nil {
		t.Fatal(err)
	}
	var ch ClientHello
	if err := ch.Parse(hs); err != nil {
		t.Fatal(err)
	}
	if string(ch.SNI) != "www.youtube.com" || !ch.HasSNI || string(ch.ALPN) != "h2" {
		t.Fatalf("sni=%q alpn=%q", ch.SNI, ch.ALPN)
	}
	if ch.Version != 0x0304 || ch.LegacyVersion != 0x0303 || TLSVersionName(ch.Version) != "1.3" {
		t.Fatalf("version %#x legacy %#x", ch.Version, ch.LegacyVersion)
	}
	if !ch.PQ {
		t.Fatal("Go ≥1.24 offers X25519MLKEM768 by default; PQ not detected")
	}
	if ja4 := ch.JA4(); !strings.HasPrefix(ja4, "t13d") || !strings.Contains(ja4, "h2_") || len(ja4) != 36 {
		t.Fatalf("ja4 = %q", ja4)
	}
}

func TestClientHelloAcrossSegmentsAndRecords(t *testing.T) {
	rec := goClientHello(t, "api.anthropic.com", "h2")
	if len(rec) < 1300 {
		t.Fatalf("expected a post-quantum sized ClientHello, got %d bytes", len(rec))
	}

	// Two TCP segments, delivered out of order.
	segs := craft.SplitSegments(rec, 1000)
	a := NewAssembler(16 << 10)
	a.Add(1000, segs[1])
	if _, _, err := TLSHandshake(a.Prefix(), nil); err != ErrTruncated {
		t.Fatalf("with only the second segment: %v", err)
	}
	a.Add(0, segs[0])
	hs, _, err := TLSHandshake(a.Prefix(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var ch ClientHello
	if err := ch.Parse(hs); err != nil || string(ch.SNI) != "api.anthropic.com" {
		t.Fatalf("err=%v sni=%q", err, ch.SNI)
	}

	// The same handshake split into two TLS records.
	body := rec[5:]
	r1 := append([]byte{0x16, 3, 1, 0x02, 0x00}, body[:512]...)
	rest := body[512:]
	r2 := append([]byte{0x16, 3, 1, byte(len(rest) >> 8), byte(len(rest))}, rest...)
	hs2, _, err := TLSHandshake(append(r1, r2...), nil)
	if err != nil || !bytes.Equal(hs2, hs) {
		t.Fatalf("multi-record reassembly: err=%v equal=%v", err, bytes.Equal(hs2, hs))
	}
}

func TestTLSHandshakeRejectsNonTLS(t *testing.T) {
	if _, _, err := TLSHandshake([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), nil); err != ErrMalformed {
		t.Fatalf("HTTP parsed as TLS: %v", err)
	}
}

func TestJA4KnownVector(t *testing.T) {
	// Hand-built hello: ciphers {GREASE, 1301, 1302, 1303, c02b}, extensions
	// {GREASE, SNI, ALPN "h2", supported_versions [GREASE, 1.3, 1.2],
	// signature_algorithms [0403, 0804], supported_groups [001d]}.
	hs := buildHello(
		[]uint16{0x0a0a, 0x1301, 0x1302, 0x1303, 0xc02b},
		[][]byte{
			ext(0x3a3a, nil),
			ext(0x0000, sniBody("example.com")),
			ext(0x0010, []byte{0, 3, 2, 'h', '2'}),
			ext(0x002b, []byte{6, 0x5a, 0x5a, 3, 4, 3, 3}),
			ext(0x000d, []byte{0, 4, 4, 3, 8, 4}),
			ext(0x000a, []byte{0, 2, 0, 0x1d}),
		})
	var ch ClientHello
	if err := ch.Parse(hs); err != nil {
		t.Fatal(err)
	}
	// a: t, 13, d, 04 ciphers, 05 extensions, h2.
	// b: sha256("1301,1302,1303,c02b")[:12]
	// c: sha256("000a,000d,002b_0403,0804")[:12]
	want := "t13d0405h2_" + trunc("1301,1302,1303,c02b") + "_" + trunc("000a,000d,002b_0403,0804")
	if got := ch.JA4(); got != want {
		t.Fatalf("JA4 = %s, want %s", got, want)
	}
	ch.ALPN = []byte{0xab, 0xcd} // non-alphanumeric ALPN uses the hex form
	if got := ch.JA4()[8:10]; got != "ad" {
		t.Fatalf("hex ALPN chars = %q", got)
	}
}

func trunc(s string) string { return string(appendTruncHash(nil, []byte(s), false)) }

func ext(typ uint16, body []byte) []byte {
	return append([]byte{byte(typ >> 8), byte(typ), byte(len(body) >> 8), byte(len(body))}, body...)
}

func sniBody(name string) []byte {
	entry := append([]byte{0, byte(len(name) >> 8), byte(len(name))}, name...)
	return append([]byte{byte(len(entry) >> 8), byte(len(entry))}, entry...)
}

func buildHello(ciphers []uint16, exts [][]byte) []byte {
	body := []byte{3, 3}
	body = append(body, make([]byte, 32)...)
	body = append(body, 0) // session id
	body = append(body, byte(len(ciphers)*2>>8), byte(len(ciphers)*2))
	for _, c := range ciphers {
		body = append(body, byte(c>>8), byte(c))
	}
	body = append(body, 1, 0) // null compression
	var e []byte
	for _, x := range exts {
		e = append(e, x...)
	}
	body = append(body, byte(len(e)>>8), byte(len(e)))
	body = append(body, e...)
	return append([]byte{1, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body))}, body...)
}

func TestQUICInitialKeysRFCVectors(t *testing.T) {
	dcid := mustHex("8394c8f03e515708")
	for _, tc := range []struct {
		version     uint32
		key, iv, hp string
	}{
		{QUICv1, "1f369613dd76d5467730efcbe3b1a22d", "fa044b2f42a3fd3b46fb255c", "9f50449e04a0e810283a1e9933adedd2"}, // RFC 9001 A.1
		{QUICv2, "8b1a0bc121284290a29e0971b5cd045d", "91f73e2351d8fa91660e909f", "45b95e15235d6f45a6b19cbcb0294ba9"}, // RFC 9369 A.1
	} {
		key, iv, hp, err := initialSecrets(tc.version, dcid)
		if err != nil {
			t.Fatal(err)
		}
		if got := hex.EncodeToString(key); got != tc.key {
			t.Errorf("v%#x key = %s, want %s", tc.version, got, tc.key)
		}
		if got := hex.EncodeToString(iv); got != tc.iv {
			t.Errorf("v%#x iv = %s, want %s", tc.version, got, tc.iv)
		}
		if got := hex.EncodeToString(hp); got != tc.hp {
			t.Errorf("v%#x hp = %s, want %s", tc.version, got, tc.hp)
		}
	}

	// RFC 9001 A.2: header protection mask for the client Initial.
	k, _ := NewInitialKeys(QUICv1, dcid)
	var mask [16]byte
	k.hp.Encrypt(mask[:], mustHex("d1b1c98dd7689fb8ec11d242b123dc9b"))
	if got := hex.EncodeToString(mask[:5]); got != "437b9aec36" {
		t.Fatalf("header protection mask = %s, want 437b9aec36", got)
	}
}

// quicHello builds a QUIC ClientHello with crypto/tls and wraps it the way
// Chrome does: split into CRYPTO frames shuffled inside the Initial packet.
func quicHello(t testing.TB, version uint32, sni string) ([]byte, []byte) {
	t.Helper()
	hello, err := craft.QUICClientHello(&tls.Config{ServerName: sni, NextProtos: []string{"h3"}})
	if err != nil {
		t.Fatal(err)
	}
	third := len(hello) / 3
	frames := append(craft.CryptoFrame(uint64(2*third), hello[2*third:]), 0x01) // PING
	frames = append(frames, craft.CryptoFrame(0, hello[:third])...)
	frames = append(frames, craft.CryptoFrame(uint64(third), hello[third:2*third])...)
	dcid := mustHex("4f2a9c0de81b77a1")
	pkt := craft.QUICInitial{Version: version, DCID: dcid, SCID: []byte{1, 2, 3, 4}, PN: 0, Frames: frames, PadTo: max(1200, len(hello)+100)}.Bytes()
	return pkt, hello
}

func TestQUICInitialDecryptAndReassemble(t *testing.T) {
	for _, v := range []uint32{QUICv1, QUICv2} {
		pkt, hello := quicHello(t, v, "www.google.com")
		h, err := ParseQUICLongHeader(pkt)
		if err != nil || h.Type != 0 || h.Version != v {
			t.Fatalf("v%#x header: %+v %v", v, h, err)
		}
		keys, err := NewInitialKeys(v, h.DCID)
		if err != nil {
			t.Fatal(err)
		}
		plain, hdr, rest, err := keys.Open(nil, pkt)
		if err != nil {
			t.Fatalf("v%#x open: %v", v, err)
		}
		if hdr.PN != 0 || len(rest) != 0 {
			t.Fatalf("pn=%d rest=%d", hdr.PN, len(rest))
		}
		a := NewAssembler(16 << 10)
		if err := QUICCryptoFrames(plain, func(off uint64, data []byte) { a.Add(int(off), data) }); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a.Prefix(), hello) {
			t.Fatalf("v%#x: reassembled %d bytes, want %d", v, len(a.Prefix()), len(hello))
		}
		ch := ClientHello{QUIC: true}
		if err := ch.Parse(a.Prefix()); err != nil {
			t.Fatal(err)
		}
		if string(ch.SNI) != "www.google.com" || string(ch.ALPN) != "h3" || !strings.HasPrefix(ch.JA4(), "q13d") {
			t.Fatalf("sni=%q alpn=%q ja4=%s", ch.SNI, ch.ALPN, ch.JA4())
		}

		// Tampering must fail authentication.
		bad := bytes.Clone(pkt)
		bad[len(bad)-1] ^= 1
		if _, _, _, err := keys.Open(nil, bad); err != ErrDecrypt {
			t.Fatalf("tampered packet: %v", err)
		}
	}
}

// TestJA4MatchesWireshark writes Go-generated TLS and QUIC ClientHellos to a
// capture and checks our SNI and JA4 against Wireshark's dissectors, which
// independently decrypt the QUIC Initial and compute JA4.
func TestJA4MatchesWireshark(t *testing.T) {
	tshark, err := exec.LookPath("tshark")
	if err != nil {
		t.Skip("tshark not installed")
	}
	me := netip.MustParseAddr("192.168.29.35")
	srv := netip.MustParseAddr("142.250.183.14")
	rec := goClientHello(t, "www.youtube.com", "h2", "http/1.1")
	quic, _ := quicHello(t, QUICv1, "rr3---sn-cvh7knzl.googlevideo.com")

	var ours []string
	var ch ClientHello
	hs, _, _ := TLSHandshake(rec, nil)
	ch.Parse(hs)
	ours = append(ours, string(ch.SNI)+"|"+ch.JA4())
	keys, _ := NewInitialKeys(QUICv1, mustHex("4f2a9c0de81b77a1"))
	plain, _, _, err := keys.Open(nil, quic)
	if err != nil {
		t.Fatal(err)
	}
	a := NewAssembler(16 << 10)
	QUICCryptoFrames(plain, func(off uint64, d []byte) { a.Add(int(off), d) })
	ch = ClientHello{QUIC: true}
	ch.Parse(a.Prefix())
	ours = append(ours, string(ch.SNI)+"|"+ch.JA4())

	path := filepath.Join(t.TempDir(), "hello.pcap")
	pcap := writeRawPcap(t, path,
		craft.TCP{Src: me, Dst: srv, SrcPort: 51234, DstPort: 443, Seq: 1, Flags: craft.SYN, Options: craft.SYNOptions(1460, 7)}.Packet(),
		craft.TCP{Src: srv, Dst: me, SrcPort: 443, DstPort: 51234, Seq: 100, Ack: 2, Flags: craft.SYN | craft.ACK}.Packet(),
		craft.TCP{Src: me, Dst: srv, SrcPort: 51234, DstPort: 443, Seq: 2, Ack: 101, Flags: craft.ACK | craft.PSH, Payload: rec}.Packet(),
		craft.UDP{Src: me, Dst: srv, SrcPort: 50000, DstPort: 443, Payload: quic}.Packet(),
	)
	out, err := exec.Command(tshark, "-r", pcap, "-Y", "tls.handshake.type == 1",
		"-T", "fields", "-E", "separator=|", "-e", "tls.handshake.extensions_server_name", "-e", "tls.handshake.ja4").CombinedOutput()
	if err != nil {
		t.Fatalf("tshark: %v\n%s", err, out)
	}
	theirs := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i, line := range theirs {
		// Wireshark before 4.4 labelled QUIC JA4 fingerprints "u…"; the JA4
		// specification (and current Wireshark) uses "q".
		if sni, ja4, ok := strings.Cut(line, "|"); ok && strings.HasPrefix(ja4, "u") {
			theirs[i] = sni + "|q" + ja4[1:]
		}
	}
	if len(theirs) != 2 {
		t.Fatalf("tshark found %d ClientHellos:\n%s", len(theirs), out)
	}
	for i := range ours {
		if ours[i] != theirs[i] {
			t.Errorf("hello %d:\n ours      %s\n wireshark %s", i, ours[i], theirs[i])
		}
	}
}

func writeRawPcap(t *testing.T, path string, packets ...[]byte) string {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w, err := capture.NewWriter(f, capture.LinkRaw, 65535)
	if err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC).UnixNano()
	for i, p := range packets {
		w.WritePacket(ts+int64(i)*int64(time.Millisecond), p, uint32(len(p)))
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	return path
}

func FuzzClientHello(f *testing.F) {
	rec := goClientHello(f, "fuzz.example", "h2")
	f.Add(rec)
	f.Fuzz(func(t *testing.T, b []byte) {
		hs, _, err := TLSHandshake(b, nil)
		if err != nil {
			return
		}
		var ch ClientHello
		if ch.Parse(hs) == nil {
			_ = ch.JA4()
		}
	})
}

func FuzzQUICFrames(f *testing.F) {
	f.Add(append(craft.CryptoFrame(0, []byte{1, 0, 0, 1, 0}), 0, 0, 1, 2, 0, 0, 0, 0))
	f.Fuzz(func(t *testing.T, b []byte) {
		_ = QUICCryptoFrames(b, func(uint64, []byte) {})
		if h, err := ParseQUICLongHeader(b); err == nil && h.PNOffset+h.Length > len(b) {
			t.Fatal("header length exceeds datagram")
		}
	})
}

func BenchmarkQUICInitialOpen(b *testing.B) {
	pkt, _ := quicHello(b, QUICv1, "www.google.com")
	keys, _ := NewInitialKeys(QUICv1, mustHex("4f2a9c0de81b77a1"))
	buf := make([]byte, 0, 2048)
	b.ReportAllocs()
	b.SetBytes(int64(len(pkt)))
	for b.Loop() {
		if _, _, _, err := keys.Open(buf, pkt); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkClientHelloParseJA4(b *testing.B) {
	rec := goClientHello(b, "www.youtube.com", "h2", "http/1.1")
	hs, _, _ := TLSHandshake(rec, nil)
	var ch ClientHello
	b.ReportAllocs()
	for b.Loop() {
		ch.Parse(hs)
		_ = ch.JA4()
	}
}

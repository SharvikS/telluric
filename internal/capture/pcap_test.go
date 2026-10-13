package capture

import (
	"bytes"
	"encoding/binary"
	"io"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/SharvikS/telluric/internal/craft"
)

var (
	me   = netip.MustParseAddr("192.168.29.35")
	them = netip.MustParseAddr("142.250.183.14")
	me6  = netip.MustParseAddr("2405:201:1d:5111::35")
	cf6  = netip.MustParseAddr("2606:4700::6810:84e5")
)

func sampleFrames() []Frame {
	t0 := time.Date(2026, 10, 13, 12, 0, 0, 123456789, time.UTC).UnixNano()
	syn := craft.TCP{Src: me, Dst: them, SrcPort: 51234, DstPort: 443, Seq: 1, Flags: craft.SYN, Options: craft.SYNOptions(1460, 7)}.Packet()
	synack := craft.TCP{Src: them, Dst: me, SrcPort: 443, DstPort: 51234, Seq: 9, Ack: 2, Flags: craft.SYN | craft.ACK}.Packet()
	quic := craft.UDP{Src: me6, Dst: cf6, SrcPort: 40000, DstPort: 443, Payload: bytes.Repeat([]byte{0xc0}, 1200)}.Packet()
	mac := [8]byte{0x3c, 0x05, 0xc8, 0x56, 0x26, 0x42}
	return []Frame{
		{TS: t0, Ifindex: 3, PktType: PacketOutgoing, Proto: 0x0800, HAType: ARPHRDEther, HALen: 6, HAddr: mac, WireLen: uint32(len(syn)), Data: syn},
		{TS: t0 + 41_700_000, Ifindex: 3, PktType: PacketHost, Proto: 0x0800, HAType: ARPHRDEther, HALen: 6, WireLen: uint32(len(synack)), Data: synack},
		{TS: t0 + 50_000_000, Ifindex: 3, PktType: PacketOutgoing, Proto: 0x86dd, HAType: ARPHRDEther, HALen: 6, HAddr: mac, WireLen: 3000, Data: quic},
	}
}

func readAll(t *testing.T, r io.Reader) []Frame {
	t.Helper()
	rd, err := NewReader(r)
	if err != nil {
		t.Fatal(err)
	}
	var out []Frame
	for {
		var f Frame
		err := rd.Next(&f)
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		f.Data = bytes.Clone(f.Data)
		out = append(out, f)
	}
}

func sameFrame(t *testing.T, got, want Frame, checkIfindex bool) {
	t.Helper()
	if got.TS != want.TS || got.Proto != want.Proto || got.PktType != want.PktType || got.WireLen != want.WireLen || !bytes.Equal(got.Data, want.Data) {
		t.Fatalf("frame mismatch:\n got  ts=%d proto=%#x type=%d wire=%d len=%d\n want ts=%d proto=%#x type=%d wire=%d len=%d",
			got.TS, got.Proto, got.PktType, got.WireLen, len(got.Data), want.TS, want.Proto, want.PktType, want.WireLen, len(want.Data))
	}
	if checkIfindex && (got.Ifindex != want.Ifindex || got.HAddr != want.HAddr || got.HAType != want.HAType) {
		t.Fatalf("metadata mismatch: got if=%d addr=%x ha=%d want if=%d addr=%x ha=%d",
			got.Ifindex, got.HAddr, got.HAType, want.Ifindex, want.HAddr, want.HAType)
	}
}

func TestPcapSLL2RoundTrip(t *testing.T) {
	var buf bytes.Buffer
	w, err := NewWriter(&buf, LinkLinuxSLL2, 4096)
	if err != nil {
		t.Fatal(err)
	}
	want := sampleFrames()
	for i := range want {
		if err := w.WriteFrame(&want[i]); err != nil {
			t.Fatal(err)
		}
	}
	w.Flush()
	got := readAll(t, &buf)
	if len(got) != len(want) {
		t.Fatalf("got %d frames, want %d", len(got), len(want))
	}
	for i := range want {
		sameFrame(t, got[i], want[i], true)
	}
}

func TestPcapngRoundTripWithStats(t *testing.T) {
	var buf bytes.Buffer
	w, err := NewNGWriter(&buf, 4096)
	if err != nil {
		t.Fatal(err)
	}
	want := sampleFrames()
	for i := range want {
		if err := w.WriteFrame(&want[i]); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.WriteStats(want[2].TS, 3, 17); err != nil {
		t.Fatal(err)
	}
	w.Flush()

	rd, err := NewReader(&buf)
	if err != nil {
		t.Fatal(err)
	}
	for i := range want {
		var f Frame
		if err := rd.Next(&f); err != nil {
			t.Fatal(err)
		}
		sameFrame(t, f, want[i], true)
	}
	var f Frame
	if err := rd.Next(&f); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
	if rd.IfDrop != 17 {
		t.Fatalf("interface drops = %d, want 17", rd.IfDrop)
	}
}

func TestLinkTypes(t *testing.T) {
	ip := craft.UDP{Src: me, Dst: them, SrcPort: 5353, DstPort: 53, Payload: []byte("q")}.Packet()
	src := [6]byte{0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}
	sll1 := make([]byte, 16)
	binary.BigEndian.PutUint16(sll1[0:], uint16(PacketOutgoing))
	binary.BigEndian.PutUint16(sll1[2:], ARPHRDEther)
	binary.BigEndian.PutUint16(sll1[4:], 6)
	copy(sll1[6:], src[:])
	binary.BigEndian.PutUint16(sll1[14:], 0x0800)
	null := []byte{2, 0, 0, 0}
	loop := []byte{0, 0, 0, 2}

	cases := []struct {
		link uint32
		data []byte
		pkt  uint8
	}{
		{LinkEthernet, craft.Ethernet([6]byte{1, 2, 3, 4, 5, 6}, src, 0x0800, ip), PacketUnknown},
		{LinkLinuxSLL, append(sll1, ip...), PacketOutgoing},
		{LinkRaw, ip, PacketUnknown},
		{LinkIPv4, ip, PacketUnknown},
		{LinkNull, append(null, ip...), PacketUnknown},
		{LinkLoop, append(loop, ip...), PacketUnknown},
	}
	for _, c := range cases {
		var buf bytes.Buffer
		w, _ := NewWriter(&buf, c.link, 65535)
		w.WritePacket(1e9, c.data, uint32(len(c.data)))
		w.Flush()
		got := readAll(t, &buf)
		if len(got) != 1 {
			t.Fatalf("link %d: %d frames", c.link, len(got))
		}
		f := got[0]
		if f.Proto != 0x0800 || !bytes.Equal(f.Data, ip) || f.WireLen != uint32(len(ip)) || f.PktType != c.pkt {
			t.Fatalf("link %d: proto=%#x len=%d wire=%d type=%d", c.link, f.Proto, len(f.Data), f.WireLen, f.PktType)
		}
		if c.link == LinkEthernet && [6]byte(f.HAddr[:6]) != src {
			t.Fatalf("ethernet source address %x", f.HAddr)
		}
	}
}

func TestUnsupportedRecordsAreSkipped(t *testing.T) {
	var buf bytes.Buffer
	w, _ := NewWriter(&buf, LinkEthernet, 65535)
	w.WritePacket(1, craft.Ethernet([6]byte{}, [6]byte{}, 0x0026, make([]byte, 38)), 52) // 802.3 length: LLC frame
	ip := craft.UDP{Src: me, Dst: them, SrcPort: 1, DstPort: 2}.Packet()
	w.WritePacket(2, craft.Ethernet([6]byte{}, [6]byte{}, 0x0800, ip), 0)
	w.Flush()
	rd, _ := NewReader(&buf)
	var f Frame
	if err := rd.Next(&f); err != nil || f.TS != 2 || rd.Skipped != 1 {
		t.Fatalf("err=%v ts=%d skipped=%d", err, f.TS, rd.Skipped)
	}
}

func TestStreamDeliversBatchesAndEOF(t *testing.T) {
	var buf bytes.Buffer
	w, _ := NewNGWriter(&buf, 4096)
	want := sampleFrames()
	for range 400 {
		for i := range want {
			w.WriteFrame(&want[i])
		}
	}
	w.Flush()
	s, err := NewStream(&buf, StreamOptions{Name: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	n := 0
	for {
		err := s.Read(time.Second, func(f *Frame) {
			sameFrame(t, *f, want[n%3], true)
			n++
		})
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if n != 1200 || s.Stats().Received != 1200 {
		t.Fatalf("delivered %d, stats %d", n, s.Stats().Received)
	}
}

func TestStreamRealtimeRebases(t *testing.T) {
	var buf bytes.Buffer
	w, _ := NewWriter(&buf, LinkLinuxSLL2, 4096)
	frames := sampleFrames() // spans 50 ms
	for i := range frames {
		w.WriteFrame(&frames[i])
	}
	w.Flush()
	start := time.Now()
	s, err := NewStream(&buf, StreamOptions{Realtime: true, Rebase: true})
	if err != nil {
		t.Fatal(err)
	}
	var ts []int64
	for {
		err := s.Read(time.Second, func(f *Frame) { ts = append(ts, f.TS) })
		if err == io.EOF {
			break
		}
	}
	if el := time.Since(start); el < 45*time.Millisecond {
		t.Fatalf("replay took %v, want ≥ 50ms of pacing", el)
	}
	if d := time.Duration(ts[0] - start.UnixNano()); d < -time.Second || d > time.Second {
		t.Fatalf("first timestamp not rebased to now: off by %v", d)
	}
	if ts[2]-ts[0] != 50_000_000 {
		t.Fatalf("relative spacing changed: %d", ts[2]-ts[0])
	}
}

// TestWiresharkReadsHelperOutput feeds our pcapng writer's output to tshark,
// proving the helper's stream is valid for third-party tools.
func TestWiresharkReadsHelperOutput(t *testing.T) {
	tshark, err := exec.LookPath("tshark")
	if err != nil {
		t.Skip("tshark not installed")
	}
	path := filepath.Join(t.TempDir(), "helper.pcapng")
	f, _ := os.Create(path)
	w, _ := NewNGWriter(f, 4096)
	frames := sampleFrames()
	for i := range frames {
		w.WriteFrame(&frames[i])
	}
	w.WriteStats(frames[2].TS, 3, 0)
	w.Flush()
	f.Close()

	out, err := exec.Command(tshark, "-r", path, "-T", "fields", "-E", "separator=|",
		"-e", "sll.pkttype", "-e", "sll.ifindex", "-e", "ip.src", "-e", "ipv6.src", "-e", "tcp.dstport", "-e", "udp.dstport", "-e", "tcp.flags.syn").CombinedOutput()
	if err != nil {
		t.Fatalf("tshark: %v\n%s", err, out)
	}
	// tshark ≥ 4.6 prints booleans as True/False, older versions as 1/0.
	norm := strings.NewReplacer("True", "1", "False", "0").Replace(strings.TrimSpace(string(out)))
	lines := strings.Split(norm, "\n")
	want := []string{
		"4|3|192.168.29.35||443||1",
		"0|3|142.250.183.14||51234||1",
		"4|3||2405:201:1d:5111::35||443|",
	}
	if len(lines) != len(want) {
		t.Fatalf("tshark saw %d packets:\n%s", len(lines), out)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("packet %d: tshark says %q, want %q", i, lines[i], want[i])
		}
	}
}

func FuzzReader(f *testing.F) {
	var a, b bytes.Buffer
	w, _ := NewWriter(&a, LinkLinuxSLL2, 4096)
	ng, _ := NewNGWriter(&b, 4096)
	for _, fr := range sampleFrames() {
		w.WriteFrame(&fr)
		ng.WriteFrame(&fr)
	}
	ng.WriteStats(1, 1, 1)
	w.Flush()
	ng.Flush()
	f.Add(a.Bytes())
	f.Add(b.Bytes())
	f.Fuzz(func(t *testing.T, data []byte) {
		rd, err := NewReader(bytes.NewReader(data))
		if err != nil {
			return
		}
		var fr Frame
		for range 1000 {
			if rd.Next(&fr) != nil {
				return
			}
			if int(fr.WireLen) < 0 {
				t.Fatal("negative length")
			}
		}
	})
}

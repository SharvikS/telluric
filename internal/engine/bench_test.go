package engine

import (
	"fmt"
	"net/netip"
	"testing"
	"time"

	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/craft"
	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/geo"
)

// benchFrames builds a realistic mix: established TCP flows moving data in
// both directions across many remote hosts, plus some QUIC.
func benchFrames(flows int) []capture.Frame {
	var frames []capture.Frame
	now := time.Now().UnixNano()
	for i := range flows {
		remote := netip.AddrFrom4([4]byte{142, 250, byte(i >> 8), byte(i)})
		lport := uint16(30000 + i)
		var pkt []byte
		out := i%4 == 0
		if i%5 == 0 {
			pkt = craft.UDP{Src: remote, Dst: me, SrcPort: 443, DstPort: lport, Payload: make([]byte, 1200)}.Packet()
		} else if out {
			pkt = craft.TCP{Src: me, Dst: remote, SrcPort: lport, DstPort: 443, Seq: 1, Ack: 1, Flags: craft.ACK}.Packet()
		} else {
			pkt = craft.TCP{Src: remote, Dst: me, SrcPort: 443, DstPort: lport, Seq: 1, Ack: 1, Flags: craft.ACK | craft.PSH, Payload: make([]byte, 1400)}.Packet()
		}
		pt := capture.PacketHost
		if out {
			pt = capture.PacketOutgoing
		}
		frames = append(frames, capture.Frame{TS: now, Proto: decode.EtherTypeIPv4, PktType: pt, WireLen: uint32(len(pkt)), Data: pkt})
	}
	return frames
}

// BenchmarkEngineHotPath measures the per-packet cost of the whole engine
// path for packets of already-known flows — the steady state of a busy link.
func BenchmarkEngineHotPath(b *testing.B) {
	for _, n := range []int{100, 2000} {
		b.Run(fmt.Sprintf("flows=%d", n), func(b *testing.B) {
			frames := benchFrames(n)
			e := New(Config{Source: &sliceSource{}, Locator: fakeLocator{}, Home: geo.Home{}})
			for i := range frames { // warm: create every flow once
				e.handleFrame(&frames[i])
			}
			b.ReportAllocs()
			b.ResetTimer()
			i := 0
			for b.Loop() {
				f := &frames[i]
				f.TS += 1000
				e.handleFrame(f)
				if i++; i == len(frames) {
					i = 0
					e.shots.reset() // a 50 ms frame boundary
				}
			}
			b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N), "ns/pkt")
		})
	}
}

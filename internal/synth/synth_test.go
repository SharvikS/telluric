package synth

import (
	"testing"
	"time"

	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/decode"
)

// TestDemoWorldDecodes runs the generator for a while and checks that every
// frame it produces decodes and that the world is busy and varied.
func TestDemoWorldDecodes(t *testing.T) {
	s := New(42)
	var p decode.Packet
	frames, bad, arp := 0, 0, 0
	remotes := map[string]bool{}
	deadline := time.Now().Add(2500 * time.Millisecond)
	for time.Now().Before(deadline) {
		err := s.Read(50*time.Millisecond, func(f *capture.Frame) {
			frames++
			if f.WireLen < uint32(len(f.Data)) {
				t.Errorf("wire length %d < captured %d", f.WireLen, len(f.Data))
			}
			if err := p.Decode(f.Proto, f.Data); err != nil {
				bad++
				return
			}
			if p.Has(decode.LayerARP) {
				arp++
				return
			}
			if f.PktType == capture.PacketOutgoing {
				remotes[p.Dst.String()] = true
			}
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if bad > 0 {
		t.Fatalf("%d of %d frames failed to decode", bad, frames)
	}
	if frames < 200 || len(remotes) < 6 {
		t.Fatalf("a quiet world: %d frames to %d destinations", frames, len(remotes))
	}
}

func TestLocatorCoversEveryService(t *testing.T) {
	l := NewLocator()
	for _, sv := range allServices() {
		if loc, ok := l.Locate(sv.ip); !ok || !loc.HasCoord || loc.City == "" {
			t.Errorf("%s (%s) not located", sv.name, sv.ip)
		}
	}
}

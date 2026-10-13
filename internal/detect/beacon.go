package detect

import (
	"fmt"
	"math"
	"net/netip"
	"slices"

	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/event"
)

// Beaconing is how implants phone home: a new connection to the same place
// at a near-constant interval. Following RITA's approach, the regularity of
// connection start times is measured robustly — median interval, median
// absolute deviation (jitter) and Bowley skewness — so a single late
// connection doesn't hide a beacon and humans' bursty browsing doesn't
// look like one.

type beaconKey struct {
	proto uint8
	ip    netip.Addr
	port  uint16
}

type beaconTrack struct {
	starts   []int64
	reported int // connection count at the last alert
	proc     procRef
	ep       uint32
	flow     uint32
	name     string
	svc      string
	org      string
	scope    string
}

type beaconDet struct {
	tracks map[beaconKey]*beaconTrack
}

func newBeaconDet() beaconDet { return beaconDet{tracks: map[beaconKey]*beaconTrack{}} }

const (
	beaconMinConns   = 6
	beaconKeep       = 48
	beaconMinPeriod  = 2e9
	beaconMaxPeriod  = 2 * 3600e9
	beaconMaxTracked = 20_000
)

func (b *beaconDet) observe(f *event.Flow) {
	if !f.Out || f.Scope == "local" || f.Scope == "multicast" {
		return
	}
	switch f.App {
	case "dns", "mdns", "ntp", "dhcp", "ssdp":
		return
	}
	if f.Proto != decode.ProtoTCP && f.Proto != decode.ProtoUDP {
		return
	}
	k := beaconKey{f.Proto, f.Remote.Addr(), f.Remote.Port()}
	t := b.tracks[k]
	if t == nil {
		if len(b.tracks) >= beaconMaxTracked {
			return
		}
		t = &beaconTrack{}
		b.tracks[k] = t
	}
	t.starts = append(t.starts, f.First)
	if len(t.starts) > beaconKeep {
		t.starts = slices.Clone(t.starts[len(t.starts)-beaconKeep:])
	}
	t.ep, t.flow, t.name, t.svc, t.org, t.scope = f.EP, f.ID, f.Name, f.Svc, f.Org, f.Scope
}

func (b *beaconDet) attribute(f *event.Flow) {
	if t := b.tracks[beaconKey{f.Proto, f.Remote.Addr(), f.Remote.Port()}]; t != nil {
		t.proc = procRef{f.Proc, f.ProcName, f.PID}
		if f.Name != "" {
			t.name = f.Name
		}
		if f.Svc != "" {
			t.svc = f.Svc
		}
	}
}

// beaconStats measures interval regularity.
type beaconStats struct {
	n      int
	median float64 // ns
	jitter float64 // MAD / median
	skew   float64 // Bowley skewness of the intervals
}

func measure(starts []int64) (beaconStats, bool) {
	if len(starts) < beaconMinConns {
		return beaconStats{}, false
	}
	ts := slices.Clone(starts)
	slices.Sort(ts)
	iv := make([]float64, 0, len(ts)-1)
	for i := 1; i < len(ts); i++ {
		if d := float64(ts[i] - ts[i-1]); d > 0 {
			iv = append(iv, d)
		}
	}
	if len(iv) < beaconMinConns-1 {
		return beaconStats{}, false
	}
	slices.Sort(iv)
	q := func(p float64) float64 { // linear-interpolated quantile of sorted data
		x := p * float64(len(iv)-1)
		lo := int(x)
		hi := min(lo+1, len(iv)-1)
		return iv[lo] + (iv[hi]-iv[lo])*(x-float64(lo))
	}
	med := q(0.5)
	dev := make([]float64, len(iv))
	for i, d := range iv {
		dev[i] = math.Abs(d - med)
	}
	slices.Sort(dev)
	mad := dev[len(dev)/2]
	q1, q3 := q(0.25), q(0.75)
	skew := 0.0
	if q3 > q1 {
		skew = (q3 + q1 - 2*med) / (q3 - q1)
	}
	return beaconStats{n: len(ts), median: med, jitter: mad / med, skew: skew}, true
}

func (b *beaconDet) evaluate(now int64) []event.Alert {
	var out []event.Alert
	for k, t := range b.tracks {
		last := t.starts[len(t.starts)-1]
		st, ok := measure(t.starts)
		if !ok {
			if now-last > int64(beaconMaxPeriod) {
				delete(b.tracks, k)
			}
			continue
		}
		if now-last > int64(3*st.median)+60e9 { // went quiet
			if now-last > int64(beaconMaxPeriod) {
				delete(b.tracks, k)
			}
			continue
		}
		if st.median < beaconMinPeriod || st.median > beaconMaxPeriod {
			continue
		}
		regularity := 1 - math.Min(1, st.jitter/0.2) - 0.3*math.Min(1, math.Abs(st.skew))
		if regularity < 0.55 || st.n-t.reported < 4 && t.reported > 0 {
			continue
		}
		familiar := t.svc != ""
		named := t.name != "" && t.name != t.org
		count := math.Min(1, float64(st.n)/20)
		score := 35 + 35*regularity + 15*count
		switch {
		case familiar:
			score = math.Min(score, 18) // telemetry and keep-alives of known services
		case !named && t.scope == "public":
			score += 12
		}
		t.reported = st.n
		title := "Periodic beaconing to an unfamiliar host"
		if familiar {
			title = "Periodic check-ins to " + t.svc
		}
		target := k.ip.String()
		if named {
			target += " " + t.name
		}
		out = append(out, event.Alert{
			Key: fmt.Sprintf("beacon:%d:%s:%d", k.proto, k.ip, k.port), Kind: "beacon", Score: int(math.Min(score, 89)),
			EP: t.ep, Flow: t.flow, Proc: t.proc.id, Remote: k.ip,
			Title: title,
			Detail: fmt.Sprintf("%s → %s:%d every %.1f s ±%.1f s (%d connections)",
				who(t.proc.name, t.proc.pid), target, k.port, st.median/1e9, st.jitter*st.median/1e9, st.n),
			Evidence: map[string]any{
				"interval_s": math.Round(st.median/1e7) / 100,
				"jitter":     math.Round(st.jitter*1000) / 1000,
				"skew":       math.Round(st.skew*100) / 100,
				"count":      st.n,
			},
		})
	}
	return out
}

package detect

import (
	"math/rand/v2"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/event"
	"github.com/SharvikS/telluric/internal/intel"
)

type sink struct {
	alerts []event.Alert
	defcon int
}

func (s *sink) Raise(a event.Alert) bool { s.alerts = append(s.alerts, a); return true }
func (s *sink) SetDefcon(l int)          { s.defcon = l }

func (s *sink) kinds() map[string]event.Alert {
	m := map[string]event.Alert{}
	for _, a := range s.alerts {
		m[a.Kind] = a
	}
	return m
}

func hub(t *testing.T) (*Hub, *sink) {
	set := intel.NewSet()
	set.AddIP(netip.MustParseAddr("192.0.2.13"), intel.Hit{Kind: intel.KindC2, Source: "Feodo Tracker (demo)"})
	set.AddDomain("evil-updates.example", intel.Hit{Kind: intel.KindMalware, Source: "URLhaus (demo)"})
	h := New(set)
	s := &sink{}
	h.Attach(s)
	return h, s
}

var me = netip.MustParseAddr("192.168.1.42")

func outFlow(id uint32, remote string, at int64) *event.Flow {
	return &event.Flow{ID: id, Proto: decode.ProtoTCP, Out: true, App: "tls", Scope: "public",
		Local: netip.AddrPortFrom(me, uint16(40000+id)), Remote: netip.MustParseAddrPort(remote), First: at, Last: at}
}

func TestRandomness(t *testing.T) {
	for _, human := range []string{"github", "stackoverflow", "googleusercontent", "wikipedia", "anthropic", "cloudflare", "spotify", "youtube"} {
		if r := Randomness(human); r >= 0.5 {
			t.Errorf("%s scored %.2f (should look human)", human, r)
		}
	}
	for _, gen := range []string{"qx7z2p0kla9f", "xjwqkzbvtrm", "a8f3k2l9q0zm", "4a6f686e20646f65", "kq9vz3x7bn2w"} {
		if r := Randomness(gen); r < 0.6 {
			t.Errorf("%s scored %.2f (should look generated)", gen, r)
		}
	}
}

func TestBeaconingIsCaughtAndTelemetryIsNot(t *testing.T) {
	h, s := hub(t)
	rng := rand.New(rand.NewPCG(1, 2))
	t0 := time.Now().UnixNano()
	at := t0
	for i := range 12 { // python3 → C2 every 10 s ±1 %
		f := outFlow(uint32(i+1), "203.0.113.66:8443", at)
		h.FlowStart(at, f)
		f.ProcName, f.PID, f.Proc = "python3", 31337, 9
		h.FlowUpdate(at, f)
		at += int64(float64(10*time.Second) * (0.99 + 0.02*rng.Float64()))
	}
	at2 := t0
	for i := range 12 { // a human-ish pattern to a known service
		f := outFlow(uint32(100+i), "34.120.208.123:443", at2)
		f.Svc = "google"
		h.FlowStart(at2, f)
		at2 += int64(float64(45*time.Second) * (0.4 + 1.2*rng.Float64()))
	}
	h.Tick(at)
	var beacon *event.Alert
	for i := range s.alerts {
		if s.alerts[i].Kind == "beacon" {
			if beacon != nil {
				t.Fatalf("two beacon alerts: %+v", s.alerts)
			}
			beacon = &s.alerts[i]
		}
	}
	if beacon == nil || beacon.Score < 70 || !strings.Contains(beacon.Detail, "python3 (pid 31337)") || !strings.Contains(beacon.Detail, "203.0.113.66:8443 every 10.0 s ±") {
		t.Fatalf("beacon alert %+v", beacon)
	}
}

func TestDGAAndTunnel(t *testing.T) {
	h, s := hub(t)
	now := time.Now().UnixNano()
	rng := rand.New(rand.NewPCG(3, 4))
	const alnum = "abcdefghijklmnopqrstuvwxyz0123456789"
	rnd := func(n int) string {
		b := make([]byte, n)
		for i := range b {
			b[i] = alnum[rng.IntN(len(alnum))]
		}
		return string(b)
	}
	client := netip.MustParseAddrPort("192.168.1.42:53000")
	srv := netip.MustParseAddrPort("192.168.1.1:53")
	for i := range 15 {
		h.DNS(now+int64(i)*int64(100*time.Millisecond), &event.DNS{Client: client, Server: srv, Name: rnd(12) + ".biz", Rcode: decode.DNSRcodeNXDomain, ProcName: "kworkerd", Proc: 3})
	}
	for i := range 30 {
		h.DNS(now+int64(i)*int64(200*time.Millisecond), &event.DNS{Client: client, Server: srv, Name: rnd(40) + "." + rnd(6) + ".t.example.com", QType: decode.DNSTypeTXT, ProcName: "iodine"})
	}
	// Normal browsing must stay quiet.
	for _, n := range []string{"www.google.com", "github.com", "api.github.com", "avatars.githubusercontent.com"} {
		h.DNS(now, &event.DNS{Client: client, Server: srv, Name: n})
	}
	h.Tick(now + int64(6*time.Second))
	k := s.kinds()
	if a, ok := k["dga"]; !ok || a.Score < 70 || !strings.Contains(a.Detail, "kworkerd") {
		t.Fatalf("DGA alert %+v (all: %v)", a, s.alerts)
	}
	if a, ok := k["tunnel"]; !ok || !strings.Contains(a.Detail, "of example.com") || !strings.Contains(a.Detail, "TXT") {
		t.Fatalf("tunnel alert %+v", a)
	}
	if len(s.alerts) != 2 {
		t.Fatalf("unexpected extra alerts: %+v", s.alerts)
	}
}

func TestInboundScan(t *testing.T) {
	h, s := hub(t)
	now := time.Now().UnixNano()
	for i := range 40 {
		f := &event.Flow{ID: uint32(i + 1), Proto: decode.ProtoTCP, Out: false, Scope: "lan",
			Local: netip.AddrPortFrom(me, uint16(20+i*7)), Remote: netip.MustParseAddrPort("192.168.1.66:51000")}
		h.FlowStart(now+int64(i)*int64(50*time.Millisecond), f)
	}
	h.Tick(now + int64(3*time.Second))
	a, ok := s.kinds()["scan"]
	if !ok || a.Score < 80 || !strings.Contains(a.Title, "device on your network") || !strings.Contains(a.Detail, "40 ports") {
		t.Fatalf("scan alert %+v", a)
	}
}

func TestARPSpoof(t *testing.T) {
	h, s := hub(t)
	router := netip.MustParseAddr("192.168.1.1")
	real := [6]byte{0x8c, 0xa3, 0x99, 1, 2, 3}
	fake := [6]byte{0xde, 0xad, 0xbe, 0xef, 0, 0x66}
	for range 3 {
		h.ARP(0, &decode.ARP{Op: 2, SenderMAC: real, SenderIP: router}, nil)
	}
	if len(s.alerts) != 0 {
		t.Fatal("alert before any change")
	}
	h.ARP(1, &decode.ARP{Op: 2, SenderMAC: fake, SenderIP: router}, nil)
	a, ok := s.kinds()["arp-spoof"]
	if !ok || a.Score < 90 || !strings.Contains(a.Detail, "de:ad:be:ef:00:66") || !strings.Contains(a.Title, "router") {
		t.Fatalf("ARP alert %+v", a)
	}
}

func TestIntelExfilCleartextMinerAndDefcon(t *testing.T) {
	h, s := hub(t)
	now := time.Now().UnixNano()
	h.Tick(now)
	if s.defcon != 5 {
		t.Fatalf("calm DEFCON = %d", s.defcon)
	}
	c2 := outFlow(1, "192.0.2.13:443", now)
	h.FlowStart(now, c2)
	up := outFlow(2, "198.51.100.23:443", now)
	up.BytesOut, up.BytesIn, up.ProcName, up.PID, up.Org = 120<<20, 200<<10, "curl", 9999, "Contoso Anonymous Storage (demo)"
	h.Volume(now, up)
	h.Cleartext(now, outFlow(3, "192.168.1.1:80", now), "HTTP Basic authentication")
	h.Miner(now, outFlow(4, "198.51.100.77:3333", now))
	h.FlowUpdate(now, &event.Flow{ID: 5, SNI: "cdn.evil-updates.example", Remote: netip.MustParseAddrPort("198.51.100.9:443"), Scope: "public"})
	h.Tick(now + int64(time.Second))

	k := s.kinds()
	for kind, min := range map[string]int{"intel": 80, "exfil": 70, "cleartext": 70, "miner": 80} {
		if a, ok := k[kind]; !ok || a.Score < min {
			t.Errorf("%s alert %+v", kind, a)
		}
	}
	if !strings.Contains(k["exfil"].Detail, "120.0 MB sent") {
		t.Errorf("exfil detail %q", k["exfil"].Detail)
	}
	if s.defcon > 2 {
		t.Fatalf("DEFCON %d after a critical C2 hit, want ≤ 2", s.defcon)
	}
	// It decays back to calm.
	h.Tick(now + int64(25*time.Minute))
	if s.defcon != 5 {
		t.Fatalf("DEFCON %d after 25 quiet minutes", s.defcon)
	}
}

func TestHalfSpaceTreesRankOutliers(t *testing.T) {
	hs := newHSTrees(25, 10, 256, 3, 7)
	rng := rand.New(rand.NewPCG(5, 6))
	for range 1500 { // a tight normal cluster
		hs.update([]float64{0.3 + 0.05*rng.NormFloat64(), 0.6 + 0.05*rng.NormFloat64(), 0.5 + 0.05*rng.NormFloat64()})
	}
	normal, _ := hs.update([]float64{0.31, 0.59, 0.5})
	outlier, ready := hs.update([]float64{0.95, 0.05, 0.9})
	if !ready || outlier < 0.99 || normal > 0.9 {
		t.Fatalf("normal rank %.3f, outlier rank %.3f (ready=%v)", normal, outlier, ready)
	}
}

func TestRepeatedExfilGroupsIntoOneIncident(t *testing.T) {
	h, s := hub(t)
	now := time.Now().UnixNano()
	for id := uint32(1); id <= 3; id++ { // three separate uploads by curl to the same host
		up := outFlow(id, "198.51.100.23:443", now)
		up.BytesOut, up.BytesIn, up.ProcName, up.PID = 60<<20, 1<<20, "curl", int(9000+id)
		h.Volume(now, up)
	}
	keys := map[string]bool{}
	for _, a := range s.alerts {
		keys[a.Key] = true
	}
	if len(s.alerts) != 3 || len(keys) != 1 {
		t.Fatalf("%d raises under %d keys, want 3 raises of one incident", len(s.alerts), len(keys))
	}
}

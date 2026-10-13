package intel

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

func writeFeeds(t *testing.T) string {
	dir := t.TempDir()
	files := map[string]string{
		"feodo.txt":         "# Feodo Tracker\n# comment\n162.243.103.246\n178.62.3.223\n",
		"drop_v4.json":      `{"cidr":"1.10.16.0/20","sblid":"SBL256894","rir":"apnic"}` + "\n" + `{"cidr":"1.10.20.0/24","sblid":"SBL1","rir":"apnic"}` + "\n" + `{"type":"metadata","timestamp":1}` + "\n",
		"drop_v6.json":      `{"cidr":"2a06:e480::/29","sblid":"SBL3","rir":"ripencc"}` + "\n",
		"tor-exits.txt":     "171.25.193.25\n80.67.167.81\n",
		"urlhaus-hosts.txt": "# URLhaus\n127.0.0.1\tevil-updates.example\n127.0.0.1\tlocalhost\n",
		"threatfox-ipport.csv": "# header\n" +
			`"2026-10-13 08:21:56", "1962925", "177.2.184.188:80", "ip:port", "botnet_cc", "win.cobalt_strike", "BEACON", "Cobalt Strike", "", "100", "False", "None", "CobaltStrike", "0", "abuse_ch"` + "\n",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestMatching(t *testing.T) {
	s := NewSet()
	if err := s.Load(writeFeeds(t)); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		ip     string
		source string
		kind   Kind
	}{
		{"162.243.103.246", "abuse.ch Feodo Tracker", KindC2},
		{"177.2.184.188", "abuse.ch ThreatFox: Cobalt Strike C2", KindC2},
		{"1.10.16.1", "Spamhaus DROP", KindHijack},
		{"1.10.31.255", "Spamhaus DROP", KindHijack},
		{"1.10.20.7", "Spamhaus DROP", KindHijack}, // inside two overlapping ranges
		{"2a06:e480::1", "Spamhaus DROPv6", KindHijack},
		{"::ffff:171.25.193.25", "Tor Project exit list", KindTor},
	}
	for _, c := range cases {
		h, ok := s.MatchIP(netip.MustParseAddr(c.ip))
		if !ok || h.Source != c.source || h.Kind != c.kind {
			t.Errorf("%s → %+v ok=%v, want %s", c.ip, h, ok, c.source)
		}
	}
	for _, miss := range []string{"1.10.32.0", "1.10.15.255", "8.8.8.8", "2001:db8::1"} {
		if _, ok := s.MatchIP(netip.MustParseAddr(miss)); ok {
			t.Errorf("%s matched", miss)
		}
	}
	if h, ok := s.MatchDomain("Download.EVIL-UPDATES.example."); !ok || h.Kind != KindMalware {
		t.Errorf("subdomain match: %+v %v", h, ok)
	}
	if _, ok := s.MatchDomain("localhost"); ok {
		t.Error("localhost listed")
	}
	if _, ok := s.MatchDomain("example"); ok {
		t.Error("TLD matched")
	}
}

func TestDemoEntriesSurviveReload(t *testing.T) {
	s := NewSet()
	s.AddIP(netip.MustParseAddr("192.0.2.13"), Hit{Kind: KindC2, Source: "Feodo Tracker (demo)"})
	if err := s.Load(writeFeeds(t)); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.MatchIP(netip.MustParseAddr("192.0.2.13")); !ok {
		t.Fatal("demo entry dropped by reload")
	}
}

func BenchmarkMatchIP(b *testing.B) {
	s := NewSet()
	s.Load(writeFeeds(&testing.T{}))
	ip := netip.MustParseAddr("142.250.183.14")
	b.ReportAllocs()
	for b.Loop() {
		s.MatchIP(ip)
	}
}

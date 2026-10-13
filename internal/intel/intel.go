// Package intel loads public threat-intelligence feeds and matches
// addresses and domain names against them.
package intel

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/SharvikS/telluric/internal/buildinfo"
)

// Kind classifies a feed entry.
type Kind uint8

// Feed kinds.
const (
	KindC2      Kind = iota // botnet command & control
	KindHijack              // hijacked / criminal netblock
	KindMalware             // malware distribution host
	KindTor                 // Tor exit relay
)

// Hit describes a match.
type Hit struct {
	Kind   Kind
	Source string // human-readable feed name
}

type feed struct {
	file   string
	url    string
	source string
	kind   Kind
	parse  func(r io.Reader, add func(entry, label string))
}

// Feeds are free, keyless, and permissive about use.
var feeds = []feed{
	{"feodo.txt", "https://feodotracker.abuse.ch/downloads/ipblocklist.txt", "abuse.ch Feodo Tracker", KindC2, parseLines},
	{"sslbl.txt", "https://sslbl.abuse.ch/blacklist/sslipblacklist.txt", "abuse.ch SSLBL", KindC2, parseLines},
	{"drop_v4.json", "https://www.spamhaus.org/drop/drop_v4.json", "Spamhaus DROP", KindHijack, parseDROP},
	{"drop_v6.json", "https://www.spamhaus.org/drop/drop_v6.json", "Spamhaus DROPv6", KindHijack, parseDROP},
	{"tor-exits.txt", "https://check.torproject.org/torbulkexitlist", "Tor Project exit list", KindTor, parseLines},
	{"urlhaus-hosts.txt", "https://urlhaus.abuse.ch/downloads/hostfile/", "abuse.ch URLhaus", KindMalware, parseHosts},
	{"threatfox-ipport.csv", "https://threatfox.abuse.ch/export/csv/ip-port/recent/", "abuse.ch ThreatFox", KindC2, parseThreatFox},
}

// Set is a snapshot of all feeds. It is safe for concurrent use.
type Set struct {
	mu      sync.RWMutex
	ips     map[netip.Addr]Hit
	ranges4 []rng4 // sorted, non-overlapping per source
	nets6   []netEntry
	domains map[string]Hit
	loaded  time.Time
}

type rng4 struct {
	lo, hi uint32
	hit    Hit
}

type netEntry struct {
	p   netip.Prefix
	hit Hit
}

// NewSet returns an empty set.
func NewSet() *Set { return &Set{ips: map[netip.Addr]Hit{}, domains: map[string]Hit{}} }

// AddIP adds a single address (used by tests and the demo world).
func (s *Set) AddIP(ip netip.Addr, h Hit) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ips[ip.Unmap()] = h
}

// AddDomain adds a domain (matched with all its subdomains).
func (s *Set) AddDomain(d string, h Hit) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.domains[strings.ToLower(strings.TrimSuffix(d, "."))] = h
}

// Size returns the number of entries.
func (s *Set) Size() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.ips) + len(s.ranges4) + len(s.nets6) + len(s.domains)
}

// MatchIP reports whether ip is listed.
func (s *Set) MatchIP(ip netip.Addr) (Hit, bool) {
	ip = ip.Unmap()
	s.mu.RLock()
	defer s.mu.RUnlock()
	if h, ok := s.ips[ip]; ok {
		return h, true
	}
	if ip.Is4() {
		a := ip.As4()
		v := uint32(a[0])<<24 | uint32(a[1])<<16 | uint32(a[2])<<8 | uint32(a[3])
		i, _ := slices.BinarySearchFunc(s.ranges4, v, func(r rng4, v uint32) int {
			switch {
			case r.hi < v:
				return -1
			case r.lo > v:
				return 1
			}
			return 0
		})
		if i < len(s.ranges4) && s.ranges4[i].lo <= v && v <= s.ranges4[i].hi {
			return s.ranges4[i].hit, true
		}
		return Hit{}, false
	}
	for _, n := range s.nets6 {
		if n.p.Contains(ip) {
			return n.hit, true
		}
	}
	return Hit{}, false
}

// MatchDomain reports whether name or any parent domain is listed.
func (s *Set) MatchDomain(name string) (Hit, bool) {
	name = strings.ToLower(strings.TrimSuffix(name, "."))
	s.mu.RLock()
	defer s.mu.RUnlock()
	for name != "" {
		if h, ok := s.domains[name]; ok {
			return h, true
		}
		i := strings.IndexByte(name, '.')
		if i < 0 {
			break
		}
		name = name[i+1:]
	}
	return Hit{}, false
}

// Load (re)builds the set from feed files in dir.
func (s *Set) Load(dir string) error {
	ips := map[netip.Addr]Hit{}
	var r4 []rng4
	var n6 []netEntry
	domains := map[string]Hit{}
	found := 0
	for _, f := range feeds {
		fh, err := os.Open(filepath.Join(dir, f.file))
		if err != nil {
			continue
		}
		found++
		f.parse(fh, func(entry, label string) {
			hit := Hit{Kind: f.kind, Source: f.source}
			if label != "" {
				hit.Source = label
			}
			if p, err := netip.ParsePrefix(entry); err == nil {
				p = p.Masked()
				if p.Addr().Is4() {
					a := p.Addr().As4()
					lo := uint32(a[0])<<24 | uint32(a[1])<<16 | uint32(a[2])<<8 | uint32(a[3])
					hi := lo | (1<<(32-p.Bits()) - 1)
					r4 = append(r4, rng4{lo, hi, hit})
				} else {
					n6 = append(n6, netEntry{p, hit})
				}
				return
			}
			if ip, err := netip.ParseAddr(entry); err == nil {
				if _, dup := ips[ip.Unmap()]; !dup || f.kind != KindTor {
					ips[ip.Unmap()] = hit
				}
				return
			}
			if strings.Contains(entry, ".") {
				domains[strings.ToLower(entry)] = hit
			}
		})
		fh.Close()
	}
	if found == 0 {
		return fmt.Errorf("intel: no feeds in %s", dir)
	}
	slices.SortFunc(r4, func(a, b rng4) int {
		switch {
		case a.lo < b.lo:
			return -1
		case a.lo > b.lo:
			return 1
		}
		return 0
	})
	// Merge overlaps so the binary search sees disjoint ranges.
	merged := r4[:0]
	for _, r := range r4 {
		if n := len(merged); n > 0 && r.lo <= merged[n-1].hi {
			merged[n-1].hi = max(merged[n-1].hi, r.hi)
			continue
		}
		merged = append(merged, r)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Keep entries added programmatically (the demo's).
	for ip, h := range s.ips {
		if _, ok := ips[ip]; !ok && strings.Contains(h.Source, "(demo)") {
			ips[ip] = h
		}
	}
	s.ips, s.ranges4, s.nets6, s.domains, s.loaded = ips, merged, n6, domains, time.Now()
	return nil
}

func parseLines(r io.Reader, add func(string, string)) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		if i := strings.IndexAny(line, " \t,;"); i > 0 {
			line = line[:i]
		}
		add(line, "")
	}
}

// parseHosts reads hosts-file format ("127.0.0.1 evil.example").
func parseHosts(r io.Reader, add func(string, string)) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 2 && !strings.HasPrefix(f[0], "#") && f[1] != "localhost" {
			add(f[1], "")
		}
	}
}

// parseThreatFox reads ThreatFox's CSV export of ip:port indicators and
// labels each with its malware family ("abuse.ch ThreatFox: Cobalt Strike C2").
func parseThreatFox(r io.Reader, add func(string, string)) {
	cr := csv.NewReader(r)
	cr.Comment = '#'
	cr.TrimLeadingSpace = true
	cr.LazyQuotes = true
	cr.FieldsPerRecord = -1
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			return
		}
		if err != nil || len(rec) < 8 || rec[3] != "ip:port" {
			continue
		}
		host := rec[2]
		if i := strings.LastIndexByte(host, ':'); i > 0 {
			host = strings.Trim(host[:i], "[]")
		}
		add(host, "abuse.ch ThreatFox: "+rec[7]+" C2")
	}
}

// parseDROP reads Spamhaus' newline-delimited JSON format.
func parseDROP(r io.Reader, add func(string, string)) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		var e struct {
			CIDR string `json:"cidr"`
		}
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.CIDR != "" {
			add(e.CIDR, "")
		}
	}
}

// Stale reports whether the feeds in dir are missing or older than maxAge.
func Stale(dir string, maxAge time.Duration) bool {
	st, err := os.Stat(filepath.Join(dir, feeds[0].file))
	return err != nil || time.Since(st.ModTime()) > maxAge
}

// Update downloads every feed into dir. Feeds that fail keep their
// previous copy.
func Update(ctx context.Context, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var errs []string
	for _, f := range feeds {
		if err := fetch(ctx, f.url, filepath.Join(dir, f.file)); err != nil {
			errs = append(errs, f.source+": "+err.Error())
		}
	}
	if len(errs) == len(feeds) {
		return fmt.Errorf("intel: %s", strings.Join(errs, "; "))
	}
	return nil
}

func fetch(ctx context.Context, url, dst string) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", buildinfo.UserAgent())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s", resp.Status)
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".feed-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, io.LimitReader(resp.Body, 64<<20)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

// Credit lists the feeds for attribution.
func Credit() string {
	return "Threat intel: abuse.ch (Feodo Tracker, ThreatFox, SSLBL, URLhaus), Spamhaus DROP, Tor Project"
}

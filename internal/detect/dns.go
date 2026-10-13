package detect

import (
	"fmt"
	"math"
	"strings"

	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/event"
)

// Malware with a domain generation algorithm (DGA) derives thousands of
// pseudo-random names a day and tries them until one resolves — its
// operators register just one. On the wire that is a burst of failed
// (NXDOMAIN) lookups of names no human would type. DNS tunnels instead
// smuggle data inside long, unique subdomains of one domain.

type nxTrack struct {
	ts       []int64
	names    []string
	proc     procRef
	reported int // peak burst size already reported
}

type tunTrack struct {
	subs     map[string]int64 // subdomain → last seen
	bytes    int              // total subdomain characters in the window
	txt      int
	proc     procRef
	reported int
}

type dnsDet struct {
	nx  map[string]*nxTrack
	tun map[string]*tunTrack
}

func newDNSDet() dnsDet { return dnsDet{nx: map[string]*nxTrack{}, tun: map[string]*tunTrack{}} }

const (
	dnsWindow   = int64(60e9)
	nxThreshold = 10
	tunUnique   = 20
	tunAvgLen   = 24
)

func (d *dnsDet) observe(now int64, ev *event.DNS) {
	client := ev.ProcName
	if client == "" {
		client = ev.Client.Addr().String()
	}
	if ev.Rcode == decode.DNSRcodeNXDomain && len(d.nx) < 10_000 {
		t := d.nx[client]
		if t == nil {
			t = &nxTrack{}
			d.nx[client] = t
		}
		t.ts = append(t.ts, now)
		t.names = append(t.names, ev.Name)
		if len(t.ts) > 256 {
			t.ts, t.names = t.ts[128:], t.names[128:]
		}
		if ev.ProcName != "" {
			t.proc = procRef{ev.Proc, ev.ProcName, ev.PID}
		}
	}
	apex := registrable(ev.Name)
	if apex == "" || apex == "in-addr.arpa" || apex == "ip6.arpa" || strings.HasSuffix(ev.Name, ".local") {
		return
	}
	sub := strings.TrimSuffix(strings.TrimSuffix(ev.Name, apex), ".")
	if sub == "" || len(d.tun) >= 10_000 && d.tun[apex] == nil {
		return
	}
	t := d.tun[apex]
	if t == nil {
		t = &tunTrack{subs: map[string]int64{}}
		d.tun[apex] = t
	}
	if _, seen := t.subs[sub]; !seen && len(t.subs) < 4096 {
		t.bytes += len(sub)
	}
	t.subs[sub] = now
	if ev.QType == decode.DNSTypeTXT || ev.QType == 10 /* NULL */ {
		t.txt++
	}
	if ev.ProcName != "" {
		t.proc = procRef{ev.Proc, ev.ProcName, ev.PID}
	}
}

func (d *dnsDet) evaluate(now int64) []event.Alert {
	var out []event.Alert
	for client, t := range d.nx {
		var recent []string
		for i, ts := range t.ts {
			if now-ts <= dnsWindow {
				recent = append(recent, t.names[i])
			}
		}
		if len(recent) == 0 {
			delete(d.nx, client)
			continue
		}
		if len(recent) < nxThreshold || len(recent) <= t.reported {
			continue
		}
		t.reported = len(recent)
		random := 0
		for _, n := range recent {
			if Randomness(firstLabel(n)) >= 0.6 {
				random++
			}
		}
		frac := float64(random) / float64(len(recent))
		samples := recent[max(0, len(recent)-3):]
		switch {
		case frac >= 0.5:
			out = append(out, event.Alert{
				Key: "dga:" + client, Kind: "dga", Score: 70 + int(15*frac), Proc: t.proc.id,
				Title: "Domain generation algorithm (DGA) activity",
				Detail: fmt.Sprintf("%s failed %d lookups of random-looking names in a minute, e.g. %s",
					who(t.proc.name, t.proc.pid), len(recent), strings.Join(samples, ", ")),
				Evidence: map[string]any{"nxdomain": len(recent), "random_fraction": math.Round(frac*100) / 100, "samples": samples},
			})
		case len(recent) >= 3*nxThreshold:
			out = append(out, event.Alert{
				Key: "nxstorm:" + client, Kind: "dga", Score: 25, Proc: t.proc.id,
				Title:    "Storm of failed DNS lookups",
				Detail:   fmt.Sprintf("%s: %d NXDOMAIN answers in a minute (misconfiguration or a typo-squatting probe)", who(t.proc.name, t.proc.pid), len(recent)),
				Evidence: map[string]any{"nxdomain": len(recent)},
			})
		}
	}
	for apex, t := range d.tun {
		for sub, ts := range t.subs {
			if now-ts > dnsWindow {
				t.bytes -= len(sub)
				delete(t.subs, sub)
			}
		}
		if len(t.subs) == 0 {
			delete(d.tun, apex)
			continue
		}
		n := len(t.subs)
		avg := t.bytes / n
		if n < tunUnique || avg < tunAvgLen || n <= t.reported {
			continue
		}
		t.reported = n
		score := 72 + min(15, n/10)
		if t.txt > n/2 {
			score += 5
		}
		out = append(out, event.Alert{
			Key: "tunnel:" + apex, Kind: "tunnel", Score: min(score, 89), Proc: t.proc.id,
			Title: "DNS tunneling suspected",
			Detail: fmt.Sprintf("%s: %d unique long subdomains of %s in a minute (average %d characters%s)",
				who(t.proc.name, t.proc.pid), n, apex, avg, map[bool]string{true: ", mostly TXT queries", false: ""}[t.txt > n/2]),
			Evidence: map[string]any{"domain": apex, "unique": n, "avg_len": avg, "txt": t.txt},
		})
	}
	return out
}

// multiSuffixes are common public suffixes with two labels.
var multiSuffixes = map[string]bool{
	"co.uk": true, "org.uk": true, "ac.uk": true, "gov.uk": true, "me.uk": true, "com.au": true, "net.au": true,
	"org.au": true, "co.nz": true, "co.jp": true, "ne.jp": true, "co.in": true, "net.in": true, "org.in": true,
	"com.br": true, "com.cn": true, "net.cn": true, "com.tw": true, "co.kr": true, "com.mx": true, "co.za": true,
	"com.sg": true, "com.tr": true, "com.ar": true, "co.id": true, "com.hk": true, "github.io": true,
}

// registrable returns the registrable domain ("example.co.uk").
func registrable(name string) string {
	name = strings.TrimSuffix(strings.ToLower(name), ".")
	labels := strings.Split(name, ".")
	if len(labels) < 2 {
		return ""
	}
	n := 2
	if len(labels) >= 3 && multiSuffixes[strings.Join(labels[len(labels)-2:], ".")] {
		n = 3
	}
	return strings.Join(labels[len(labels)-n:], ".")
}

// firstLabel returns the most specific label of the registrable domain,
// where generated names put their randomness ("qx7z2p0kla9f" of
// "qx7z2p0kla9f.biz").
func firstLabel(name string) string {
	apex := registrable(name)
	if i := strings.IndexByte(apex, '.'); i > 0 {
		return apex[:i]
	}
	return apex
}

// Randomness scores how machine-generated a DNS label looks, from 0
// (dictionary-like: "github", "stackoverflow") to 1 ("qx7z2p0kla9f"). It
// combines character entropy, vowel scarcity, digits interleaved with
// letters and consonant clusters — properties that separate algorithmic
// names from ones people chose to be typed and remembered.
func Randomness(label string) float64 {
	n := len(label)
	if n < 7 {
		return 0
	}
	var counts [256]int
	letters, vowels, digits, run, maxRun, switches := 0, 0, 0, 0, 0, 0
	prevDigit := -1
	for i := range n {
		c := label[i] | 0x20
		counts[c]++
		isDigit := '0' <= label[i] && label[i] <= '9'
		switch {
		case isDigit:
			digits++
			run = 0
		case 'a' <= c && c <= 'z':
			letters++
			if strings.IndexByte("aeiouy", c) >= 0 {
				vowels++
				run = 0
			} else {
				run++
				maxRun = max(maxRun, run)
			}
		default:
			run = 0
		}
		d := 0
		if isDigit {
			d = 1
		}
		if prevDigit >= 0 && d != prevDigit {
			switches++
		}
		prevDigit = d
	}
	var h float64
	for _, k := range counts {
		if k > 0 {
			p := float64(k) / float64(n)
			h -= p * math.Log2(p)
		}
	}
	clamp := func(x float64) float64 { return math.Max(0, math.Min(1, x)) }
	vowelFrac := 0.0
	if letters > 0 {
		vowelFrac = float64(vowels) / float64(letters)
	}
	s := clamp((h-2.8)/1.0) +
		clamp((0.35-vowelFrac)/0.25) +
		0.8*clamp(float64(digits)/float64(n)/0.3) +
		clamp(float64(maxRun-3)/3) +
		0.5*clamp(float64(switches)/4)
	// Long hex blobs are encoded data — the favourite of DNS tunnels — even
	// though their small alphabet keeps the entropy modest.
	if n >= 12 && strings.Trim(strings.ToLower(label), "0123456789abcdef") == "" && digits > 0 && letters > 0 {
		s += 1.2
	}
	return clamp(s / 3)
}

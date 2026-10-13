package decode

import (
	"net/netip"
	"testing"

	"github.com/SharvikS/telluric/internal/craft"
)

func TestDNSResponseWithCNAMEChain(t *testing.T) {
	msg := craft.DNSResponse(0xbeef, "WWW.YouTube.com", DNSTypeA, DNSRcodeNoError,
		craft.RR{Name: "www.youtube.com", Type: DNSTypeCNAME, TTL: 300, Target: "youtube-ui.l.google.com"},
		craft.RR{Name: "youtube-ui.l.google.com", Type: DNSTypeA, TTL: 60, Addr: netip.MustParseAddr("142.250.183.14")},
		craft.RR{Name: "youtube-ui.l.google.com", Type: DNSTypeA, TTL: 60, Addr: netip.MustParseAddr("142.250.183.46")},
	)
	var m DNSMessage
	if err := m.Parse(msg); err != nil {
		t.Fatal(err)
	}
	if m.ID != 0xbeef || !m.Response || m.Rcode != DNSRcodeNoError || len(m.Questions) != 1 || len(m.Answers) != 3 {
		t.Fatalf("header: %+v", m)
	}
	if q := m.Questions[0]; string(q.Name) != "www.youtube.com" || q.Type != DNSTypeA {
		t.Fatalf("question %q type %d", q.Name, q.Type)
	}
	cname := m.Answers[0]
	if string(cname.Name) != "www.youtube.com" || string(cname.Target) != "youtube-ui.l.google.com" || cname.TTL != 300 {
		t.Fatalf("cname %q → %q ttl %d", cname.Name, cname.Target, cname.TTL)
	}
	if a := m.Answers[2]; string(a.Name) != "youtube-ui.l.google.com" || a.Addr.String() != "142.250.183.46" {
		t.Fatalf("A %q %v", a.Name, a.Addr)
	}
}

func TestDNSHTTPSRecordHints(t *testing.T) {
	hints := []netip.Addr{netip.MustParseAddr("104.16.132.229"), netip.MustParseAddr("2606:4700::6810:84e5")}
	msg := craft.DNSResponse(1, "cloudflare.com", DNSTypeHTTPS, 0,
		craft.RR{Name: "cloudflare.com", Type: DNSTypeHTTPS, TTL: 300, Data: craft.HTTPSRecord([]string{"h3", "h2"}, hints, true)})
	var m DNSMessage
	if err := m.Parse(msg); err != nil {
		t.Fatal(err)
	}
	rr := m.Answers[0]
	if rr.NHints != 2 || rr.Hints[0] != hints[0] || rr.Hints[1] != hints[1] || !rr.ECH || len(rr.Target) != 0 {
		t.Fatalf("hints=%v n=%d ech=%v target=%q", rr.Hints, rr.NHints, rr.ECH, rr.Target)
	}
}

func TestDNSNXDomainAndQuery(t *testing.T) {
	var m DNSMessage
	if err := m.Parse(craft.DNSQuery(7, "xjw8q2kdp1zv.com", DNSTypeA)); err != nil {
		t.Fatal(err)
	}
	if m.Response || string(m.Questions[0].Name) != "xjw8q2kdp1zv.com" {
		t.Fatalf("query parsed as %+v", m)
	}
	if err := m.Parse(craft.DNSResponse(7, "xjw8q2kdp1zv.com", DNSTypeA, DNSRcodeNXDomain)); err != nil {
		t.Fatal(err)
	}
	if !m.Response || m.Rcode != DNSRcodeNXDomain || DNSRcodeName(m.Rcode) != "NXDOMAIN" || len(m.Answers) != 0 {
		t.Fatalf("nxdomain parsed as %+v", m)
	}
}

func TestDNSOverTCP(t *testing.T) {
	framed := craft.TCPFramed(craft.DNSQuery(9, "example.org", DNSTypeAAAA))
	var m DNSMessage
	if err := m.ParseTCP(framed[:len(framed)-1]); err != ErrTruncated {
		t.Fatalf("partial message: %v", err)
	}
	if err := m.ParseTCP(framed); err != nil || string(m.Questions[0].Name) != "example.org" || m.Questions[0].Type != DNSTypeAAAA {
		t.Fatalf("err=%v %+v", err, m.Questions)
	}
}

func TestDNSCompressionLoopIsRejected(t *testing.T) {
	msg := craft.DNSQuery(1, "a.b", DNSTypeA)
	msg = append(msg[:12], 0xc0, 12) // the question name points at itself
	msg = append(msg, 0, 1, 0, 1)
	var m DNSMessage
	if err := m.Parse(msg); err != ErrMalformed {
		t.Fatalf("self-referencing pointer: %v", err)
	}
}

func TestDNSNamesAreSanitized(t *testing.T) {
	msg := []byte{0, 1, 0x01, 0, 0, 1, 0, 0, 0, 0, 0, 0,
		4, 'E', 'v', '.', 0x01, 3, 'c', 'o', 'm', 0, 0, 1, 0, 1}
	var m DNSMessage
	if err := m.Parse(msg); err != nil {
		t.Fatal(err)
	}
	if got := string(m.Questions[0].Name); got != "ev??.com" {
		t.Fatalf("got %q", got)
	}
}

func FuzzDNS(f *testing.F) {
	f.Add(craft.DNSQuery(1, "www.example.com", DNSTypeA))
	f.Add(craft.DNSResponse(2, "www.youtube.com", DNSTypeA, 0,
		craft.RR{Name: "www.youtube.com", Type: DNSTypeCNAME, TTL: 1, Target: "youtube-ui.l.google.com"},
		craft.RR{Name: "youtube-ui.l.google.com", Type: DNSTypeA, TTL: 1, Addr: netip.MustParseAddr("1.2.3.4")}))
	f.Add(craft.DNSResponse(3, "cloudflare.com", DNSTypeHTTPS, 0,
		craft.RR{Name: "cloudflare.com", Type: DNSTypeHTTPS, Data: craft.HTTPSRecord([]string{"h3"}, []netip.Addr{netip.MustParseAddr("::1")}, true)}))
	f.Fuzz(func(t *testing.T, b []byte) {
		var m DNSMessage
		if m.Parse(b) != nil {
			return
		}
		for _, q := range m.Questions {
			if len(q.Name) > 255 {
				t.Fatalf("name of %d bytes", len(q.Name))
			}
		}
		if len(m.Answers) > maxDNSAnswers {
			t.Fatal("answer cap exceeded")
		}
	})
}

func BenchmarkDNSParse(b *testing.B) {
	msg := craft.DNSResponse(0xbeef, "www.youtube.com", DNSTypeA, 0,
		craft.RR{Name: "www.youtube.com", Type: DNSTypeCNAME, TTL: 300, Target: "youtube-ui.l.google.com"},
		craft.RR{Name: "youtube-ui.l.google.com", Type: DNSTypeA, TTL: 60, Addr: netip.MustParseAddr("142.250.183.14")},
	)
	var m DNSMessage
	b.ReportAllocs()
	for b.Loop() {
		if err := m.Parse(msg); err != nil {
			b.Fatal(err)
		}
	}
}

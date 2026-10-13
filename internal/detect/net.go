package detect

import (
	"fmt"
	"net/netip"
	"slices"

	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/event"
)

// ---- port scans ----

type scanTrack struct {
	ports    map[uint16]int64 // inbound: our ports probed → last time
	first    int64
	reported int // peak port count already reported
}

type sweepTrack struct {
	dests    map[netip.AddrPort]int64
	proc     procRef
	reported int
}

type scanDet struct {
	in  map[netip.Addr]*scanTrack
	out map[string]*sweepTrack
}

func newScanDet() scanDet {
	return scanDet{in: map[netip.Addr]*scanTrack{}, out: map[string]*sweepTrack{}}
}

const (
	scanWindow    = int64(10e9)
	scanPorts     = 20
	sweepDests    = 100
	scanMaxTracks = 20_000
)

func (s *scanDet) observe(now int64, f *event.Flow) {
	if f.Proto != decode.ProtoTCP {
		return
	}
	if !f.Out {
		t := s.in[f.Remote.Addr()]
		if t == nil {
			if len(s.in) >= scanMaxTracks {
				return
			}
			t = &scanTrack{ports: map[uint16]int64{}, first: now}
			s.in[f.Remote.Addr()] = t
		}
		t.ports[f.Local.Port()] = now
		return
	}
	key := f.ProcName
	if key == "" {
		key = "?"
	}
	t := s.out[key]
	if t == nil {
		if len(s.out) >= scanMaxTracks {
			return
		}
		t = &sweepTrack{dests: map[netip.AddrPort]int64{}}
		s.out[key] = t
	}
	if len(t.dests) < 4096 {
		t.dests[f.Remote] = now
	}
	t.proc = procRef{f.Proc, f.ProcName, f.PID}
}

func (s *scanDet) evaluate(now int64) []event.Alert {
	var out []event.Alert
	for ip, t := range s.in {
		var ports []uint16
		for p, ts := range t.ports {
			if now-ts > scanWindow {
				delete(t.ports, p)
			} else {
				ports = append(ports, p)
			}
		}
		if len(ports) == 0 {
			delete(s.in, ip)
			continue
		}
		if len(ports) < scanPorts || len(ports) <= t.reported {
			continue // report the peak; a draining window is not news
		}
		t.reported = len(ports)
		slices.Sort(ports)
		where, score := "from the internet", 74
		if ip.IsPrivate() || ip.IsLinkLocalUnicast() {
			where, score = "from a device on your network", 84
		}
		out = append(out, event.Alert{
			Key: "scan:" + ip.String(), Kind: "scan", Score: score, Remote: ip,
			Title:    "Port scan " + where,
			Detail:   fmt.Sprintf("%s probed %d ports on this machine within %d s (%d … %d)", ip, len(ports), scanWindow/1e9, ports[0], ports[len(ports)-1]),
			Evidence: map[string]any{"ports": len(ports), "lowest": ports[0], "highest": ports[len(ports)-1]},
		})
	}
	for key, t := range s.out {
		for d, ts := range t.dests {
			if now-ts > scanWindow {
				delete(t.dests, d)
			}
		}
		if len(t.dests) == 0 {
			delete(s.out, key)
			continue
		}
		if len(t.dests) >= sweepDests && len(t.dests) > t.reported {
			t.reported = len(t.dests)
			out = append(out, event.Alert{
				Key: "sweep:" + key, Kind: "scan", Score: 62, Proc: t.proc.id,
				Title:    "This machine is sweeping the network",
				Detail:   fmt.Sprintf("%s opened TCP connections to %d different destinations within %d s — worm-like behaviour", who(t.proc.name, t.proc.pid), len(t.dests), scanWindow/1e9),
				Evidence: map[string]any{"destinations": len(t.dests)},
			})
		}
	}
	return out
}

// ---- ARP spoofing ----

type arpEntry struct {
	mac   [6]byte
	seen  int
	prev  [6]byte
	flips int
}

type arpDet struct {
	byIP map[netip.Addr]*arpEntry
}

func macString(m [6]byte) string {
	return fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5])
}

// observe learns IP→MAC bindings from replies and gratuitous ARP, and
// flags an established binding that suddenly changes hands — the signature
// of a man-in-the-middle poisoning the ARP caches of the LAN.
func (a *arpDet) observe(now int64, p *decode.ARP) (event.Alert, bool) {
	gratuitous := p.Op == 1 && p.SenderIP == p.TargetIP
	if p.Op != 2 && !gratuitous || !p.SenderIP.IsValid() || p.SenderIP.IsUnspecified() {
		return event.Alert{}, false
	}
	e := a.byIP[p.SenderIP]
	if e == nil {
		if len(a.byIP) >= 4096 {
			return event.Alert{}, false
		}
		a.byIP[p.SenderIP] = &arpEntry{mac: p.SenderMAC, seen: 1}
		return event.Alert{}, false
	}
	if e.mac == p.SenderMAC {
		e.seen++
		return event.Alert{}, false
	}
	established := e.seen >= 2
	e.prev, e.mac, e.seen = e.mac, p.SenderMAC, 1
	if !established {
		return event.Alert{}, false
	}
	e.flips++
	ip4 := p.SenderIP.As4()
	gateway := ip4[3] == 1 || ip4[3] == 254
	title, score := "ARP spoofing: a device changed hands", 80
	if gateway {
		title, score = "ARP spoofing: someone is impersonating your router", 96
	}
	return event.Alert{
		Key: "arp:" + p.SenderIP.String(), Kind: "arp-spoof", Score: score, Remote: p.SenderIP,
		Title: title,
		Detail: fmt.Sprintf("%s is being claimed by two devices, %s and %s (%d changes) — traffic to it may be intercepted",
			p.SenderIP, macString(e.prev), macString(e.mac), e.flips),
		Evidence: map[string]any{"ip": p.SenderIP.String(), "old_mac": macString(e.prev), "new_mac": macString(e.mac), "flips": e.flips},
	}, true
}

// ---- exfiltration ----

type exfilDet struct {
	seen map[uint32]bool
}

const exfilMin = 48 << 20

// observe flags large, lopsided uploads to destinations this machine has
// no established relationship with: no well-known service, and often no
// DNS name at all (the address was hard-coded).
func (x *exfilDet) observe(f *event.Flow) (event.Alert, bool) {
	if !f.Out || f.Scope != "public" || f.BytesOut < exfilMin || f.BytesOut < 8*f.BytesIn || f.Svc != "" {
		return event.Alert{}, false
	}
	score := 66
	named := f.Name != "" && f.Name != f.Org
	if !named {
		score = 80
	}
	// One incident per process and destination: repeated uploads to the
	// same place grow one alert's occurrence count instead of piling up.
	key := fmt.Sprintf("exfil:%s:%s", f.ProcName, f.Remote.Addr())
	firstTime := !x.seen[f.ID]
	x.seen[f.ID] = true
	if !firstTime && f.BytesOut%(32<<20) >= 4<<20 {
		return event.Alert{}, false // refresh the alert every ~32 MB
	}
	return event.Alert{
		Key: key, Kind: "exfil", Score: score, Flow: f.ID, Proc: f.Proc, Remote: f.Remote.Addr(),
		Title: "Large upload to an unfamiliar destination",
		Detail: fmt.Sprintf("%s → %s (%s): %s sent, %s received",
			who(f.ProcName, f.PID), dest(f), orUnknown(f.Org), human(f.BytesOut), human(f.BytesIn)),
		Evidence: map[string]any{"bytes_out": f.BytesOut, "bytes_in": f.BytesIn, "org": f.Org},
	}, true
}

func orUnknown(s string) string {
	if s == "" {
		return "unknown network"
	}
	return s
}

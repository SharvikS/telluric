package geo

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Home is where this machine is.
type Home struct {
	Lat, Lon float64
	Known    bool
	City     string
	CC       string
	Src      string // flag | stun | tz | none
	PublicIP netip.Addr
}

// ParseLatLon parses "18.52,73.86".
func ParseLatLon(s string) (float64, float64, error) {
	a, b, ok := strings.Cut(s, ",")
	if !ok {
		return 0, 0, fmt.Errorf("geo: want lat,lon, got %q", s)
	}
	lat, err1 := strconv.ParseFloat(strings.TrimSpace(a), 64)
	lon, err2 := strconv.ParseFloat(strings.TrimSpace(b), 64)
	if err1 != nil || err2 != nil || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return 0, 0, fmt.Errorf("geo: bad coordinates %q", s)
	}
	return lat, lon, nil
}

// STUN servers used to learn the public address. Their operators see one
// UDP packet — the same thing every WebRTC call does.
var stunServers = []string{"stun.l.google.com:19302", "stun.cloudflare.com:3478"}

// PublicAddr asks STUN servers (RFC 5389) for this machine's public address.
func PublicAddr(ctx context.Context) (netip.Addr, error) {
	var lastErr error
	for _, srv := range stunServers {
		ip, err := stunBinding(ctx, srv)
		if err == nil {
			return ip, nil
		}
		lastErr = err
	}
	return netip.Addr{}, lastErr
}

func stunBinding(ctx context.Context, server string) (netip.Addr, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "udp4", server)
	if err != nil {
		return netip.Addr{}, err
	}
	defer conn.Close()
	var req [20]byte
	binary.BigEndian.PutUint16(req[0:], 0x0001) // Binding Request
	binary.BigEndian.PutUint32(req[4:], 0x2112a442)
	rand.Read(req[8:20])
	deadline := time.Now().Add(1500 * time.Millisecond)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	conn.SetDeadline(deadline)
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := conn.Write(req[:]); err != nil {
			return netip.Addr{}, err
		}
		buf := make([]byte, 1024)
		n, err := conn.Read(buf)
		if err != nil {
			continue
		}
		if ip, ok := parseBindingResponse(buf[:n], req[8:20]); ok {
			return ip, nil
		}
	}
	return netip.Addr{}, errors.New("geo: no STUN response from " + server)
}

// parseBindingResponse extracts XOR-MAPPED-ADDRESS (or MAPPED-ADDRESS).
func parseBindingResponse(b, txid []byte) (netip.Addr, bool) {
	if len(b) < 20 || binary.BigEndian.Uint16(b[0:]) != 0x0101 || string(b[8:20]) != string(txid) {
		return netip.Addr{}, false
	}
	attrs := b[20:min(len(b), 20+int(binary.BigEndian.Uint16(b[2:])))]
	var fallback netip.Addr
	for len(attrs) >= 4 {
		typ := binary.BigEndian.Uint16(attrs[0:])
		l := int(binary.BigEndian.Uint16(attrs[2:]))
		if 4+l > len(attrs) {
			break
		}
		v := attrs[4 : 4+l]
		switch {
		case typ == 0x0020 && l >= 8 && v[1] == 1: // XOR-MAPPED-ADDRESS, IPv4
			var a [4]byte
			binary.BigEndian.PutUint32(a[:], binary.BigEndian.Uint32(v[4:8])^0x2112a442)
			return netip.AddrFrom4(a), true
		case typ == 0x0020 && l >= 20 && v[1] == 2: // IPv6: XOR with cookie + txid
			var a [16]byte
			key := append(binary.BigEndian.AppendUint32(nil, 0x2112a442), txid...)
			for i := range 16 {
				a[i] = v[4+i] ^ key[i]
			}
			return netip.AddrFrom16(a), true
		case typ == 0x0001 && l >= 8 && v[1] == 1: // MAPPED-ADDRESS
			fallback = netip.AddrFrom4([4]byte(v[4:8]))
		}
		attrs = attrs[4+(l+3)&^3:]
	}
	return fallback, fallback.IsValid()
}

// FromTimezone estimates the location from the system time zone, using the
// coordinates tzdata ships for every zone (zone1970.tab).
func FromTimezone() (Home, bool) {
	zone := os.Getenv("TZ")
	if zone == "" {
		if link, err := os.Readlink("/etc/localtime"); err == nil {
			if i := strings.Index(link, "zoneinfo/"); i >= 0 {
				zone = link[i+len("zoneinfo/"):]
			}
		}
	}
	zone = strings.TrimPrefix(zone, ":")
	if zone == "" {
		return Home{}, false
	}
	for _, tab := range []string{"zone1970.tab", "zone.tab"} {
		f, err := os.Open(filepath.Join("/usr/share/zoneinfo", tab))
		if err != nil {
			continue
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "#") {
				continue
			}
			fields := strings.Split(line, "\t")
			if len(fields) < 3 || fields[2] != zone {
				continue
			}
			lat, lon, ok := parseISO6709(fields[1])
			if !ok {
				return Home{}, false
			}
			city := zone[strings.LastIndex(zone, "/")+1:]
			cc := fields[0]
			if i := strings.IndexByte(cc, ','); i > 0 {
				cc = cc[:i]
			}
			return Home{Lat: lat, Lon: lon, Known: true, City: strings.ReplaceAll(city, "_", " "), CC: cc, Src: "tz"}, true
		}
	}
	return Home{}, false
}

// parseISO6709 parses "+2232+08822" or "+404251-0740023".
func parseISO6709(s string) (float64, float64, bool) {
	split := strings.IndexAny(s[1:], "+-") + 1
	if split <= 0 {
		return 0, 0, false
	}
	lat, ok1 := dms(s[:split], 2)
	lon, ok2 := dms(s[split:], 3)
	return lat, lon, ok1 && ok2
}

func dms(s string, degDigits int) (float64, bool) {
	if len(s) < 1+degDigits+2 {
		return 0, false
	}
	sign := 1.0
	if s[0] == '-' {
		sign = -1
	}
	d := s[1:]
	deg, err1 := strconv.Atoi(d[:degDigits])
	mins, err2 := strconv.Atoi(d[degDigits : degDigits+2])
	sec := 0
	var err3 error
	if len(d) >= degDigits+4 {
		sec, err3 = strconv.Atoi(d[degDigits+2 : degDigits+4])
	}
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, false
	}
	return sign * (float64(deg) + float64(mins)/60 + float64(sec)/3600), true
}

// Resolve works out the home location: an explicit flag wins; otherwise
// the public address (via STUN) is geolocated locally; otherwise the time
// zone's coordinates are used.
func Resolve(ctx context.Context, flag string, useSTUN bool, loc *Locator) Home {
	if flag != "" {
		if lat, lon, err := ParseLatLon(flag); err == nil {
			return Home{Lat: lat, Lon: lon, Known: true, Src: "flag"}
		}
	}
	if useSTUN && loc != nil && loc.Ready() {
		sctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		ip, err := PublicAddr(sctx)
		cancel()
		if err == nil {
			if l, ok := loc.Locate(ip); ok && l.HasCoord {
				return Home{Lat: l.Lat, Lon: l.Lon, Known: true, City: l.City, CC: l.CC, Src: "stun", PublicIP: ip}
			}
		}
	}
	if h, ok := FromTimezone(); ok {
		return h
	}
	return Home{Src: "none"}
}

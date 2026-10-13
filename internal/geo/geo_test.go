package geo

import (
	"context"
	"encoding/binary"
	"math"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-3 }

func TestISO6709(t *testing.T) {
	for _, tc := range []struct {
		in       string
		lat, lon float64
	}{
		{"+2232+08822", 22 + 32.0/60, 88 + 22.0/60},                      // Asia/Kolkata
		{"+404251-0740023", 40 + 42.0/60 + 51.0/3600, -(74 + 23.0/3600)}, // America/New_York
		{"-3352+15113", -(33 + 52.0/60), 151 + 13.0/60},                  // Australia/Sydney
	} {
		lat, lon, ok := parseISO6709(tc.in)
		if !ok || !near(lat, tc.lat) || !near(lon, tc.lon) {
			t.Errorf("%s → %v,%v ok=%v; want %v,%v", tc.in, lat, lon, ok, tc.lat, tc.lon)
		}
	}
}

func TestFromTimezone(t *testing.T) {
	if _, err := os.Stat("/usr/share/zoneinfo/zone1970.tab"); err != nil {
		t.Skip("no tzdata")
	}
	t.Setenv("TZ", "Asia/Kolkata")
	h, ok := FromTimezone()
	if !ok || h.City != "Kolkata" || h.CC != "IN" || h.Src != "tz" || !near(h.Lat, 22+32.0/60) {
		t.Fatalf("got %+v ok=%v", h, ok)
	}
	t.Setenv("TZ", "America/Argentina/Buenos_Aires")
	if h, ok := FromTimezone(); !ok || h.City != "Buenos Aires" || h.CC != "AR" {
		t.Fatalf("got %+v", h)
	}
}

func TestParseLatLon(t *testing.T) {
	if lat, lon, err := ParseLatLon(" 19.08, 73.10 "); err != nil || lat != 19.08 || lon != 73.10 {
		t.Fatalf("%v %v %v", lat, lon, err)
	}
	for _, bad := range []string{"", "1", "91,0", "0,181", "a,b"} {
		if _, _, err := ParseLatLon(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestSTUNResponseParsing(t *testing.T) {
	txid := []byte("abcdefghijkl")
	resp := make([]byte, 20, 64)
	binary.BigEndian.PutUint16(resp[0:], 0x0101)
	binary.BigEndian.PutUint32(resp[4:], 0x2112a442)
	copy(resp[8:], txid)
	// XOR-MAPPED-ADDRESS for 49.36.100.7:51000
	attr := []byte{0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(attr[6:], 51000^0x2112)
	binary.BigEndian.PutUint32(attr[8:], binary.BigEndian.Uint32([]byte{49, 36, 100, 7})^0x2112a442)
	resp = append(resp, attr...)
	binary.BigEndian.PutUint16(resp[2:], uint16(len(attr)))
	ip, ok := parseBindingResponse(resp, txid)
	if !ok || ip.String() != "49.36.100.7" {
		t.Fatalf("got %v %v", ip, ok)
	}
	if _, ok := parseBindingResponse(resp, []byte("other-txid!!")); ok {
		t.Fatal("accepted a response to another transaction")
	}
}

func TestLocatorWithDBIP(t *testing.T) {
	dir := filepath.Join("..", "..", "data")
	l := NewLocator()
	if err := l.OpenDir(dir); err != nil || !l.Ready() {
		t.Skip("DB-IP databases not downloaded")
	}
	defer l.Close()
	loc, ok := l.Locate(netip.MustParseAddr("160.79.104.10"))
	if !ok || !loc.HasCoord || loc.CC != "US" || loc.City != "San Francisco" || loc.ASN != 399358 {
		t.Fatalf("got %+v", loc)
	}
	if _, ok := l.Locate(netip.MustParseAddr("192.168.29.35")); ok {
		t.Fatal("a private address was located")
	}
	// The second lookup is served from the cache.
	if again, _ := l.Locate(netip.MustParseAddr("160.79.104.11")); again != loc {
		t.Fatalf("cache mismatch %+v", again)
	}
}

func TestLiveSTUN(t *testing.T) {
	if os.Getenv("TELLURIC_NET_TESTS") == "" {
		t.Skip("set TELLURIC_NET_TESTS=1 to run tests that touch the network")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ip, err := PublicAddr(ctx)
	if err != nil || !ip.IsGlobalUnicast() {
		t.Fatalf("%v %v", ip, err)
	}
}

// Package geo locates IP addresses (DB-IP Lite databases read with the
// in-house mmdb reader), keeps those databases up to date, and works out
// where this machine is.
package geo

import (
	"net/netip"
	"path/filepath"
	"strings"
	"sync"

	"github.com/SharvikS/telluric/internal/mmdb"
)

// Location is everything we know about where an address is.
type Location struct {
	HasCoord bool
	Lat, Lon float64
	City     string
	Region   string
	CC       string // ISO 3166-1 alpha-2
	Country  string
	ASN      uint32
	Org      string
}

// Locator answers location queries. A zero Locator (no databases) answers
// nothing; databases can be attached later, once downloaded.
type Locator struct {
	mu        sync.RWMutex
	city, asn *mmdb.DB
	cityCache map[uint]Location
	asnCache  map[uint]Location
}

// Database file names inside the data directory.
const (
	CityFile = "dbip-city-lite.mmdb"
	ASNFile  = "dbip-asn-lite.mmdb"
)

// Credit is the attribution DB-IP's license (CC BY 4.0) requires.
const Credit = "IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0"

// NewLocator returns a locator with no databases attached.
func NewLocator() *Locator {
	return &Locator{cityCache: map[uint]Location{}, asnCache: map[uint]Location{}}
}

// OpenDir attaches whichever databases exist in dir.
func (l *Locator) OpenDir(dir string) error {
	var firstErr error
	if db, err := mmdb.Open(filepath.Join(dir, CityFile)); err == nil {
		l.attach(db, true)
	} else {
		firstErr = err
	}
	if db, err := mmdb.Open(filepath.Join(dir, ASNFile)); err == nil {
		l.attach(db, false)
	} else if firstErr == nil {
		firstErr = err
	}
	return firstErr
}

func (l *Locator) attach(db *mmdb.DB, city bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if city {
		if l.city != nil {
			l.city.Close()
		}
		l.city, l.cityCache = db, map[uint]Location{}
	} else {
		if l.asn != nil {
			l.asn.Close()
		}
		l.asn, l.asnCache = db, map[uint]Location{}
	}
}

// Ready reports whether a city database is attached.
func (l *Locator) Ready() bool {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.city != nil
}

// Locate returns what the databases know about ip. Records are cached by
// their data-section offset: thousands of addresses share one record.
func (l *Locator) Locate(ip netip.Addr) (Location, bool) {
	l.mu.RLock()
	city, asn := l.city, l.asn
	l.mu.RUnlock()
	var loc Location
	found := false
	if city != nil {
		if off, _, ok := city.LookupOffset(ip); ok {
			found = true
			l.mu.RLock()
			c, hit := l.cityCache[off]
			l.mu.RUnlock()
			if !hit {
				c = decodeCity(city, off)
				l.mu.Lock()
				if len(l.cityCache) > 200_000 {
					clear(l.cityCache)
				}
				l.cityCache[off] = c
				l.mu.Unlock()
			}
			loc = c
		}
	}
	if asn != nil {
		if off, _, ok := asn.LookupOffset(ip); ok {
			found = true
			l.mu.RLock()
			a, hit := l.asnCache[off]
			l.mu.RUnlock()
			if !hit {
				rec, _ := asn.Decode(off)
				if n, ok := mmdb.Path(rec, "autonomous_system_number").(uint64); ok {
					a.ASN = uint32(n)
				}
				a.Org, _ = mmdb.Path(rec, "autonomous_system_organization").(string)
				l.mu.Lock()
				if len(l.asnCache) > 200_000 {
					clear(l.asnCache)
				}
				l.asnCache[off] = a
				l.mu.Unlock()
			}
			loc.ASN, loc.Org = a.ASN, a.Org
		}
	}
	return loc, found
}

func decodeCity(db *mmdb.DB, off uint) Location {
	rec, err := db.Decode(off)
	if err != nil {
		return Location{}
	}
	var c Location
	lat, okLat := mmdb.Path(rec, "location", "latitude").(float64)
	lon, okLon := mmdb.Path(rec, "location", "longitude").(float64)
	if okLat && okLon {
		c.HasCoord, c.Lat, c.Lon = true, lat, lon
	}
	c.City = cleanCity(str(mmdb.Path(rec, "city", "names", "en")))
	c.Region = str(mmdb.Path(rec, "subdivisions", 0, "names", "en"))
	c.CC = str(mmdb.Path(rec, "country", "iso_code"))
	c.Country = str(mmdb.Path(rec, "country", "names", "en"))
	return c
}

// cleanCity drops DB-IP's district qualifiers: "San Francisco (Financial
// District)" → "San Francisco".
func cleanCity(s string) string {
	if i := strings.Index(s, " ("); i > 0 && strings.HasSuffix(s, ")") {
		return s[:i]
	}
	return s
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// Close releases the databases.
func (l *Locator) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.city != nil {
		l.city.Close()
		l.city = nil
	}
	if l.asn != nil {
		l.asn.Close()
		l.asn = nil
	}
}

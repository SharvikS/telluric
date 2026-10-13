package mmdb

import (
	"encoding/binary"
	"math"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// ---- a minimal MaxMind DB writer, for tests only ----

type enc struct {
	buf     []byte
	strings map[string]int // already-written strings, for pointers
}

func (e *enc) ctrl(typ, size int) {
	var ext []byte
	first := byte(typ << 5)
	if typ > 7 {
		first = 0
		ext = []byte{byte(typ - 7)}
	}
	var sz []byte
	switch {
	case size < 29:
		first |= byte(size)
	case size < 29+256:
		first |= 29
		sz = []byte{byte(size - 29)}
	case size < 285+65536:
		first |= 30
		sz = binary.BigEndian.AppendUint16(nil, uint16(size-285))
	default:
		first |= 31
		v := size - 65821
		sz = []byte{byte(v >> 16), byte(v >> 8), byte(v)}
	}
	e.buf = append(e.buf, first)
	e.buf = append(e.buf, ext...)
	e.buf = append(e.buf, sz...)
}

func (e *enc) pointer(p int) {
	switch {
	case p < 2048:
		e.buf = append(e.buf, 0x20|byte(p>>8&7), byte(p))
	case p < 2048+1<<19:
		v := p - 2048
		e.buf = append(e.buf, 0x28|byte(v>>16&7), byte(v>>8), byte(v))
	default:
		v := p - 526336
		e.buf = append(e.buf, 0x30|byte(v>>24&7), byte(v>>16), byte(v>>8), byte(v))
	}
}

func (e *enc) value(v any) {
	switch x := v.(type) {
	case string:
		if off, ok := e.strings[x]; ok && e.strings != nil {
			e.pointer(off)
			return
		}
		if e.strings != nil {
			e.strings[x] = len(e.buf)
		}
		e.ctrl(2, len(x))
		e.buf = append(e.buf, x...)
	case float64:
		e.ctrl(3, 8)
		e.buf = binary.BigEndian.AppendUint64(e.buf, math.Float64bits(x))
	case uint32:
		b := binary.BigEndian.AppendUint32(nil, x)
		for len(b) > 0 && b[0] == 0 {
			b = b[1:]
		}
		e.ctrl(6, len(b))
		e.buf = append(e.buf, b...)
	case uint64:
		e.ctrl(9, 8)
		e.buf = binary.BigEndian.AppendUint64(e.buf, x)
	case int32:
		e.ctrl(8, 4)
		e.buf = binary.BigEndian.AppendUint32(e.buf, uint32(x))
	case bool:
		size := 0
		if x {
			size = 1
		}
		e.ctrl(14, size)
	case []any:
		e.ctrl(11, len(x))
		for _, el := range x {
			e.value(el)
		}
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		e.ctrl(7, len(keys))
		for _, k := range keys {
			e.value(k)
			e.value(x[k])
		}
	default:
		panic("unsupported test value")
	}
}

type tnode struct {
	child [2]*tnode
	data  int
} // data ≥ 0: leaf pointing at a data offset

func build(t *testing.T, recordSize int, nets map[string]map[string]any) []byte {
	t.Helper()
	data := &enc{strings: map[string]int{}}
	root := &tnode{data: -1}
	keys := make([]string, 0, len(nets))
	for k := range nets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, cidr := range keys {
		off := len(data.buf)
		data.value(nets[cidr])
		p := netip.MustParsePrefix(cidr)
		var addr [16]byte
		bits := p.Bits()
		if p.Addr().Is4() {
			a := p.Addr().As4()
			copy(addr[12:], a[:]) // IPv4 lives at ::/96 in an IPv6 tree
			bits += 96
		} else {
			addr = p.Addr().As16()
		}
		n := root
		for i := range bits {
			b := addr[i/8] >> (7 - i%8) & 1
			if n.child[b] == nil {
				n.child[b] = &tnode{data: -1}
			}
			n = n.child[b]
		}
		n.data = off
	}
	// Number internal nodes breadth-first.
	var order []*tnode
	index := map[*tnode]int{}
	queue := []*tnode{root}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		if n.data >= 0 {
			continue
		}
		index[n] = len(order)
		order = append(order, n)
		for _, c := range n.child {
			if c != nil {
				queue = append(queue, c)
			}
		}
	}
	count := len(order)
	rec := func(c *tnode) uint32 {
		switch {
		case c == nil:
			return uint32(count)
		case c.data >= 0:
			return uint32(count + 16 + c.data)
		}
		return uint32(index[c])
	}
	var tree []byte
	for _, n := range order {
		l, r := rec(n.child[0]), rec(n.child[1])
		switch recordSize {
		case 24:
			tree = append(tree, byte(l>>16), byte(l>>8), byte(l), byte(r>>16), byte(r>>8), byte(r))
		case 28:
			tree = append(tree, byte(l>>16), byte(l>>8), byte(l), byte(l>>20&0xf0|r>>24&0x0f), byte(r>>16), byte(r>>8), byte(r))
		case 32:
			tree = binary.BigEndian.AppendUint32(tree, l)
			tree = binary.BigEndian.AppendUint32(tree, r)
		}
	}
	out := append(tree, make([]byte, 16)...)
	out = append(out, data.buf...)
	out = append(out, metadataMarker...)
	meta := &enc{}
	meta.value(map[string]any{
		"node_count":    uint32(count),
		"record_size":   uint32(recordSize),
		"ip_version":    uint32(6),
		"database_type": "Telluric-Test",
		"languages":     []any{"en"},
		"build_epoch":   uint64(1760342400),
	})
	return append(out, meta.buf...)
}

var testNets = map[string]map[string]any{
	"8.8.8.0/24": {
		"city":     map[string]any{"names": map[string]any{"en": "Mountain View"}},
		"country":  map[string]any{"iso_code": "US", "names": map[string]any{"en": "United States"}},
		"location": map[string]any{"latitude": 37.386, "longitude": -122.0838},
		"asn":      uint32(15169),
		"anycast":  true,
	},
	"1.1.1.0/24": {
		"city":    map[string]any{"names": map[string]any{"en": "Sydney"}},
		"country": map[string]any{"iso_code": "AU", "names": map[string]any{"en": "Australia"}},
		"note":    strings.Repeat("x", 300), // two-byte extended size
		"offset":  int32(-12345),
		"tags":    []any{"cdn", "dns", "United States"}, // a pointer to an earlier string
	},
	"2405:201::/32": {
		"country":  map[string]any{"iso_code": "IN", "names": map[string]any{"en": "India"}},
		"location": map[string]any{"latitude": 19.0748, "longitude": 72.8856},
	},
}

func TestRecordSizes(t *testing.T) {
	for _, rs := range []int{24, 28, 32} {
		db, err := FromBytes(build(t, rs, testNets))
		if err != nil {
			t.Fatalf("record size %d: %v", rs, err)
		}
		if db.Meta.DatabaseType != "Telluric-Test" || db.Meta.RecordSize != uint(rs) || len(db.Meta.Languages) != 1 {
			t.Fatalf("metadata %+v", db.Meta)
		}

		rec, ok, err := db.Lookup(netip.MustParseAddr("8.8.8.8"))
		if err != nil || !ok {
			t.Fatalf("rs=%d 8.8.8.8: ok=%v err=%v", rs, ok, err)
		}
		if Path(rec, "city", "names", "en") != "Mountain View" || Path(rec, "location", "longitude") != -122.0838 ||
			Path(rec, "asn") != uint64(15169) || Path(rec, "anycast") != true {
			t.Fatalf("rs=%d record %v", rs, rec)
		}

		rec, ok, _ = db.Lookup(netip.MustParseAddr("1.1.1.1"))
		if !ok || Path(rec, "offset") != int64(-12345) || len(Path(rec, "note").(string)) != 300 ||
			Path(rec, "tags", 2) != "United States" || Path(rec, "country", "iso_code") != "AU" {
			t.Fatalf("rs=%d 1.1.1.1 record %v", rs, rec)
		}

		rec, ok, _ = db.Lookup(netip.MustParseAddr("2405:201:1d:5111::35"))
		if !ok || Path(rec, "country", "iso_code") != "IN" {
			t.Fatalf("rs=%d IPv6 record %v ok=%v", rs, rec, ok)
		}
		if _, ok, _ := db.Lookup(netip.MustParseAddr("::ffff:8.8.8.8")); !ok {
			t.Fatalf("rs=%d IPv4-mapped IPv6 address not found", rs)
		}
		for _, miss := range []string{"9.9.9.9", "8.8.9.1", "2001:db8::1"} {
			if _, ok, _ := db.Lookup(netip.MustParseAddr(miss)); ok {
				t.Fatalf("rs=%d %s should not be found", rs, miss)
			}
		}
		off1, plen, _ := db.LookupOffset(netip.MustParseAddr("8.8.8.8"))
		off2, _, _ := db.LookupOffset(netip.MustParseAddr("8.8.8.200"))
		if off1 != off2 || plen != 24 {
			t.Fatalf("rs=%d offsets %d/%d prefix %d", rs, off1, off2, plen)
		}
	}
}

func TestRejectsGarbage(t *testing.T) {
	if _, err := FromBytes([]byte("definitely not a database")); err == nil {
		t.Fatal("garbage accepted")
	}
	db := build(t, 24, testNets)
	for _, n := range []int{len(db) / 2, len(db) - 5} {
		if d, err := FromBytes(db[:n]); err == nil {
			d.Lookup(netip.MustParseAddr("8.8.8.8")) // must not panic
		}
	}
}

func FuzzDecode(f *testing.F) {
	f.Add(build(&testing.T{}, 24, testNets))
	f.Fuzz(func(t *testing.T, b []byte) {
		db, err := FromBytes(b)
		if err != nil {
			return
		}
		for _, ip := range []string{"8.8.8.8", "1.1.1.1", "2405:201::1", "255.255.255.255"} {
			db.Lookup(netip.MustParseAddr(ip))
		}
	})
}

// TestDBIPLite checks the reader against the real DB-IP Lite databases when
// they have been downloaded into ../../data (run `telluric --update-geo`).
func TestDBIPLite(t *testing.T) {
	dir := filepath.Join("..", "..", "data")
	asn, err := Open(filepath.Join(dir, "dbip-asn-lite.mmdb"))
	if err != nil {
		t.Skip("DB-IP ASN database not downloaded")
	}
	defer asn.Close()
	for ip, want := range map[string]uint64{"8.8.8.8": 15169, "1.1.1.1": 13335, "2606:4700:4700::1111": 13335} {
		rec, ok, err := asn.Lookup(netip.MustParseAddr(ip))
		if err != nil || !ok || Path(rec, "autonomous_system_number") != want {
			t.Errorf("%s: %v ok=%v err=%v, want AS%d", ip, rec, ok, err, want)
		}
	}
	city, err := Open(filepath.Join(dir, "dbip-city-lite.mmdb"))
	if err != nil {
		t.Skip("DB-IP City database not downloaded")
	}
	defer city.Close()
	rec, ok, err := city.Lookup(netip.MustParseAddr("8.8.8.8"))
	if err != nil || !ok || Path(rec, "country", "iso_code") != "US" {
		t.Fatalf("8.8.8.8 city record %v ok=%v err=%v", rec, ok, err)
	}
	if _, ok := Path(rec, "location", "latitude").(float64); !ok {
		t.Fatalf("no latitude in %v", rec)
	}
}

func BenchmarkLookup(b *testing.B) {
	path := filepath.Join("..", "..", "data", "dbip-city-lite.mmdb")
	if _, err := os.Stat(path); err != nil {
		b.Skip("DB-IP City database not downloaded")
	}
	db, err := Open(path)
	if err != nil {
		b.Fatal(err)
	}
	defer db.Close()
	ip := netip.MustParseAddr("142.250.183.14")
	b.ReportAllocs()
	for b.Loop() {
		if _, _, ok := db.LookupOffset(ip); !ok {
			b.Fatal("not found")
		}
	}
}

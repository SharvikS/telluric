// Package mmdb reads MaxMind DB files (the format of GeoLite2, GeoIP2 and
// DB-IP databases): a binary search tree over IP address bits whose leaves
// point into a data section of self-describing, pointer-compressed values.
// See https://maxmind.github.io/MaxMind-DB/.
package mmdb

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"net/netip"
	"os"

	"golang.org/x/sys/unix"
)

var (
	// ErrFormat means the file is not a valid MaxMind DB.
	ErrFormat = errors.New("mmdb: invalid database")

	metadataMarker = []byte("\xab\xcd\xefMaxMind.com")
)

// Metadata describes a database.
type Metadata struct {
	NodeCount    uint
	RecordSize   uint
	IPVersion    uint
	DatabaseType string
	BuildEpoch   uint64
	Languages    []string
}

// DB is an open database. Lookups are safe for concurrent use.
type DB struct {
	Meta      Metadata
	buf       []byte
	mapped    bool
	treeSize  uint
	dataStart uint
	ipv4Node  uint // node reached after 96 zero bits: the IPv4-mapped subtree
}

// Open maps the database file read-only.
func Open(path string) (*DB, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() == 0 || st.Size() > 1<<34 {
		return nil, ErrFormat
	}
	buf, err := unix.Mmap(int(f.Fd()), 0, int(st.Size()), unix.PROT_READ, unix.MAP_SHARED)
	if err != nil {
		return nil, fmt.Errorf("mmdb: mmap: %w", err)
	}
	db, err := FromBytes(buf)
	if err != nil {
		_ = unix.Munmap(buf)
		return nil, err
	}
	db.mapped = true
	return db, nil
}

// FromBytes uses an in-memory database image.
func FromBytes(buf []byte) (*DB, error) {
	start := max(0, len(buf)-128<<10)
	i := bytes.LastIndex(buf[start:], metadataMarker)
	if i < 0 {
		return nil, ErrFormat
	}
	metaStart := uint(start + i + len(metadataMarker))
	db := &DB{buf: buf}
	md := decoder{buf: buf, base: metaStart}
	v, _, err := md.decode(metaStart, 0)
	if err != nil {
		return nil, fmt.Errorf("mmdb: metadata: %w", err)
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, ErrFormat
	}
	db.Meta.NodeCount = uint(asUint(m["node_count"]))
	db.Meta.RecordSize = uint(asUint(m["record_size"]))
	db.Meta.IPVersion = uint(asUint(m["ip_version"]))
	db.Meta.DatabaseType, _ = m["database_type"].(string)
	db.Meta.BuildEpoch = asUint(m["build_epoch"])
	if langs, ok := m["languages"].([]any); ok {
		for _, l := range langs {
			if s, ok := l.(string); ok {
				db.Meta.Languages = append(db.Meta.Languages, s)
			}
		}
	}
	switch db.Meta.RecordSize {
	case 24, 28, 32:
	default:
		return nil, fmt.Errorf("%w: record size %d", ErrFormat, db.Meta.RecordSize)
	}
	db.treeSize = db.Meta.RecordSize * 2 / 8 * db.Meta.NodeCount
	db.dataStart = db.treeSize + 16
	if db.Meta.NodeCount == 0 || db.dataStart > metaStart {
		return nil, ErrFormat
	}
	if db.Meta.IPVersion == 6 {
		node := uint(0)
		for range 96 {
			if node >= db.Meta.NodeCount {
				break
			}
			node = db.record(node, 0)
		}
		db.ipv4Node = node
	}
	return db, nil
}

// Close unmaps the database.
func (db *DB) Close() error {
	if db.mapped {
		db.mapped = false
		return unix.Munmap(db.buf)
	}
	return nil
}

// record returns the left (bit 0) or right (bit 1) record of node.
func (db *DB) record(node uint, bit uint) uint {
	switch db.Meta.RecordSize {
	case 24:
		o := node*6 + bit*3
		b := db.buf[o : o+3]
		return uint(b[0])<<16 | uint(b[1])<<8 | uint(b[2])
	case 28:
		o := node * 7
		b := db.buf[o : o+7]
		if bit == 0 {
			return uint(b[3]&0xf0)<<20 | uint(b[0])<<16 | uint(b[1])<<8 | uint(b[2])
		}
		return uint(b[3]&0x0f)<<24 | uint(b[4])<<16 | uint(b[5])<<8 | uint(b[6])
	default:
		o := node*8 + bit*4
		return uint(binary.BigEndian.Uint32(db.buf[o : o+4]))
	}
}

// LookupOffset walks the tree for ip and returns the offset of its record
// in the data section and the prefix length that matched. Many networks
// share a record, so the offset makes an excellent cache key.
func (db *DB) LookupOffset(ip netip.Addr) (offset uint, prefixLen int, ok bool) {
	ip = ip.Unmap()
	var addr [16]byte
	bits := 128
	node := uint(0)
	if ip.Is4() {
		a := ip.As4()
		copy(addr[:], a[:])
		bits = 32
		if db.Meta.IPVersion == 6 {
			node = db.ipv4Node
		}
	} else {
		if db.Meta.IPVersion == 4 {
			return 0, 0, false
		}
		addr = ip.As16()
	}
	n := db.Meta.NodeCount
	i := 0
	for ; i < bits && node < n; i++ {
		bit := uint(addr[i>>3]>>(7-uint(i&7))) & 1
		node = db.record(node, bit)
	}
	if node <= n { // n means "no data"; < n means the address ran out of bits
		return 0, 0, false
	}
	off := node - n - 16
	if db.dataStart+off >= uint(len(db.buf)) {
		return 0, 0, false
	}
	return off, i, true
}

// Decode decodes the value at a data-section offset.
func (db *DB) Decode(offset uint) (any, error) {
	d := decoder{buf: db.buf, base: db.dataStart}
	v, _, err := d.decode(db.dataStart+offset, 0)
	return v, err
}

// Lookup returns the decoded record for ip.
func (db *DB) Lookup(ip netip.Addr) (any, bool, error) {
	off, _, ok := db.LookupOffset(ip)
	if !ok {
		return nil, false, nil
	}
	v, err := db.Decode(off)
	return v, err == nil, err
}

// decoder reads values from buf; pointers are relative to base.
type decoder struct {
	buf  []byte
	base uint
}

const maxDepth = 32

// decode returns the value at absolute offset off and the offset after it.
func (d *decoder) decode(off uint, depth int) (any, uint, error) {
	if depth > maxDepth {
		return nil, 0, fmt.Errorf("%w: nesting too deep", ErrFormat)
	}
	typ, size, off, err := d.ctrl(off)
	if err != nil {
		return nil, 0, err
	}
	if typ == 1 { // pointer: decode the target, continue after the pointer
		v, _, err := d.decode(d.base+size, depth+1)
		return v, off, err
	}
	end := off + size
	switch typ {
	case 2: // UTF-8 string
		if end > uint(len(d.buf)) {
			return nil, 0, ErrFormat
		}
		return string(d.buf[off:end]), end, nil
	case 3: // double
		if size != 8 || end > uint(len(d.buf)) {
			return nil, 0, ErrFormat
		}
		return math.Float64frombits(binary.BigEndian.Uint64(d.buf[off:end])), end, nil
	case 4: // bytes
		if end > uint(len(d.buf)) {
			return nil, 0, ErrFormat
		}
		return bytes.Clone(d.buf[off:end]), end, nil
	case 5, 6, 9: // uint16, uint32, uint64
		if size > 8 || end > uint(len(d.buf)) {
			return nil, 0, ErrFormat
		}
		var v uint64
		for _, b := range d.buf[off:end] {
			v = v<<8 | uint64(b)
		}
		return v, end, nil
	case 10: // uint128: keep the low 64 bits
		if size > 16 || end > uint(len(d.buf)) {
			return nil, 0, ErrFormat
		}
		var v uint64
		for _, b := range d.buf[off:end] {
			v = v<<8 | uint64(b)
		}
		return v, end, nil
	case 8: // int32
		if size > 4 || end > uint(len(d.buf)) {
			return nil, 0, ErrFormat
		}
		var v uint32
		for _, b := range d.buf[off:end] {
			v = v<<8 | uint32(b)
		}
		if size > 0 && size < 4 && v&(1<<(size*8-1)) != 0 {
			v |= ^uint32(0) << (size * 8)
		}
		return int64(int32(v)), end, nil
	case 7: // map
		m := make(map[string]any, min(size, 64))
		for range size {
			k, next, err := d.decode(off, depth+1)
			if err != nil {
				return nil, 0, err
			}
			key, ok := k.(string)
			if !ok {
				return nil, 0, fmt.Errorf("%w: non-string map key", ErrFormat)
			}
			v, next2, err := d.decode(next, depth+1)
			if err != nil {
				return nil, 0, err
			}
			m[key] = v
			off = next2
		}
		return m, off, nil
	case 11: // array
		a := make([]any, 0, min(size, 64))
		for range size {
			v, next, err := d.decode(off, depth+1)
			if err != nil {
				return nil, 0, err
			}
			a = append(a, v)
			off = next
		}
		return a, off, nil
	case 14: // boolean: the value is the size
		return size != 0, off, nil
	case 15: // float
		if size != 4 || end > uint(len(d.buf)) {
			return nil, 0, ErrFormat
		}
		return float64(math.Float32frombits(binary.BigEndian.Uint32(d.buf[off:end]))), end, nil
	}
	return nil, 0, fmt.Errorf("%w: data type %d", ErrFormat, typ)
}

// ctrl decodes a control byte (and any extended type/size bytes) at off.
// For pointers, size is the pointer value.
func (d *decoder) ctrl(off uint) (typ, size, next uint, err error) {
	at := func(i uint) (uint, bool) {
		if i >= uint(len(d.buf)) {
			return 0, false
		}
		return uint(d.buf[i]), true
	}
	c, ok := at(off)
	if !ok {
		return 0, 0, 0, ErrFormat
	}
	off++
	typ = c >> 5
	if typ == 1 {
		ss, vvv := (c>>3)&3, c&7
		n := ss + 1
		if off+n > uint(len(d.buf)) {
			return 0, 0, 0, ErrFormat
		}
		var p uint
		for i := range n {
			p = p<<8 | uint(d.buf[off+i])
		}
		switch ss {
		case 0:
			p |= vvv << 8
		case 1:
			p = (p | vvv<<16) + 2048
		case 2:
			p = (p | vvv<<24) + 526336
		}
		return 1, p, off + n, nil
	}
	if typ == 0 {
		e, ok := at(off)
		if !ok {
			return 0, 0, 0, ErrFormat
		}
		typ = 7 + e
		off++
	}
	size = c & 0x1f
	if size >= 29 {
		n := size - 28
		if off+n > uint(len(d.buf)) {
			return 0, 0, 0, ErrFormat
		}
		var v uint
		for i := range n {
			v = v<<8 | uint(d.buf[off+i])
		}
		off += n
		switch n {
		case 1:
			size = 29 + v
		case 2:
			size = 285 + v
		case 3:
			size = 65821 + v
		}
	}
	return typ, size, off, nil
}

func asUint(v any) uint64 {
	switch x := v.(type) {
	case uint64:
		return x
	case int64:
		return uint64(x)
	case float64:
		return uint64(x)
	}
	return 0
}

// Path follows map keys and array indexes through a decoded value:
// Path(rec, "city", "names", "en").
func Path(v any, keys ...any) any {
	for _, k := range keys {
		switch key := k.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				return nil
			}
			v = m[key]
		case int:
			a, ok := v.([]any)
			if !ok || key < 0 || key >= len(a) {
				return nil
			}
			v = a[key]
		}
	}
	return v
}

package capture

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
)

// Link-layer header types (https://www.tcpdump.org/linktypes.html).
const (
	LinkNull      uint32 = 0   // BSD loopback, host-order address family
	LinkEthernet  uint32 = 1   // Ethernet II
	LinkRaw       uint32 = 101 // raw IPv4/IPv6
	LinkLoop      uint32 = 108 // OpenBSD loopback, network-order address family
	LinkLinuxSLL  uint32 = 113 // Linux cooked capture v1
	LinkIPv4      uint32 = 228
	LinkIPv6      uint32 = 229
	LinkLinuxSLL2 uint32 = 276 // Linux cooked capture v2: adds interface index
)

const (
	pcapMagicMicros = 0xa1b2c3d4
	pcapMagicNanos  = 0xa1b23c4d
	ngSHB           = 0x0a0d0d0a
	ngIDB           = 0x00000001
	ngOPB           = 0x00000002
	ngSPB           = 0x00000003
	ngISB           = 0x00000005
	ngEPB           = 0x00000006
	ngBOM           = 0x1a2b3c4d

	// maxRecord bounds a single record so a corrupt length can't make us
	// allocate gigabytes.
	maxRecord = 1 << 20
)

// ErrFormat is returned for input that is neither pcap nor pcapng.
var ErrFormat = errors.New("capture: not a pcap or pcapng stream")

// Reader decodes pcap and pcapng streams into cooked frames.
type Reader struct {
	br    *bufio.Reader
	order binary.ByteOrder
	ng    bool
	buf   []byte

	// classic pcap
	link  uint32
	nanos bool

	// pcapng: interfaces of the current section
	ifaces []ngIface

	// Skipped counts records with unsupported link types or malformed bodies.
	Skipped uint64
	// IfDrop is the latest drop counter reported by a pcapng interface
	// statistics block (the capture helper emits one every second).
	IfDrop uint64
}

type ngIface struct {
	link    uint32
	snaplen uint32
	tsUnits uint64 // timestamp units per second
	tsPow2  uint8  // non-zero: units are 2^-tsPow2 seconds
	tsOff   int64  // seconds added to every timestamp
}

// NewReader detects the format from the first block and returns a reader.
func NewReader(r io.Reader) (*Reader, error) {
	br, ok := r.(*bufio.Reader)
	if !ok || br.Size() < 1<<16 {
		br = bufio.NewReaderSize(r, 1<<16)
	}
	rd := &Reader{br: br, buf: make([]byte, 0, 1<<16)}
	head, err := br.Peek(4)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrFormat, err)
	}
	if binary.LittleEndian.Uint32(head) == ngSHB {
		rd.ng = true
		if err := rd.readSHB(); err != nil {
			return nil, err
		}
		return rd, nil
	}
	return rd, rd.readPcapHeader()
}

// LinkType returns the link type of a classic pcap stream (pcapng streams
// may mix link types per interface; this returns the first interface's).
func (r *Reader) LinkType() uint32 {
	if r.ng && len(r.ifaces) > 0 {
		return r.ifaces[0].link
	}
	return r.link
}

// Buffered reports how many bytes can be read without blocking.
func (r *Reader) Buffered() int { return r.br.Buffered() }

// BufferedRecord reports whether a complete record is already buffered, so
// that the next call to Next will not block on the underlying reader.
func (r *Reader) BufferedRecord() bool {
	n := r.br.Buffered()
	if r.ng {
		if n < 8 {
			return false
		}
		h, _ := r.br.Peek(8)
		return uint32(n) >= r.order.Uint32(h[4:8])
	}
	if n < 16 {
		return false
	}
	h, _ := r.br.Peek(16)
	return n >= 16+int(r.order.Uint32(h[8:12]))
}

func (r *Reader) readPcapHeader() error {
	var h [24]byte
	if _, err := io.ReadFull(r.br, h[:]); err != nil {
		return fmt.Errorf("%w: %v", ErrFormat, err)
	}
	switch binary.LittleEndian.Uint32(h[0:4]) {
	case pcapMagicMicros:
		r.order = binary.LittleEndian
	case pcapMagicNanos:
		r.order, r.nanos = binary.LittleEndian, true
	default:
		switch binary.BigEndian.Uint32(h[0:4]) {
		case pcapMagicMicros:
			r.order = binary.BigEndian
		case pcapMagicNanos:
			r.order, r.nanos = binary.BigEndian, true
		default:
			return ErrFormat
		}
	}
	r.link = r.order.Uint32(h[20:24]) & 0xffff // upper bits carry FCS info
	return nil
}

// Next reads the next frame into f. f.Data aliases an internal buffer that
// is overwritten by the following call. Records that cannot be cooked (an
// unsupported link type, a truncated header) are skipped and counted.
func (r *Reader) Next(f *Frame) error {
	for {
		var ok bool
		var err error
		if r.ng {
			ok, err = r.nextNG(f)
		} else {
			ok, err = r.nextPcap(f)
		}
		if err != nil || ok {
			return err
		}
		r.Skipped++
	}
}

func (r *Reader) nextPcap(f *Frame) (bool, error) {
	var h [16]byte
	if _, err := io.ReadFull(r.br, h[:]); err != nil {
		if err == io.ErrUnexpectedEOF {
			return false, io.EOF
		}
		return false, err
	}
	sec := int64(r.order.Uint32(h[0:4]))
	frac := int64(r.order.Uint32(h[4:8]))
	incl := r.order.Uint32(h[8:12])
	orig := r.order.Uint32(h[12:16])
	if incl > maxRecord {
		return false, fmt.Errorf("capture: pcap record of %d bytes", incl)
	}
	data, err := r.read(int(incl))
	if err != nil {
		return false, err
	}
	if !r.nanos {
		frac *= 1000
	}
	*f = Frame{TS: sec*1e9 + frac, PktType: PacketUnknown}
	return cook(r.link, data, orig, f), nil
}

func (r *Reader) read(n int) ([]byte, error) {
	if cap(r.buf) < n {
		r.buf = make([]byte, n)
	}
	r.buf = r.buf[:n]
	if _, err := io.ReadFull(r.br, r.buf); err != nil {
		if err == io.ErrUnexpectedEOF {
			return nil, io.EOF
		}
		return nil, err
	}
	return r.buf, nil
}

// readSHB reads a section header block, which resets byte order and the
// interface table.
func (r *Reader) readSHB() error {
	var h [12]byte
	if _, err := io.ReadFull(r.br, h[:]); err != nil {
		return fmt.Errorf("%w: %v", ErrFormat, err)
	}
	switch {
	case binary.LittleEndian.Uint32(h[8:12]) == ngBOM:
		r.order = binary.LittleEndian
	case binary.BigEndian.Uint32(h[8:12]) == ngBOM:
		r.order = binary.BigEndian
	default:
		return ErrFormat
	}
	total := r.order.Uint32(h[4:8])
	if total < 28 || total > maxRecord || total%4 != 0 {
		return ErrFormat
	}
	if _, err := r.br.Discard(int(total) - 12); err != nil {
		return io.EOF
	}
	r.ifaces = r.ifaces[:0]
	return nil
}

func (r *Reader) nextNG(f *Frame) (bool, error) {
	head, err := r.br.Peek(8)
	if err != nil {
		if err == io.ErrUnexpectedEOF {
			err = io.EOF
		}
		return false, err
	}
	if binary.LittleEndian.Uint32(head) == ngSHB {
		return false, r.readSHB()
	}
	typ := r.order.Uint32(head[0:4])
	total := r.order.Uint32(head[4:8])
	if total < 12 || total%4 != 0 || total > maxRecord {
		return false, fmt.Errorf("capture: pcapng block length %d", total)
	}
	blk, err := r.read(int(total))
	if err != nil {
		return false, err
	}
	body := blk[8 : total-4]
	switch typ {
	case ngIDB:
		return false, r.parseIDB(body)
	case ngEPB:
		return r.parseEPB(body, f), nil
	case ngSPB:
		return r.parseSPB(body, f), nil
	case ngOPB:
		return r.parseOPB(body, f), nil
	case ngISB:
		if len(body) >= 12 {
			r.walkOptions(body[12:], func(code uint16, v []byte) {
				if code == 5 && len(v) >= 8 { // isb_ifdrop
					r.IfDrop = r.order.Uint64(v)
				}
			})
		}
	}
	return false, nil // other block types carry nothing we need
}

func (r *Reader) parseIDB(b []byte) error {
	if len(b) < 8 {
		return fmt.Errorf("capture: short pcapng interface block")
	}
	ifc := ngIface{link: uint32(r.order.Uint16(b[0:2])), snaplen: r.order.Uint32(b[4:8]), tsUnits: 1e6}
	r.walkOptions(b[8:], func(code uint16, v []byte) {
		switch {
		case code == 9 && len(v) >= 1: // if_tsresol
			if v[0]&0x80 != 0 {
				ifc.tsPow2 = v[0] & 0x7f
				ifc.tsUnits = 0
			} else if exp := v[0]; exp <= 19 {
				ifc.tsUnits = 1
				for range exp {
					ifc.tsUnits *= 10
				}
			}
		case code == 14 && len(v) >= 8: // if_tsoffset
			ifc.tsOff = int64(r.order.Uint64(v))
		}
	})
	r.ifaces = append(r.ifaces, ifc)
	return nil
}

func (r *Reader) parseEPB(b []byte, f *Frame) bool {
	if len(b) < 20 {
		return false
	}
	id := r.order.Uint32(b[0:4])
	ts := uint64(r.order.Uint32(b[4:8]))<<32 | uint64(r.order.Uint32(b[8:12]))
	capLen := r.order.Uint32(b[12:16])
	orig := r.order.Uint32(b[16:20])
	if int(id) >= len(r.ifaces) || uint64(capLen) > uint64(len(b)-20) {
		return false
	}
	ifc := &r.ifaces[id]
	*f = Frame{TS: ifc.nanos(ts), Ifindex: int32(id) + 1, PktType: PacketUnknown}
	optStart := 20 + (int(capLen)+3)&^3
	if optStart <= len(b) {
		r.walkOptions(b[optStart:], func(code uint16, v []byte) {
			if code == 2 && len(v) >= 4 { // epb_flags: bits 0–1 are the direction
				switch r.order.Uint32(v) & 3 {
				case 1:
					f.PktType = PacketHost
				case 2:
					f.PktType = PacketOutgoing
				}
			}
		})
	}
	pt := f.PktType
	if !cook(ifc.link, b[20:20+capLen], orig, f) {
		return false
	}
	if f.PktType == PacketUnknown {
		f.PktType = pt
	}
	return true
}

func (r *Reader) parseSPB(b []byte, f *Frame) bool {
	if len(b) < 4 || len(r.ifaces) == 0 {
		return false
	}
	orig := r.order.Uint32(b[0:4])
	data := b[4:]
	capLen := min(uint32(len(data)), orig)
	if s := r.ifaces[0].snaplen; s != 0 && capLen > s {
		capLen = s
	}
	*f = Frame{Ifindex: 1, PktType: PacketUnknown} // simple packets carry no timestamp
	return cook(r.ifaces[0].link, data[:capLen], orig, f)
}

func (r *Reader) parseOPB(b []byte, f *Frame) bool {
	if len(b) < 20 {
		return false
	}
	id := r.order.Uint16(b[0:2])
	ts := uint64(r.order.Uint32(b[4:8]))<<32 | uint64(r.order.Uint32(b[8:12]))
	capLen := r.order.Uint32(b[12:16])
	orig := r.order.Uint32(b[16:20])
	if int(id) >= len(r.ifaces) || uint64(capLen) > uint64(len(b)-20) {
		return false
	}
	*f = Frame{TS: r.ifaces[id].nanos(ts), Ifindex: int32(id) + 1, PktType: PacketUnknown}
	return cook(r.ifaces[id].link, b[20:20+capLen], orig, f)
}

func (r *Reader) walkOptions(b []byte, fn func(code uint16, v []byte)) {
	for len(b) >= 4 {
		code := r.order.Uint16(b[0:2])
		n := int(r.order.Uint16(b[2:4]))
		if code == 0 || 4+n > len(b) {
			return
		}
		fn(code, b[4:4+n])
		b = b[min(len(b), 4+(n+3)&^3):]
	}
}

func (i *ngIface) nanos(units uint64) int64 {
	var ns int64
	switch {
	case i.tsPow2 != 0:
		ns = int64(float64(units) * 1e9 / math.Ldexp(1, int(i.tsPow2)))
	case i.tsUnits >= 1e9:
		ns = int64(units / (i.tsUnits / 1e9))
	default:
		ns = int64(units * (1e9 / i.tsUnits))
	}
	return ns + i.tsOff*1e9
}

// cook strips the link-layer header of data according to link and fills the
// metadata fields of f. It reports false for frames that carry no network
// layer we understand.
func cook(link uint32, data []byte, orig uint32, f *Frame) bool {
	hdr := 0
	switch link {
	case LinkEthernet:
		if len(data) < 14 {
			return false
		}
		f.Proto = binary.BigEndian.Uint16(data[12:14])
		if f.Proto < 0x0600 { // 802.3 length field: LLC frames
			return false
		}
		f.HAType = ARPHRDEther
		f.HALen = 6
		copy(f.HAddr[:], data[6:12])
		hdr = 14
	case LinkLinuxSLL:
		if len(data) < 16 {
			return false
		}
		f.PktType = uint8(binary.BigEndian.Uint16(data[0:2]))
		f.HAType = binary.BigEndian.Uint16(data[2:4])
		f.HALen = uint8(min(binary.BigEndian.Uint16(data[4:6]), 8))
		copy(f.HAddr[:], data[6:14])
		f.Proto = binary.BigEndian.Uint16(data[14:16])
		hdr = 16
	case LinkLinuxSLL2:
		if len(data) < 20 {
			return false
		}
		f.Proto = binary.BigEndian.Uint16(data[0:2])
		f.Ifindex = int32(binary.BigEndian.Uint32(data[4:8]))
		f.HAType = binary.BigEndian.Uint16(data[8:10])
		f.PktType = data[10]
		f.HALen = min(data[11], 8)
		copy(f.HAddr[:], data[12:20])
		hdr = 20
	case LinkRaw, 12, 14, LinkIPv4, LinkIPv6:
		if len(data) == 0 {
			return false
		}
		switch data[0] >> 4 {
		case 4:
			f.Proto = 0x0800
		case 6:
			f.Proto = 0x86dd
		default:
			return false
		}
		f.HAType = ARPHRDNone
	case LinkNull, LinkLoop:
		if len(data) < 4 {
			return false
		}
		var fam uint32
		if link == LinkLoop {
			fam = binary.BigEndian.Uint32(data[0:4])
		} else {
			fam = binary.LittleEndian.Uint32(data[0:4])
			if fam > 0xffff { // written on a big-endian host
				fam = binary.BigEndian.Uint32(data[0:4])
			}
		}
		switch fam {
		case 2:
			f.Proto = 0x0800
		case 24, 28, 30: // AF_INET6 on NetBSD/OpenBSD, FreeBSD, Darwin
			f.Proto = 0x86dd
		default:
			return false
		}
		f.HAType = ARPHRDLoopback
		hdr = 4
	default:
		return false
	}
	f.Data = data[hdr:]
	if int(orig) >= hdr {
		f.WireLen = orig - uint32(hdr)
	} else {
		f.WireLen = uint32(len(f.Data))
	}
	return true
}

// Writer emits a classic pcap stream with nanosecond timestamps.
type Writer struct {
	bw   *bufio.Writer
	link uint32
	rec  [16 + 20]byte
}

// NewWriter writes a pcap file header for link and returns a writer.
func NewWriter(w io.Writer, link uint32, snaplen uint32) (*Writer, error) {
	pw := &Writer{bw: bufio.NewWriterSize(w, 1<<16), link: link}
	var h [24]byte
	binary.LittleEndian.PutUint32(h[0:], pcapMagicNanos)
	binary.LittleEndian.PutUint16(h[4:], 2)
	binary.LittleEndian.PutUint16(h[6:], 4)
	binary.LittleEndian.PutUint32(h[16:], snaplen)
	binary.LittleEndian.PutUint32(h[20:], link)
	_, err := pw.bw.Write(h[:])
	return pw, err
}

// WriteFrame writes f as a LINKTYPE_LINUX_SLL2 record, which preserves the
// interface index, direction and link-layer address of cooked frames.
func (w *Writer) WriteFrame(f *Frame) error {
	if w.link != LinkLinuxSLL2 {
		return w.WritePacket(f.TS, f.Data, f.WireLen)
	}
	r := w.rec[:]
	sec, nsec := f.TS/1e9, f.TS%1e9
	binary.LittleEndian.PutUint32(r[0:], uint32(sec))
	binary.LittleEndian.PutUint32(r[4:], uint32(nsec))
	binary.LittleEndian.PutUint32(r[8:], uint32(20+len(f.Data)))
	binary.LittleEndian.PutUint32(r[12:], 20+f.WireLen)
	s := r[16:]
	binary.BigEndian.PutUint16(s[0:], f.Proto)
	s[2], s[3] = 0, 0
	binary.BigEndian.PutUint32(s[4:], uint32(f.Ifindex))
	binary.BigEndian.PutUint16(s[8:], f.HAType)
	s[10] = f.PktType
	s[11] = f.HALen
	copy(s[12:20], f.HAddr[:])
	if _, err := w.bw.Write(r); err != nil {
		return err
	}
	_, err := w.bw.Write(f.Data)
	return err
}

// WritePacket writes one record whose data already carries the stream's
// link-layer header (for LinkRaw: a bare IP packet).
func (w *Writer) WritePacket(ts int64, data []byte, origLen uint32) error {
	r := w.rec[:16]
	binary.LittleEndian.PutUint32(r[0:], uint32(ts/1e9))
	binary.LittleEndian.PutUint32(r[4:], uint32(ts%1e9))
	binary.LittleEndian.PutUint32(r[8:], uint32(len(data)))
	binary.LittleEndian.PutUint32(r[12:], max(origLen, uint32(len(data))))
	if _, err := w.bw.Write(r); err != nil {
		return err
	}
	_, err := w.bw.Write(data)
	return err
}

// Flush writes buffered records to the underlying writer.
func (w *Writer) Flush() error { return w.bw.Flush() }

// NGWriter emits a pcapng stream with a single LINKTYPE_LINUX_SLL2 interface,
// nanosecond timestamps, direction flags and periodic statistics blocks.
// It is the capture helper's output format; Wireshark reads it natively.
type NGWriter struct {
	bw  *bufio.Writer
	blk []byte
}

// NewNGWriter writes the section header and interface description.
func NewNGWriter(w io.Writer, snaplen uint32) (*NGWriter, error) {
	nw := &NGWriter{bw: bufio.NewWriterSize(w, 1<<16)}
	shb := make([]byte, 28)
	binary.LittleEndian.PutUint32(shb[0:], ngSHB)
	binary.LittleEndian.PutUint32(shb[4:], 28)
	binary.LittleEndian.PutUint32(shb[8:], ngBOM)
	binary.LittleEndian.PutUint16(shb[12:], 1)
	binary.LittleEndian.PutUint64(shb[16:], ^uint64(0)) // section length unknown
	binary.LittleEndian.PutUint32(shb[24:], 28)
	idb := make([]byte, 32)
	binary.LittleEndian.PutUint32(idb[0:], ngIDB)
	binary.LittleEndian.PutUint32(idb[4:], 32)
	binary.LittleEndian.PutUint16(idb[8:], uint16(LinkLinuxSLL2))
	binary.LittleEndian.PutUint32(idb[12:], snaplen)
	binary.LittleEndian.PutUint16(idb[16:], 9) // if_tsresol = 10^-9
	binary.LittleEndian.PutUint16(idb[18:], 1)
	idb[20] = 9
	// idb[24:28] is opt_endofopt
	binary.LittleEndian.PutUint32(idb[28:], 32)
	if _, err := nw.bw.Write(shb); err != nil {
		return nil, err
	}
	_, err := nw.bw.Write(idb)
	return nw, err
}

// WriteFrame writes f as an enhanced packet block.
func (w *NGWriter) WriteFrame(f *Frame) error {
	capLen := 20 + len(f.Data)
	padded := (capLen + 3) &^ 3
	total := 28 + padded + 12 + 4 // header, data, epb_flags + endofopt, trailer
	if cap(w.blk) < total {
		w.blk = make([]byte, total)
	}
	b := w.blk[:total]
	clear(b)
	binary.LittleEndian.PutUint32(b[0:], ngEPB)
	binary.LittleEndian.PutUint32(b[4:], uint32(total))
	ts := uint64(f.TS)
	binary.LittleEndian.PutUint32(b[12:], uint32(ts>>32))
	binary.LittleEndian.PutUint32(b[16:], uint32(ts))
	binary.LittleEndian.PutUint32(b[20:], uint32(capLen))
	binary.LittleEndian.PutUint32(b[24:], 20+f.WireLen)
	s := b[28:]
	binary.BigEndian.PutUint16(s[0:], f.Proto)
	binary.BigEndian.PutUint32(s[4:], uint32(f.Ifindex))
	binary.BigEndian.PutUint16(s[8:], f.HAType)
	s[10] = f.PktType
	s[11] = f.HALen
	copy(s[12:20], f.HAddr[:])
	copy(s[20:], f.Data)
	o := b[28+padded:]
	binary.LittleEndian.PutUint16(o[0:], 2) // epb_flags
	binary.LittleEndian.PutUint16(o[2:], 4)
	switch f.PktType {
	case PacketOutgoing:
		binary.LittleEndian.PutUint32(o[4:], 2)
	case PacketHost, PacketBroadcast, PacketMulticast, PacketOtherHost:
		binary.LittleEndian.PutUint32(o[4:], 1)
	}
	binary.LittleEndian.PutUint32(b[total-4:], uint32(total))
	_, err := w.bw.Write(b)
	return err
}

// WriteStats writes an interface statistics block with the received and
// dropped counters.
func (w *NGWriter) WriteStats(ts int64, recv, drop uint64) error {
	const total = 20 + 12 + 12 + 4 + 4
	var b [total]byte
	binary.LittleEndian.PutUint32(b[0:], ngISB)
	binary.LittleEndian.PutUint32(b[4:], total)
	binary.LittleEndian.PutUint32(b[12:], uint32(uint64(ts)>>32))
	binary.LittleEndian.PutUint32(b[16:], uint32(ts))
	binary.LittleEndian.PutUint16(b[20:], 4) // isb_ifrecv
	binary.LittleEndian.PutUint16(b[22:], 8)
	binary.LittleEndian.PutUint64(b[24:], recv)
	binary.LittleEndian.PutUint16(b[32:], 5) // isb_ifdrop
	binary.LittleEndian.PutUint16(b[34:], 8)
	binary.LittleEndian.PutUint64(b[36:], drop)
	binary.LittleEndian.PutUint32(b[total-4:], total)
	_, err := w.bw.Write(b[:])
	return err
}

// Flush writes buffered blocks to the underlying writer.
func (w *NGWriter) Flush() error { return w.bw.Flush() }

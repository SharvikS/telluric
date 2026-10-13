//go:build linux

package capture

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// RingOptions configure a TPACKET_V3 capture ring.
type RingOptions struct {
	Interface string        // capture on one interface; "" or "any" for all
	BlockSize int           // bytes per block, a power-of-two multiple of the page size (default 1 MiB)
	Blocks    int           // blocks in the ring (default 64)
	Snaplen   int           // in-kernel truncation of each frame (default 4096)
	Retire    time.Duration // hand over a partially filled block after this long (default 10 ms)
}

// Ring is a Source reading a memory-mapped TPACKET_V3 ring. The kernel
// fills whole blocks of frames; Read walks a block in place — no system
// call per frame, no copies — and then returns the block to the kernel.
type Ring struct {
	opt  RingOptions
	name string

	mu     sync.Mutex // held while the ring memory is in use
	fd     int
	wake   int // eventfd that interrupts poll on Close
	ring   []byte
	cur    int
	closed atomic.Bool

	received atomic.Uint64
	statsMu  sync.Mutex
	dropped  uint64
}

// Offsets into struct tpacket_block_desc / tpacket_hdr_v1 and tpacket3_hdr.
const (
	blkStatus     = 8
	blkNumPkts    = 12
	blkFirstPkt   = 16
	pktNextOff    = 0
	pktSec        = 4
	pktNsec       = 8
	pktSnaplen    = 12
	pktLen        = 16
	pktNet        = 26
	pktSockaddrLL = 48 // TPACKET_ALIGN(sizeof(struct tpacket3_hdr))

	tpStatusKernel = 0
	tpStatusUser   = 1

	maxBlocksPerRead = 8
)

// ErrPermission means the process may not open packet sockets.
var ErrPermission = errors.New("capture: raw sockets need CAP_NET_RAW (run as root, use the capture helper, or join the wireshark group)")

// OpenRing opens a packet socket on opt.Interface and maps its ring.
func OpenRing(opt RingOptions) (*Ring, error) {
	if opt.BlockSize == 0 {
		opt.BlockSize = 1 << 20
	}
	if opt.Blocks == 0 {
		opt.Blocks = 64
	}
	if opt.Snaplen == 0 {
		opt.Snaplen = 4096
	}
	if opt.Retire == 0 {
		// Hand partly filled blocks over quickly: process attribution races
		// short-lived clients, and every millisecond of latency counts.
		opt.Retire = 10 * time.Millisecond
	}
	if opt.BlockSize%os.Getpagesize() != 0 || opt.BlockSize&(opt.BlockSize-1) != 0 {
		return nil, fmt.Errorf("capture: block size %d is not a power-of-two multiple of the page size", opt.BlockSize)
	}

	ifindex := 0
	name := "any"
	if opt.Interface != "" && opt.Interface != "any" {
		ifc, err := net.InterfaceByName(opt.Interface)
		if err != nil {
			return nil, err
		}
		ifindex, name = ifc.Index, ifc.Name
	}

	// Protocol 0: receive nothing until the ring and filter are in place.
	fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.EPERM) || errors.Is(err, unix.EACCES) {
			return nil, ErrPermission
		}
		return nil, fmt.Errorf("capture: socket: %w", err)
	}
	r := &Ring{opt: opt, name: "ring:" + name, fd: fd, wake: -1}
	fail := func(what string, err error) (*Ring, error) {
		r.teardown()
		return nil, fmt.Errorf("capture: %s: %w", what, err)
	}

	if err := unix.SetsockoptInt(fd, unix.SOL_PACKET, unix.PACKET_VERSION, unix.TPACKET_V3); err != nil {
		return fail("TPACKET_V3", err)
	}
	// Classic BPF "ret #snaplen": accept everything, truncated in the kernel.
	prog := []unix.SockFilter{{Code: unix.BPF_RET | unix.BPF_K, K: uint32(opt.Snaplen)}}
	if err := unix.SetsockoptSockFprog(fd, unix.SOL_SOCKET, unix.SO_ATTACH_FILTER, &unix.SockFprog{Len: 1, Filter: &prog[0]}); err != nil {
		return fail("attach filter", err)
	}
	const frameSize = 1 << 11
	req := unix.TpacketReq3{
		Block_size:     uint32(opt.BlockSize),
		Block_nr:       uint32(opt.Blocks),
		Frame_size:     frameSize,
		Frame_nr:       uint32(opt.BlockSize / frameSize * opt.Blocks),
		Retire_blk_tov: uint32(opt.Retire / time.Millisecond),
	}
	if err := unix.SetsockoptTpacketReq3(fd, unix.SOL_PACKET, unix.PACKET_RX_RING, &req); err != nil {
		return fail("PACKET_RX_RING", err)
	}
	if err := r.mapRing(); err != nil {
		return fail("map", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrLinklayer{Protocol: htons(unix.ETH_P_ALL), Ifindex: ifindex}); err != nil {
		return fail("bind", err)
	}
	return r, nil
}

func (r *Ring) mapRing() error {
	var err error
	r.ring, err = unix.Mmap(r.fd, 0, r.opt.BlockSize*r.opt.Blocks, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED|unix.MAP_POPULATE)
	if err != nil {
		return err
	}
	r.wake, err = unix.Eventfd(0, unix.EFD_CLOEXEC|unix.EFD_NONBLOCK)
	return err
}

// FD returns the packet socket, for handing the ring to another process
// image (see telluric-capture).
func (r *Ring) FD() int { return r.fd }

// Options returns the ring's configuration (defaults filled in).
func (r *Ring) Options() RingOptions { return r.opt }

// AdoptRing maps the ring of a packet socket that was opened and
// configured by OpenRing in an earlier process image and inherited across
// execve. Mapping an existing ring needs no privileges.
func AdoptRing(fd int, opt RingOptions, name string) (*Ring, error) {
	if opt.BlockSize == 0 || opt.Blocks == 0 {
		return nil, fmt.Errorf("capture: adopt: ring geometry required")
	}
	unix.CloseOnExec(fd)
	r := &Ring{opt: opt, name: name, fd: fd, wake: -1}
	if err := r.mapRing(); err != nil {
		r.teardown()
		return nil, fmt.Errorf("capture: adopt ring: %w", err)
	}
	return r, nil
}

func htons(v uint16) uint16 { return v<<8 | v>>8 }

// Name implements Source.
func (r *Ring) Name() string { return r.name }

func (r *Ring) block(i int) []byte {
	return r.ring[i*r.opt.BlockSize : (i+1)*r.opt.BlockSize]
}

func blockStatus(b []byte) *uint32 { return (*uint32)(unsafe.Pointer(&b[blkStatus])) }

// Read implements Source.
func (r *Ring) Read(timeout time.Duration, fn func(*Frame)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed.Load() {
		return ErrClosed
	}
	if atomic.LoadUint32(blockStatus(r.block(r.cur)))&tpStatusUser == 0 {
		fds := []unix.PollFd{
			{Fd: int32(r.fd), Events: unix.POLLIN | unix.POLLERR},
			{Fd: int32(r.wake), Events: unix.POLLIN},
		}
		if _, err := unix.Poll(fds, int(timeout/time.Millisecond)); err != nil && !errors.Is(err, unix.EINTR) {
			return fmt.Errorf("capture: poll: %w", err)
		}
		if r.closed.Load() {
			return ErrClosed
		}
	}
	for range maxBlocksPerRead {
		blk := r.block(r.cur)
		status := blockStatus(blk)
		if atomic.LoadUint32(status)&tpStatusUser == 0 {
			break
		}
		r.walk(blk, fn)
		atomic.StoreUint32(status, tpStatusKernel)
		r.cur = (r.cur + 1) % r.opt.Blocks
	}
	return nil
}

// walk delivers every frame of a filled block.
func (r *Ring) walk(blk []byte, fn func(*Frame)) {
	ne := binary.NativeEndian
	n := int(ne.Uint32(blk[blkNumPkts:]))
	off := int(ne.Uint32(blk[blkFirstPkt:]))
	var f Frame
	delivered := 0
	for range n {
		if off <= 0 || off+pktSockaddrLL+20 > len(blk) {
			break
		}
		h := blk[off:]
		next := int(ne.Uint32(h[pktNextOff:]))
		snap := int(ne.Uint32(h[pktSnaplen:]))
		netOff := int(ne.Uint16(h[pktNet:]))
		sll := h[pktSockaddrLL:]
		f = Frame{
			TS:      int64(ne.Uint32(h[pktSec:]))*1e9 + int64(ne.Uint32(h[pktNsec:])),
			Ifindex: int32(ne.Uint32(sll[4:8])),
			Proto:   binary.BigEndian.Uint16(sll[2:4]),
			HAType:  ne.Uint16(sll[8:10]),
			PktType: sll[10],
			HALen:   min(sll[11], 8),
			WireLen: ne.Uint32(h[pktLen:]),
		}
		copy(f.HAddr[:], sll[12:20])
		if netOff+snap <= len(h) {
			f.Data = h[netOff : netOff+snap : netOff+snap]
			// Like libpcap, skip the outgoing copy of loopback traffic: the
			// kernel delivers every loopback packet twice.
			if !(f.HAType == ARPHRDLoopback && f.PktType == PacketOutgoing) {
				fn(&f)
				delivered++
			}
		}
		if next == 0 {
			break
		}
		off += next
	}
	r.received.Add(uint64(delivered))
}

// Stats implements Source. The kernel resets its counters on every read,
// so drops are accumulated here.
func (r *Ring) Stats() Stats {
	r.statsMu.Lock()
	defer r.statsMu.Unlock()
	if !r.closed.Load() {
		if st, err := unix.GetsockoptTpacketStatsV3(r.fd, unix.SOL_PACKET, unix.PACKET_STATISTICS); err == nil {
			r.dropped += uint64(st.Drops)
		}
	}
	return Stats{Received: r.received.Load(), Dropped: r.dropped}
}

// Close implements Source. It interrupts a blocked Read and waits for it.
func (r *Ring) Close() error {
	if r.closed.Swap(true) {
		return nil
	}
	if r.wake >= 0 {
		var one [8]byte
		binary.NativeEndian.PutUint64(one[:], 1)
		_, _ = unix.Write(r.wake, one[:])
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.statsMu.Lock()
	defer r.statsMu.Unlock()
	r.teardown()
	return nil
}

func (r *Ring) teardown() {
	if r.ring != nil {
		_ = unix.Munmap(r.ring)
		r.ring = nil
	}
	if r.wake >= 0 {
		_ = unix.Close(r.wake)
		r.wake = -1
	}
	if r.fd >= 0 {
		_ = unix.Close(r.fd)
		r.fd = -1
	}
}

// CanCapture reports whether this process may open packet sockets.
func CanCapture() bool {
	fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return false
	}
	unix.Close(fd)
	return true
}

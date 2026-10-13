// Package capture provides packet sources: the TPACKET_V3 ring, pcap/pcapng
// files and streams (the privileged helper, dumpcap, replays) and synthetic
// traffic. All of them deliver cooked frames: network-layer bytes plus the
// metadata a Linux SOCK_DGRAM packet socket reports.
package capture

import (
	"errors"
	"time"
)

// Packet types reported by Linux packet sockets (linux/if_packet.h).
const (
	PacketHost      uint8 = 0 // addressed to us
	PacketBroadcast uint8 = 1
	PacketMulticast uint8 = 2
	PacketOtherHost uint8 = 3 // addressed to someone else (promiscuous)
	PacketOutgoing  uint8 = 4 // sent by us
	PacketUnknown   uint8 = 0xff
)

// ARPHRD hardware types we care about (linux/if_arp.h).
const (
	ARPHRDEther    uint16 = 1
	ARPHRDNone     uint16 = 0xfffe // tun devices
	ARPHRDLoopback uint16 = 772
	ARPHRDIPGRE    uint16 = 778
)

// Frame is one captured frame in cooked form.
type Frame struct {
	TS      int64  // Unix nanoseconds
	Ifindex int32  // 0 when unknown
	PktType uint8  // Packet* constant
	Proto   uint16 // EtherType of Data
	HAType  uint16 // ARPHRD type of the interface
	HALen   uint8
	HAddr   [8]byte // link-layer source address
	WireLen uint32  // original network-layer length, before any truncation
	Data    []byte  // captured network-layer bytes; valid only during the callback
}

// Outgoing reports whether the kernel saw the frame being sent by this host.
func (f *Frame) Outgoing() bool { return f.PktType == PacketOutgoing }

// Stats are cumulative source counters.
type Stats struct {
	Received uint64 // frames delivered to the engine
	Dropped  uint64 // frames lost because the consumer fell behind
}

// Source delivers frames in batches.
type Source interface {
	// Name describes the source for logs and the UI.
	Name() string
	// Read waits up to timeout for frames and calls fn for each frame that
	// is available. Frame.Data is only valid during fn. Read returns nil on
	// timeout and io.EOF when a finite source is exhausted.
	Read(timeout time.Duration, fn func(*Frame)) error
	// Stats returns cumulative counters.
	Stats() Stats
	// Close releases the source; a blocked Read returns ErrClosed.
	Close() error
}

// ErrClosed is returned by Read after Close.
var ErrClosed = errors.New("capture: source closed")

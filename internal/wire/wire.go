// Package wire defines the messages the engine streams to the browser, as
// specified in docs/PROTOCOL.md: JSON text frames for state and a compact
// binary frame for animated packets.
package wire

import (
	"encoding/binary"
	"encoding/json"
	"math"
)

// Version is the protocol version announced in Hello.V.
const Version = 1

// Home is where this machine is on the globe.
type Home struct {
	Lat  *float64 `json:"lat"`
	Lon  *float64 `json:"lon"`
	City string   `json:"city,omitempty"`
	CC   string   `json:"cc,omitempty"`
	Src  string   `json:"src"` // flag | stun | tz | none
}

// Hello is the first frame of every session.
type Hello struct {
	T        string          `json:"t"`
	V        int             `json:"v"`
	Server   string          `json:"server"`
	Mode     string          `json:"mode"`
	Host     string          `json:"host"`
	Now      int64           `json:"now"`
	Home     Home            `json:"home"`
	Ifaces   []string        `json:"ifaces"`
	Features map[string]bool `json:"features"`
	Credits  []string        `json:"credits"`
}

// Endpoint is a remote address this machine exchanged packets with.
type Endpoint struct {
	ID       uint32   `json:"id"`
	IP       string   `json:"ip"`
	Name     string   `json:"name,omitempty"`
	Names    []string `json:"names,omitempty"`
	Scope    string   `json:"scope"`
	Lat      *float64 `json:"lat"`
	Lon      *float64 `json:"lon"`
	City     string   `json:"city,omitempty"`
	Region   string   `json:"region,omitempty"`
	CC       string   `json:"cc,omitempty"`
	Country  string   `json:"country,omitempty"`
	ASN      uint32   `json:"asn,omitempty"`
	Org      string   `json:"org,omitempty"`
	Svc      string   `json:"svc,omitempty"`
	Threat   int      `json:"threat"`
	Tags     []string `json:"tags,omitempty"`
	First    int64    `json:"first"`
	Last     int64    `json:"last"`
	BytesIn  uint64   `json:"bytesIn"`
	BytesOut uint64   `json:"bytesOut"`
	RateIn   float64  `json:"rateIn"`
	RateOut  float64  `json:"rateOut"`
	Flows    int      `json:"flows"`
}

// Flow is one transport conversation.
type Flow struct {
	ID       uint32   `json:"id"`
	EP       uint32   `json:"ep"`
	Proc     uint32   `json:"proc"`
	Proto    string   `json:"proto"`
	App      string   `json:"app"`
	LPort    uint16   `json:"lport"`
	RPort    uint16   `json:"rport"`
	Dir      string   `json:"dir"`
	State    string   `json:"state"`
	SNI      string   `json:"sni,omitempty"`
	ALPN     string   `json:"alpn,omitempty"`
	TLSv     string   `json:"tlsv,omitempty"`
	JA4      string   `json:"ja4,omitempty"`
	ECH      bool     `json:"ech,omitempty"`
	PQ       bool     `json:"pq,omitempty"`
	BytesIn  uint64   `json:"bytesIn"`
	BytesOut uint64   `json:"bytesOut"`
	PktsIn   uint64   `json:"pktsIn"`
	PktsOut  uint64   `json:"pktsOut"`
	RateIn   float64  `json:"rateIn"`
	RateOut  float64  `json:"rateOut"`
	RTT      *float64 `json:"rtt"`
	Start    int64    `json:"start"`
	Last     int64    `json:"last"`
	Threat   int      `json:"threat"`
}

// Proc is a local process with network activity.
type Proc struct {
	ID        uint32  `json:"id"`
	PID       int     `json:"pid"`
	Name      string  `json:"name"`
	Exe       string  `json:"exe,omitempty"`
	Cmd       string  `json:"cmd,omitempty"`
	User      string  `json:"user,omitempty"`
	Unit      string  `json:"unit,omitempty"`
	Container *string `json:"container"`
	BytesIn   uint64  `json:"bytesIn"`
	BytesOut  uint64  `json:"bytesOut"`
	RateIn    float64 `json:"rateIn"`
	RateOut   float64 `json:"rateOut"`
	Flows     int     `json:"flows"`
}

// DNSEvent is one DNS transaction observed on the wire.
type DNSEvent struct {
	TS      int64    `json:"ts"`
	Q       string   `json:"q"`
	QType   string   `json:"qtype"`
	Rcode   string   `json:"rcode"`
	Answers []string `json:"answers"`
	CNAME   []string `json:"cname,omitempty"`
	EPs     []uint32 `json:"eps"`
	Server  string   `json:"server"`
	MS      *float64 `json:"ms"`
	Proc    uint32   `json:"proc"`
}

// Alert is a detector finding.
type Alert struct {
	ID       uint32         `json:"id"`
	TS       int64          `json:"ts"`
	Sev      string         `json:"sev"`
	Kind     string         `json:"kind"`
	Title    string         `json:"title"`
	Detail   string         `json:"detail"`
	EP       uint32         `json:"ep"`
	Flow     uint32         `json:"flow"`
	Proc     uint32         `json:"proc"`
	Score    int            `json:"score"`
	Evidence map[string]any `json:"evidence,omitempty"`
}

// Totals are cumulative counters.
type Totals struct {
	RX   uint64 `json:"rx"`
	TX   uint64 `json:"tx"`
	Pkts uint64 `json:"pkts"`
}

// Stats are global counters, sent about four times a second.
type Stats struct {
	TS        int64              `json:"ts"`
	RX        float64            `json:"rx"`
	TX        float64            `json:"tx"`
	PPS       float64            `json:"pps"`
	Flows     int                `json:"flows"`
	EPs       int                `json:"eps"`
	Countries int                `json:"countries"`
	Procs     int                `json:"procs"`
	Drops     uint64             `json:"drops"`
	Defcon    int                `json:"defcon"`
	Apps      map[string]float64 `json:"apps"`
	Totals    Totals             `json:"totals"`
}

// Snapshot is the full state sent right after Hello.
type Snapshot struct {
	T         string     `json:"t"`
	Endpoints []Endpoint `json:"endpoints"`
	Flows     []Flow     `json:"flows"`
	Procs     []Proc     `json:"procs"`
	Alerts    []Alert    `json:"alerts"`
	DNS       []DNSEvent `json:"dns"`
	Stats     Stats      `json:"stats"`
	History   []Stats    `json:"history"`
	Traces    []Trace    `json:"traces"`
}

// Gone lists expired entities.
type Gone struct {
	T      string   `json:"t"`
	EPs    []uint32 `json:"eps,omitempty"`
	Flows  []uint32 `json:"flows,omitempty"`
	Procs  []uint32 `json:"procs,omitempty"`
	Traces []uint32 `json:"traces,omitempty"`
}

// Hop is one router on a traced path.
type Hop struct {
	N     int      `json:"n"`
	IP    string   `json:"ip"`
	Name  string   `json:"name,omitempty"`
	RTT   float64  `json:"rtt"`
	Scope string   `json:"scope"`
	Lat   *float64 `json:"lat"`
	Lon   *float64 `json:"lon"`
	City  string   `json:"city,omitempty"`
	CC    string   `json:"cc,omitempty"`
	ASN   uint32   `json:"asn,omitempty"`
	Org   string   `json:"org,omitempty"`
}

// Trace is a path reconstructed from a traceroute/mtr seen on the wire.
type Trace struct {
	ID   uint32 `json:"id"`
	Dst  string `json:"dst"`
	Name string `json:"name,omitempty"`
	TS   int64  `json:"ts"`
	Done bool   `json:"done"`
	Hops []Hop  `json:"hops"`
}

type items[T any] struct {
	T     string `json:"t"`
	Items []T    `json:"items"`
}

type statsMsg struct {
	T string `json:"t"`
	Stats
}

type homeMsg struct {
	T    string `json:"t"`
	Home Home   `json:"home"`
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // every message type is plain data; this is a programming error
	}
	return b
}

// EncodeHello encodes a hello frame.
func EncodeHello(h Hello) []byte { h.T, h.V = "hello", Version; return mustJSON(h) }

// EncodeHome encodes a home-changed frame.
func EncodeHome(h Home) []byte { return mustJSON(homeMsg{"home", h}) }

// EncodeSnapshot encodes a snapshot frame.
func EncodeSnapshot(s Snapshot) []byte { s.T = "snapshot"; return mustJSON(s) }

// EncodeEndpoints encodes an endpoint upsert frame.
func EncodeEndpoints(v []Endpoint) []byte { return mustJSON(items[Endpoint]{"ep", v}) }

// EncodeFlows encodes a flow upsert frame.
func EncodeFlows(v []Flow) []byte { return mustJSON(items[Flow]{"flow", v}) }

// EncodeProcs encodes a process upsert frame.
func EncodeProcs(v []Proc) []byte { return mustJSON(items[Proc]{"proc", v}) }

// EncodeDNS encodes a DNS event frame.
func EncodeDNS(v []DNSEvent) []byte { return mustJSON(items[DNSEvent]{"dns", v}) }

// EncodeAlerts encodes an alert frame.
func EncodeAlerts(v []Alert) []byte { return mustJSON(items[Alert]{"alert", v}) }

// EncodeTraces encodes a traced-path frame.
func EncodeTraces(v []Trace) []byte { return mustJSON(items[Trace]{"trace", v}) }

// EncodeGone encodes an expiry frame.
func EncodeGone(g Gone) []byte { g.T = "gone"; return mustJSON(g) }

// EncodeStats encodes a stats frame.
func EncodeStats(s Stats) []byte { return mustJSON(statsMsg{"stats", s}) }

// Pong is the reply to a client ping.
var Pong = []byte(`{"t":"pong"}`)

// Binary message types.
const (
	MsgPkts byte = 0x01
)

// Shot is one animated packet (or aggregate of packets) on a flow's arc.
type Shot struct {
	Flow    uint32
	Bytes   uint32
	DT      uint16 // milliseconds after the batch base time
	Pkts    uint8
	Inbound bool
}

// PktsHeaderSize and PktsRecordSize describe the PKTS frame layout.
const (
	PktsHeaderSize = 12
	PktsRecordSize = 12
)

// AppendPkts appends a PKTS frame for shots, which happened base Unix
// milliseconds plus their DT, to dst.
func AppendPkts(dst []byte, base float64, shots []Shot) []byte {
	n := min(len(shots), math.MaxUint16)
	dst = append(dst, MsgPkts, 1)
	dst = binary.LittleEndian.AppendUint16(dst, uint16(n))
	dst = binary.LittleEndian.AppendUint64(dst, math.Float64bits(base))
	for _, s := range shots[:n] {
		dst = binary.LittleEndian.AppendUint32(dst, s.Flow)
		dst = binary.LittleEndian.AppendUint32(dst, s.Bytes)
		dst = binary.LittleEndian.AppendUint16(dst, s.DT)
		flags := byte(0)
		if s.Inbound {
			flags = 1
		}
		dst = append(dst, s.Pkts, flags)
	}
	return dst
}

// Float returns a pointer to v, for optional JSON numbers.
func Float(v float64) *float64 { return &v }

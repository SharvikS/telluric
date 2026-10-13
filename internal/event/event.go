// Package event defines what the engine tells observers (the detectors)
// and how observers report back. It sits between engine and detect so
// neither depends on the other.
package event

import (
	"net/netip"

	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/decode"
)

// Flow is a read-only view of a flow. The engine reuses the value between
// calls: copy anything you keep.
type Flow struct {
	ID       uint32
	EP       uint32
	Proc     uint32
	ProcName string
	PID      int
	Proto    uint8
	Local    netip.AddrPort
	Remote   netip.AddrPort
	Out      bool // this machine initiated
	App      string
	State    string
	SNI      string
	HTTPHost string
	JA4      string
	Name     string // the endpoint's best name
	Svc      string // well-known service of the endpoint, "" if none
	Scope    string // public | lan | local | multicast
	Located  bool
	CC       string
	Org      string
	ASN      uint32
	First    int64 // ns
	Last     int64
	BytesIn  uint64
	BytesOut uint64
	PktsIn   uint64
	PktsOut  uint64
	RTT      float64 // ms, 0 if unknown
}

// DNS is a completed DNS transaction (a response, matched to its query
// when the query was seen).
type DNS struct {
	Client   netip.AddrPort
	Server   netip.AddrPort
	Name     string
	QType    uint16
	Rcode    uint8
	Answers  []netip.Addr
	CNAMEs   []string
	Proc     uint32
	ProcName string
}

// Severity of an alert.
type Severity uint8

// Severities, in increasing order.
const (
	Info Severity = iota
	Low
	Medium
	High
	Critical
)

var sevNames = [...]string{"info", "low", "medium", "high", "critical"}

func (s Severity) String() string { return sevNames[s] }

// Alert is a detector finding.
type Alert struct {
	// Key deduplicates: raising an alert with the key of a recent one
	// updates that alert instead of creating another.
	Key      string
	Sev      Severity
	Kind     string
	Title    string
	Detail   string
	Score    int // 0–100
	Flow     uint32
	EP       uint32
	Proc     uint32
	Remote   netip.Addr // the remote address involved, if any
	Evidence map[string]any
}

// Sink receives findings.
type Sink interface {
	Raise(Alert)
	// SetDefcon publishes the global threat level, 5 (calm) to 1.
	SetDefcon(level int)
}

// Observer watches the engine. All methods run on the engine goroutine and
// must return quickly.
type Observer interface {
	// Attach hands the observer the sink for its findings; it is called
	// once, before any other method.
	Attach(sink Sink)
	FlowStart(now int64, f *Flow)
	FlowUpdate(now int64, f *Flow) // new facts: SNI, process, …
	FlowEnd(now int64, f *Flow)
	DNS(now int64, d *DNS)
	ARP(now int64, a *decode.ARP, f *capture.Frame)
	Cleartext(now int64, f *Flow, what string)
	Miner(now int64, f *Flow)
	// Volume reports a flow whose upload grew by another few megabytes.
	Volume(now int64, f *Flow)
	// Tick runs once a second; detectors evaluate windows and raise alerts.
	Tick(now int64)
}

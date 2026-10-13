package engine

import (
	"net/netip"

	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/geo"
	"github.com/SharvikS/telluric/internal/procmap"
)

// App is an application protocol.
type App uint8

// Application protocols, matching the protocol's "app" enumeration.
const (
	AppUnknown App = iota
	AppTLS
	AppQUIC
	AppHTTP
	AppDNS
	AppDoH
	AppDoT
	AppSSH
	AppNTP
	AppMDNS
	AppSSDP
	AppDHCP
	AppSTUN
	AppWireGuard
	AppOpenVPN
	AppBitTorrent
	AppSMTP
	AppIMAP
	AppPOP3
	AppFTP
	AppTelnet
	AppRDP
	AppICMP
	numApps
)

var appNames = [numApps]string{
	"unknown", "tls", "quic", "http", "dns", "doh", "dot", "ssh", "ntp", "mdns", "ssdp", "dhcp",
	"stun", "wireguard", "openvpn", "bittorrent", "smtp", "imap", "pop3", "ftp", "telnet", "rdp", "icmp",
}

func (a App) String() string { return appNames[a] }

type tcpState uint8

const (
	tcpNone tcpState = iota
	tcpSyn
	tcpEst
	tcpFin
	tcpRst
	tcpClosed
)

var tcpStateNames = [...]string{"active", "syn", "est", "fin", "rst", "closed"}

// flowKey identifies a conversation, oriented from this machine's side.
type flowKey struct {
	proto  uint8
	local  netip.AddrPort
	remote netip.AddrPort
}

type flow struct {
	id   uint32
	key  flowKey
	ep   *endpoint
	proc *proc
	app  App

	out   bool // this machine initiated
	state tcpState
	first int64 // ns
	last  int64

	bytesIn, bytesOut uint64
	pktsIn, pktsOut   uint64
	accIn, accOut     uint64 // bytes since the last rate update
	rateIn, rateOut   float64

	// TCP
	isn        uint32 // client's initial sequence number
	haveISN    bool
	synTS      int64
	synackTS   int64
	synRetrans bool
	rtt        float64 // ms; 0 when unknown
	finIn      bool
	finOut     bool

	// TLS / QUIC
	hello *helloState
	sni   string
	alpn  string
	ja4   string
	tlsv  uint16
	ech   bool
	pq    bool

	httpHost string
	payloads int // client payload segments inspected for classification

	threat      int
	volReported uint64 // bytesOut at the last Volume report
	dirty       bool
	procTries   uint8
	procNext    int64 // ns: earliest next attribution attempt
	shotIdx     [2]int32
	shotCnt     [2]uint8
}

func (f *flow) isTCP() bool { return f.key.proto == decode.ProtoTCP }

type nameSource uint8

const (
	nameNone nameSource = iota
	nameOrg
	nameRDNS
	nameHTTP
	nameSNI
	nameDNS
)

type endpoint struct {
	id      uint32
	ip      netip.Addr
	scope   string
	loc     geo.Location
	located bool

	name    string
	nameSrc nameSource
	names   []string // resolved DNS names, most recent first
	svc     string
	tags    []string

	first, last       int64
	bytesIn, bytesOut uint64
	accIn, accOut     uint64
	rateIn, rateOut   float64
	flows             int
	threat            int
	dirty             bool
	idleSince         int64
}

type proc struct {
	id    uint32
	key   procmap.Key
	info  procmap.Process
	first int64
	last  int64

	bytesIn, bytesOut uint64
	accIn, accOut     uint64
	rateIn, rateOut   float64
	flows             int
	dirty             bool
	idleSince         int64
}

// wellKnownPorts maps server ports to the protocol they usually carry; the
// payload sniffers refine the guess.
var wellKnownPorts = map[uint16]App{
	53: AppDNS, 853: AppDoT, 5353: AppMDNS, 5355: AppDNS, 1900: AppSSDP, 67: AppDHCP, 68: AppDHCP, 123: AppNTP,
	546: AppDHCP, 547: AppDHCP, // DHCPv6
	22: AppSSH, 21: AppFTP, 23: AppTelnet, 25: AppSMTP, 465: AppSMTP, 587: AppSMTP,
	143: AppIMAP, 993: AppIMAP, 110: AppPOP3, 995: AppPOP3, 3389: AppRDP,
	51820: AppWireGuard, 1194: AppOpenVPN, 3478: AppSTUN, 19302: AppSTUN,
	80: AppHTTP, 8080: AppHTTP, 443: AppTLS, 8443: AppTLS,
}

// classifyPorts guesses the app from the ports alone.
func classifyPorts(proto uint8, local, remote uint16) App {
	if proto == decode.ProtoICMP || proto == decode.ProtoICMPv6 {
		return AppICMP
	}
	if a, ok := wellKnownPorts[remote]; ok {
		if a == AppTLS && proto == decode.ProtoUDP {
			return AppQUIC
		}
		return a
	}
	if a, ok := wellKnownPorts[local]; ok && local < 1024 {
		if a == AppTLS && proto == decode.ProtoUDP {
			return AppQUIC
		}
		return a
	}
	if 6881 <= remote && remote <= 6889 || 6881 <= local && local <= 6889 {
		return AppBitTorrent
	}
	return AppUnknown
}

// classifyPayload refines the app from a payload, or returns AppUnknown.
func classifyPayload(proto uint8, b []byte) App {
	if len(b) == 0 {
		return AppUnknown
	}
	if proto == decode.ProtoTCP {
		switch {
		case len(b) >= 3 && b[0] == 0x16 && b[1] == 3 && b[2] <= 4:
			return AppTLS
		case decode.IsSSHBanner(b):
			return AppSSH
		case decode.IsBitTorrent(b):
			return AppBitTorrent
		}
		if _, ok := decode.ParseHTTPRequest(b); ok {
			return AppHTTP
		}
		return AppUnknown
	}
	if proto != decode.ProtoUDP {
		// ICMP and others carry no application payload. (An IPv6 MLDv2
		// report — record type 4, zero padding, 16-byte addresses — even
		// looks exactly like a WireGuard data message.)
		return AppUnknown
	}
	switch {
	case decode.IsSTUN(b):
		return AppSTUN
	case decode.IsWireGuard(b):
		return AppWireGuard
	case decode.IsBitTorrent(b):
		return AppBitTorrent
	case len(b) >= 1200 && b[0]&0xc0 == 0xc0:
		if h, err := decode.ParseQUICLongHeader(b); err == nil && h.Type == 0 {
			return AppQUIC
		}
	}
	return AppUnknown
}

// dohResolvers are public DNS-over-HTTPS endpoints; TLS to them carries DNS.
var dohResolvers = map[netip.Addr]bool{}

var dohNames = map[string]bool{
	"mozilla.cloudflare-dns.com": true, "cloudflare-dns.com": true, "one.one.one.one": true,
	"dns.google": true, "dns.google.com": true, "dns.quad9.net": true, "dns11.quad9.net": true,
	"doh.opendns.com": true, "dns.nextdns.io": true, "doh.dns.sb": true, "dns.adguard-dns.com": true,
	"chrome.cloudflare-dns.com": true, "doh.cleanbrowsing.org": true, "dns.mullvad.net": true,
}

func init() {
	for _, s := range []string{
		"1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112", "208.67.222.222", "208.67.220.220",
		"94.140.14.14", "94.140.15.15", "45.90.28.0", "45.90.30.0",
		"2606:4700:4700::1111", "2606:4700:4700::1001", "2001:4860:4860::8888", "2001:4860:4860::8844",
		"2620:fe::fe", "2620:fe::9",
	} {
		dohResolvers[netip.MustParseAddr(s)] = true
	}
}

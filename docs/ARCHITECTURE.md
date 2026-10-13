# Architecture

Telluric is a single static Go binary (the engine plus the embedded web UI)
and an optional, small privileged capture helper. Everything between the
network card and the pixels on the globe was written for this project: the
packet ring reader, the protocol decoders, the QUIC decryption, the MaxMind DB
reader, the WebSocket server, the anomaly detectors and the WebGL2 renderer.
The only dependency outside the standard library is `golang.org/x/sys`.

```
               ┌───────────────────────── kernel ─────────────────────────┐
 wlan0, eth0 ─►│ AF_PACKET (SOCK_DGRAM, ETH_P_ALL) → TPACKET_V3 mmap ring │
               └──────────────────────────┬───────────────────────────────┘
                     zero-copy frames, or │ a pcap stream from the
                  privileged helper/dumpcap│ (privilege separation)
               ┌──────────────────────────▼───────────────────────────────┐
               │ decode: IPv4/IPv6/TCP/UDP/ICMP/ARP, DNS, TLS ClientHello │
               │ (SNI, ALPN, JA4), QUIC Initial decryption (RFC 9001)     │
               └──────────────────────────┬───────────────────────────────┘
                                          │ Packet (no heap allocations)
               ┌──────────────────────────▼──────────────┐    ┌───────────┐
               │ engine (single-owner event loop)        │◄───┤ procmap   │
               │  flow table · TCP state machine · RTT   │◄───┤ geo/MMDB  │
               │  stream reassembly · passive DNS        │◄───┤ intel     │
               └───────┬──────────────────────┬──────────┘    └───────────┘
                       │ snapshots, deltas    │ flow, DNS, ARP events
                       │                ┌─────▼──────────────────────────┐
                       │                │ detectors: intel · beacon ·    │
                       │                │ DGA · tunnel · scan · exfil ·  │
                       │◄── alerts ─────┤ cleartext · ARP · miner · HST  │
               ┌───────▼──────────────┐ └────────────────────────────────┘
               │ hub: per-client      │
               │ queues, backpressure │
               │ RFC 6455 WebSocket   │
               └───────┬──────────────┘
                       │ JSON (state) + binary (packet shots)
               ┌───────▼──────────────────────────────────────────────────┐
               │ browser: WebGL2 globe, GPU-animated arcs and packets,    │
               │ HUD, alert theatre — or the built-in demo simulator      │
               └──────────────────────────────────────────────────────────┘
```

## Design decisions

### Capture: TPACKET_V3, cooked mode, all interfaces

The engine opens one `AF_PACKET`/`SOCK_DGRAM` socket bound to every
interface and maps a `TPACKET_V3` ring into its address space. The kernel
fills 1 MiB blocks with frames and hands over whole blocks, so the hot path
has no system call per packet and no copies. Cooked mode (`SOCK_DGRAM`)
strips link-layer headers but keeps the metadata that matters: interface
index, EtherType and packet type, which says whether the kernel sent or
received the packet. That makes direction detection exact and lets
Wi-Fi, Ethernet, loopback, WireGuard and tun devices share one code path.
Like libpcap, the engine drops the outgoing copy of loopback packets, which
the kernel otherwise delivers twice.

A classic BPF program truncates frames to 4 KiB in the kernel. That is enough
for every header and for a full TLS ClientHello, while keeping GRO
super-packets (up to 64 KiB) from flooding the ring. The original length is
still reported, so byte counters stay exact.

### Privilege separation

Raw sockets need `CAP_NET_RAW`. Instead of running a protocol parser that
digests attacker-controlled bytes as root, Telluric can split capture into
`telluric-capture`, a tiny helper that does nothing but open the ring and
stream frames to stdout as standard pcap (`LINKTYPE_LINUX_SLL2`). It holds the
capability; the engine does not. This mirrors Wireshark's
`dumpcap`. Telluric can use `dumpcap` itself when the user is in the
`wireshark` group. Because the stream is ordinary pcap, it can also be piped
into Wireshark.

Source selection, in order: in-process ring (if the engine has `CAP_NET_RAW`),
helper, `dumpcap`, otherwise a clear error suggesting `--demo`.

### Decoding without allocations

Decoders fill a caller-owned `Packet` value whose payload slices alias the
ring buffer. Nothing escapes to the heap on the hot path; state that must
outlive a frame (a reassembly buffer, a name) is copied explicitly. Addresses
are `netip.Addr`, a comparable value type, so flow keys are plain structs
usable as map keys. Every decoder is covered by Go fuzz tests and by
differential tests against Wireshark's dissectors (`tshark`).

### Seeing names inside encrypted traffic

* **Passive DNS.** DNS responses on the wire map addresses to the names this
  machine asked for, following CNAME chains. A connection to
  `142.250.183.14` is labeled `www.youtube.com` because we watched it being
  resolved, not because of a reverse lookup that would say `bom12s19-in-f14.1e100.net`.
* **TLS ClientHello.** The first client→server bytes of each TCP flow are
  reassembled until the whole ClientHello is in. That matters because
  post-quantum key shares push it past one segment. From it the engine extracts
  SNI, ALPN, the offered TLS versions, Encrypted Client Hello and a **JA4**
  fingerprint.
* **QUIC.** HTTP/3 encrypts everything, but RFC 9001 derives the keys for
  Initial packets from the client's destination connection ID, which is sent
  in clear text. The engine derives them (HKDF-SHA256), removes header
  protection (AES-ECB), decrypts with AES-128-GCM, reassembles CRYPTO frames
  by offset (browsers split and shuffle them), and parses the ClientHello
  inside. Same SNI, ALPN and JA4 as TCP.

### Single-owner event loop

The flow table has exactly one owner: the capture goroutine. It decodes a
block of frames and updates flows inline, with no locks and no channel send
per packet. Slow work runs on separate goroutines that post results back
through a channel the loop drains between blocks. That includes `/proc`
scans for process attribution, threat-feed refreshes and geolocation-database
loads. Output is computed on a 50 ms tick: aggregated packet shots, flow
deltas and stats. It goes to a hub where each WebSocket client has a bounded
queue. A slow browser tab loses packet shots (they're cosmetic), never state.

### Process attribution

`/proc/net/{tcp,tcp6,udp,udp6}` map socket tuples to inodes;
`/proc/<pid>/fd/*` map inodes to processes. Scans are rate-limited and only
triggered by unattributed flows. The cgroup path adds context: systemd unit,
Flatpak app, Docker container. Running unprivileged, the engine can only see
its own user's processes, which is usually what the user wants to see anyway.

### Geolocation

DB-IP Lite databases (CC BY 4.0) in MaxMind DB format, read by an in-house
reader over a read-only `mmap`. Lookups walk the binary search tree directly,
and decoded records are cached by data offset, since thousands of addresses
share a record. The home location comes from a STUN binding request (the
public address is geolocated locally), falling back to the coordinates of the
system time zone in `zone1970.tab`, or to `--home lat,lon`.

### Detection

Detectors subscribe to flow, DNS and ARP events and emit scored alerts:

| Detector   | Signal                                                                   |
|------------|--------------------------------------------------------------------------|
| intel      | IP/domain on abuse.ch Feodo/SSLBL/URLhaus/ThreatFox, Spamhaus DROP, Tor exits |
| beacon     | Periodic connections with low jitter (median interval, MAD, Bowley skew) |
| dga        | Algorithmically generated domains: character bigram model, entropy, NXDOMAIN bursts |
| tunnel     | DNS tunneling: long high-entropy labels, many unique subdomains per apex |
| scan       | Inbound/outbound port and host sweeps                                    |
| exfil      | Upload volume to unfamiliar destinations versus the process's baseline   |
| cleartext  | Credentials in clear text: HTTP Basic, FTP, Telnet, POP3, IMAP           |
| arp-spoof  | Gateway MAC changes, one MAC claiming several IPs                        |
| miner      | Stratum mining protocol handshakes                                       |
| anomaly    | Streaming Half-Space Trees over per-flow features                        |

The global threat level ("DEFCON") is a decayed, severity-weighted sum of
recent alerts.

### Security of the UI

The engine sees every connection the machine makes, so the UI is treated as
sensitive. The server listens on loopback only, requires a random session
token, verifies `Origin` against `Host` to defeat cross-site WebSocket
hijacking, and rejects non-loopback `Host` headers to defeat DNS rebinding.

## Repository layout

```
cmd/telluric            engine CLI
cmd/telluric-capture    privileged capture helper
internal/capture        packet sources: TPACKET_V3 ring, pcap/pcapng, helper, synthetic
internal/decode         protocol decoders
internal/flow           flow table and TCP state
internal/engine         the event loop that ties everything together
internal/geo            MaxMind DB reader, DB-IP downloads, home location
internal/procmap        socket → process attribution
internal/intel          threat-intelligence feeds
internal/detect         anomaly detectors
internal/ws             RFC 6455 WebSocket implementation
internal/server         HTTP server, auth, hub
web/ui                  the WebGL2 front end (embedded into the binary)
tools/geogen            builds the globe's map textures from Natural Earth
docs                    protocol and design documents
```

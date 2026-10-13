# Telluric wire protocol — v1

The engine streams everything it knows to the browser over a single WebSocket.
Low-rate, structured state travels as JSON text frames; the high-rate packet
stream travels as compact binary frames. The browser's demo simulator emits the
exact same messages, so every UI code path is exercised identically in demo,
replay and live modes.

## Transport and auth

* Endpoint: `GET /ws` on the same origin that served the UI.
* The server prints a URL such as `http://127.0.0.1:7777/?token=4f9c…` at
  startup. Opening it sets an `HttpOnly; SameSite=Strict` cookie
  (`telluric_session`), so the WebSocket handshake is authenticated
  automatically.
* Clients may also pass the token explicitly: `/ws?token=4f9c…`. The UI keeps
  the token from its own URL in `sessionStorage` and strips it from the
  address bar.
* The server rejects handshakes whose `Origin` does not match its `Host`
  (cross-site WebSocket hijacking) and whose `Host` is not a loopback name or
  address (DNS rebinding).

## Conventions

| Thing        | Representation                                                  |
|--------------|-----------------------------------------------------------------|
| Timestamps   | Unix epoch **milliseconds** (number)                            |
| Byte counts  | number (exact up to 2^53)                                       |
| Rates        | bytes per second, exponentially smoothed (τ ≈ 2 s)              |
| IDs          | positive integers assigned by the server, never reused in a run |
| Absent value | `null` or omitted field — clients must accept both              |

Upserts always carry the **complete current object**, never a patch. A client
can blindly replace its copy by `id`.

## Server → client: JSON frames

Every text frame is one JSON object with a type tag `t`.

### `hello` — always the first frame

```json
{
  "t": "hello",
  "v": 1,
  "server": "telluric/0.1.0",
  "mode": "live",
  "host": "cachyos",
  "now": 1760342400000,
  "home": { "lat": 18.52, "lon": 73.86, "city": "Pune", "cc": "IN", "src": "stun" },
  "ifaces": ["wlan0"],
  "features": { "procs": true, "geo": true, "intel": true },
  "credits": ["IP geolocation by DB-IP (https://db-ip.com)"]
}
```

* `mode`: `live` | `replay` | `demo`.
* `home.src`: how the home location was found: `flag` | `stun` | `tz` | `none`.
  When `none`, `lat`/`lon` are `null`; render the home beacon at 0,0 and
  don't draw arcs until a `home` message arrives.
* `features`: capabilities of this engine instance; absent means `false`.
* `credits`: attribution strings the UI must display (data licenses).

### `home` — home location changed

```json
{ "t": "home", "home": { "lat": 18.52, "lon": 73.86, "city": "Pune", "cc": "IN", "src": "stun" } }
```

### `snapshot` — always the second frame

The full current state, so a freshly connected client can draw the world
immediately.

```json
{
  "t": "snapshot",
  "endpoints": [Endpoint, ...],
  "flows":     [Flow, ...],
  "procs":     [Proc, ...],
  "alerts":    [Alert, ...],
  "dns":       [DnsEvent, ...],
  "stats":     Stats,
  "history":   [Stats, ...],
  "traces":    [Trace, ...]
}
```

`history` holds up to 300 one-second `Stats` samples, oldest first, for
seeding throughput graphs.

### `ep`, `flow`, `proc` — upserts

```json
{ "t": "ep",   "items": [Endpoint, ...] }
{ "t": "flow", "items": [Flow, ...] }
{ "t": "proc", "items": [Proc, ...] }
```

Sent whenever an entity is created or changes (new name, geolocation, process
attribution, threat score…) and periodically (≈2 Hz) for entities with traffic
so that byte counters and rates stay fresh.

### `gone` — entities expired

```json
{ "t": "gone", "eps": [12, 40], "flows": [77, 78, 79], "procs": [5], "traces": [2] }
```

Clients should fade these out rather than pop them. All arrays are
optional.

### `dns` — DNS transactions observed on the wire

```json
{ "t": "dns", "items": [DnsEvent, ...] }
```

### `alert` — detector findings

```json
{ "t": "alert", "items": [Alert, ...] }
```

An alert with an `id` the client already knows is an update (for example,
the beacon count rose); replace it.

### `trace` — a path traced by traceroute / mtr / tracepath

When the machine runs a traceroute, the engine matches each outgoing
low-TTL probe with the ICMP "time exceeded" that quotes it, and streams the
reconstructed path. Paths update as hops answer (mtr re-probes), and expire
with a `gone.traces` entry after a minute and a half of silence.

```json
{ "t": "trace", "items": [Trace, ...] }
```

### `stats` — global counters, ≈4 Hz

```json
{ "t": "stats", ...Stats }
```

### `pong`

Reply to a client `ping`.

## Server → client: binary frames

All binary frames are little-endian; byte 0 is the message type.

### `0x01` PKTS — packet shots, ≈20 Hz

Each record is one "shot" to animate along the arc of a flow. Under load the
engine aggregates several packets of the same flow and direction into one
shot (`pkts > 1`) so the stream stays bounded no matter the packet rate.

```
offset  size  field
0       1     type      = 0x01
1       1     version   = 1
2       2     count     u16, number of records
4       8     base      f64, Unix ms of the first packet in the batch
12      12×N  records

record (12 bytes):
0       4     flow      u32  Flow.id
4       4     bytes     u32  bytes on the wire represented by this shot
8       2     dt        u16  milliseconds after `base`
10      1     pkts      u8   packets aggregated (1–255)
11      1     flags     u8   bit 0: direction (0 = outbound, 1 = inbound)
                             bits 1–7: reserved, must be ignored
```

A shot can reference a flow the client has not seen yet (the `flow` upsert is
in flight). Clients should keep such shots briefly (≈1 s) or drop them.

## Object schemas

### Endpoint — a remote address we exchanged packets with

```json
{
  "id": 12,
  "ip": "142.250.183.14",
  "name": "www.youtube.com",
  "names": ["www.youtube.com", "youtube-ui.l.google.com"],
  "scope": "public",
  "lat": 37.4223, "lon": -122.0848,
  "city": "Mountain View", "region": "California",
  "cc": "US", "country": "United States",
  "asn": 15169, "org": "Google LLC",
  "svc": "youtube",
  "threat": 0,
  "tags": [],
  "first": 1760342400000, "last": 1760342460000,
  "bytesIn": 18234123, "bytesOut": 382123,
  "rateIn": 1203400, "rateOut": 12040,
  "flows": 3
}
```

* `name`: best human label, chosen in this order: DNS name the machine
  resolved, TLS/QUIC SNI, HTTP `Host`, reverse DNS, organization. May be null.
* `scope`: `public` | `lan` (RFC 1918, ULA, link-local, CGNAT) | `local`
  (this machine) | `multicast`.
* `lat`/`lon` are null when the address cannot be located. LAN and multicast
  endpoints never have coordinates; render them in a local constellation
  around the home beacon.
* `svc`: optional well-known service key, see [Services](#services).
* `threat`: 0–100, the maximum score of the endpoint's alerts.
* `tags`: free-form short labels such as `tor`, `c2`, `new`, `doh`, `cdn`.

### Flow — one transport conversation (5-tuple)

```json
{
  "id": 77,
  "ep": 12,
  "proc": 5,
  "proto": "tcp",
  "app": "tls",
  "lport": 51234, "rport": 443,
  "dir": "out",
  "state": "est",
  "sni": "www.youtube.com", "alpn": "h2", "tlsv": "1.3",
  "ja4": "t13d1516h2_8daaf6152771_e5627efa2ab1",
  "ech": false,
  "pq": true,
  "bytesIn": 18000000, "bytesOut": 350000,
  "pktsIn": 12500, "pktsOut": 4100,
  "rateIn": 1200000, "rateOut": 11000,
  "rtt": 41.7,
  "start": 1760342400000, "last": 1760342460000,
  "threat": 0
}
```

* `proc`: `Proc.id`, or 0 when the owning process is unknown.
* `proto`: `tcp` | `udp` | `icmp` | `other`.
* `app`: application protocol, see [Apps](#apps).
* `dir`: who initiated: `out` (this machine) or `in` (the remote).
* `state`: `syn` | `est` | `fin` | `rst` | `closed` (TCP) or `active` (others).
* `rtt`: handshake round-trip time in ms (TCP SYN→SYN/ACK, QUIC client
  Initial→first server long-header packet); null if unknown.
* `sni`, `alpn`, `tlsv`, `ja4`, `ech`, `pq`: from the TLS ClientHello (also
  for QUIC, whose Initial packets the engine decrypts). `pq` means the client
  offered a post-quantum hybrid key exchange (ML-KEM). Absent when not TLS.

### Proc — a local process with network activity

```json
{
  "id": 5,
  "pid": 4242,
  "name": "firefox",
  "exe": "/usr/lib/firefox/firefox",
  "cmd": "/usr/lib/firefox/firefox -contentproc …",
  "user": "tatya",
  "unit": "app-hyprland-firefox-4242.scope",
  "container": null,
  "bytesIn": 120000000, "bytesOut": 4000000,
  "rateIn": 1300000, "rateOut": 15000,
  "flows": 42
}
```

The special process `id: 0` never appears; flows with `proc: 0` are
unattributed (short-lived sockets, other users' processes when the engine
runs unprivileged, forwarded traffic).

### DnsEvent

```json
{
  "ts": 1760342400123,
  "q": "www.youtube.com",
  "qtype": "A",
  "rcode": "NOERROR",
  "answers": ["142.250.183.14"],
  "cname": ["youtube-ui.l.google.com"],
  "eps": [12],
  "server": "127.0.0.53",
  "ms": 12.5,
  "proc": 0
}
```

* `eps`: endpoint ids already known for the answer addresses (may be empty;
  endpoints are only created once traffic flows to them).
* `ms`: query→response latency, null if the query was not seen.
* `rcode`: `NOERROR` | `NXDOMAIN` | `SERVFAIL` | `REFUSED` | other mnemonic.

### Alert

```json
{
  "id": 3,
  "ts": 1760342400000,
  "sev": "high",
  "kind": "beacon",
  "title": "Periodic beaconing to an unfamiliar host",
  "detail": "python3 (pid 9182) → 45.9.20.11:8443 every 30.0 s ±0.4 s, 24 times",
  "ep": 12, "flow": 77, "proc": 5,
  "score": 78,
  "evidence": { "interval_s": 30.0, "jitter": 0.013, "count": 24 }
}
```

* `sev`: `info` | `low` | `medium` | `high` | `critical`.
* `kind`: `intel` (threat-intel match), `beacon`, `dga`, `tunnel`, `scan`,
  `exfil`, `cleartext`, `arp-spoof`, `miner`, `tor`, `port`, `anomaly`,
  `novel`, `tls`.
* `ep`, `flow`, `proc`: related entity ids, 0 when not applicable.
* `evidence`: detector-specific key/value pairs for the detail view.

### Trace

```json
{
  "id": 1,
  "dst": "160.79.104.10",
  "name": "api.anthropic.com",
  "ts": 1760342400000,
  "done": true,
  "hops": [
    { "n": 1, "ip": "192.168.1.1", "rtt": 1.1, "scope": "lan", "lat": null, "lon": null },
    { "n": 5, "ip": "198.18.4.1", "rtt": 14.2, "scope": "public", "lat": 51.5074, "lon": -0.1278,
      "city": "London", "cc": "GB", "asn": 64510, "org": "Example Transit" }
  ]
}
```

* `hops` are sorted by `n`, the hop number (the probe's TTL). Hops that
  never answered are simply absent, so `n` can skip.
* `done`: the destination itself answered; the last hop is the target.
* `rtt`: best round trip in ms to that hop.
* Draw the path through located hops in order; LAN hops sit at home.

### Stats

```json
{
  "ts": 1760342400000,
  "rx": 1250000, "tx": 34000,
  "pps": 1820,
  "flows": 143, "eps": 61, "countries": 9, "procs": 14,
  "drops": 0,
  "defcon": 5,
  "apps": { "tls": 1100000, "quic": 150000, "dns": 900 },
  "totals": { "rx": 912345678, "tx": 12345678, "pkts": 1234567 }
}
```

* `rx`/`tx`: inbound/outbound bytes per second.
* `drops`: packets the kernel dropped because we fell behind (cumulative).
* `defcon`: 5 (calm) … 1 (critical activity in the last minutes).
* `apps`: total bytes per second by `app`.

## Client → server

```json
{ "t": "ping" }
```

Other messages are reserved; servers ignore unknown types.

## Enumerations

### Apps

`tls`, `quic`, `http`, `dns`, `doh` (DNS-over-HTTPS), `dot` (DNS-over-TLS),
`ssh`, `ntp`, `mdns`, `ssdp`, `dhcp`, `stun` (WebRTC), `wireguard`,
`openvpn`, `bittorrent`, `smtp`, `imap`, `pop3`, `ftp`, `telnet`, `rdp`,
`icmp`, `unknown`.

### Services

Optional `svc` keys for well-known destinations, derived from DNS names and
ASN organizations: `google`, `youtube`, `cloudflare`, `aws`, `azure`,
`gcp`, `akamai`, `fastly`, `github`, `discord`, `spotify`, `steam`,
`netflix`, `anthropic`, `openai`, `meta`, `whatsapp`, `apple`, `microsoft`,
`twitch`, `reddit`, `x`, `telegram`, `zoom`, `slack`, `amazon`, `jio`,
`tor`. Clients must tolerate unknown keys.

## Versioning

`hello.v` is bumped on breaking changes. Additive changes (new fields, new
enum values, new message types) do not bump it; clients ignore what they
don't understand.

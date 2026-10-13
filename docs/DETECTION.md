# Detection

Telluric's detectors run inside the engine's event loop. They see flow
starts, updates (a ClientHello parsed, a process attributed), flow ends,
completed DNS transactions, ARP messages, payload hints (cleartext logins,
mining handshakes) and upload growth. All state is bounded, and nothing
blocks the capture path.

Every alert carries a 0–100 score, from which its severity follows:

| Score  | Severity |
|--------|----------|
| 90–100 | critical |
| 70–89  | high     |
| 40–69  | medium   |
| 20–39  | low      |
| 0–19   | info     |

Alerts are keyed. Raising an alert with the key of a recent one updates it
in place, so a beacon that keeps beaconing grows a single alert instead of
flooding the feed. Alerts that are raised before attribution lands (it is
asynchronous, ~0.3–1 s behind the first packet) are rebuilt with the
process once it is known.

## The detectors

### Threat intelligence (`intel`, `tor`)

| Feed                         | Content                          |
|------------------------------|----------------------------------|
| abuse.ch ThreatFox           | live C2 servers labelled with their malware family (Cobalt Strike, Remcos, …) |
| abuse.ch Feodo Tracker       | botnet C2 (Emotet, QakBot lineage) |
| abuse.ch SSLBL               | C2 servers identified by TLS certificate |
| abuse.ch URLhaus             | malware distribution domains      |
| Spamhaus DROP / DROPv6       | hijacked and criminal netblocks    |
| Tor Project                  | current Tor exit relays            |

Addresses are matched exactly or by binary search over merged IPv4 ranges.
Names (SNI, HTTP `Host`, DNS questions and every CNAME in the answer chain)
are matched by walking up the domain hierarchy. C2 hits score 95 (critical),
hijacked space 82, malware hosts 85, Tor exits 42. Inbound connections from
listed hosts score 15 lower: being scanned is not being compromised. Feeds
refresh every six hours, atomically.

### Beaconing (`beacon`)

Implants phone home on a timer. The detector records connection start
times per destination (protocol, address, port) and measures their
regularity robustly, after RITA:

* **median interval** — the period,
* **MAD / median** — the jitter, insensitive to the odd late check-in,
* **Bowley skewness** of the intervals — a lopsided spread is less
  machine-like.

`regularity = 1 − min(1, jitter/0.2) − 0.3·min(1, |skew|)`. At least six
connections, a period between 2 s and 2 h, regularity ≥ 0.55, and recent
activity are required. The score rises with regularity and count, plus 12
for public addresses with no DNS name (hard-coded C2). Destinations with a
known service (Google, Mozilla telemetry, …) are capped at info: they
really do beacon, and they're not malware.

### Generated domains (`dga`)

Malware with a domain generation algorithm tries hundreds of pseudo-random
names a day until one resolves. On the wire, that is a burst of NXDOMAIN
answers for names nobody would type. Per client process, ten or more
NXDOMAINs in a minute trigger an evaluation of the names' **lexical
randomness**:

* Shannon entropy of the characters,
* scarcity of vowels,
* digits interleaved with letters,
* consonant clusters,
* long hex blobs (encoded data).

When half the failed names look generated, the alert is high (70–85). A
storm of failures with human-looking names is low: a misconfiguration.

### DNS tunneling (`tunnel`)

Tunnels smuggle data out inside DNS labels and read answers from TXT
records. Per registrable domain (public-suffix aware for common two-label
suffixes), the detector tracks unique subdomains seen in a minute. Twenty
or more with an average length of 24+ characters is high; TXT-heavy
traffic adds to the score. Reverse-DNS (`in-addr.arpa`, `ip6.arpa`) and
mDNS are excluded.

### Port scans and sweeps (`scan`)

* **Inbound**: one address probing 20+ of this machine's ports within
  10 s. From the LAN it scores 84: a device on your own network is
  scanning you. From the internet it scores 74.
* **Outbound**: one process opening TCP connections to 100+ distinct
  destinations within 10 s, which is worm-like.

Alerts report the peak, so a draining window never shrinks an alert.

### Exfiltration (`exfil`)

An upload is flagged when it exceeds 48 MiB, is at least 8× larger than what
came back, and goes to a public address with no known service. With no DNS
name at all it scores 80, otherwise 66. The alert refreshes as the upload
grows. Backups to S3 or `git push` to GitHub don't trigger it, because the
destination is a known service.

### Cleartext credentials (`cleartext`)

Passwords readable by anyone on the path: HTTP `Authorization: Basic`, FTP
and POP3 `PASS`, IMAP `LOGIN`, and SMTP `AUTH PLAIN/LOGIN` before STARTTLS.
Scored 78.

### ARP spoofing (`arp-spoof`)

The detector learns IP→MAC bindings from ARP replies and gratuitous ARP. When
an **established** binding (seen at least twice) changes MAC, someone may be
poisoning the LAN's ARP caches to sit in the middle. For the gateway (`.1`,
`.254`) the score is 96, critical. Repeated flips between the two MACs
update the same alert.

### Cryptominers (`miner`)

Stratum, the mining-pool protocol, is plain JSON-RPC:
`mining.subscribe`/`mining.authorize`, or XMRig's `login` with an `agent`.
Spotting it in a TCP payload scores 86.

### Tor (`tor`)

A `tor` process building circuits (medium, 45), and connections to
listed Tor exits (42). Tor is legitimate privacy software. On a machine
that isn't supposed to run it, it is worth knowing about.

### Suspicious ports (`port`)

Outbound connections to ports with a reputation: 4444 (Metasploit), 6667
(IRC botnets), 31337, 5555 (ADB), 3333/14444 (mining pools), 23 (Telnet). Low
severity, once per destination.

### Anomalies (`anomaly`)

**Half-Space Trees** (Tan, Ting & Liu, IJCAI 2011) is a streaming anomaly
detector with constant memory per point. It is an ensemble of 25 random
trees of depth 10, each splitting a randomly perturbed copy of the unit cube
at midpoints along random dimensions without ever looking at data. Mass
counters learn the shape of recent traffic in windows of 256 flows. A
finished flow's score is the reference mass of the deepest node it reaches,
scaled by 2^depth, ranked against recent scores. Seven features describe a
flow:

1. log bytes sent
2. log bytes received
3. log duration
4. the upload/download balance
5. the remote port's class
6. average outbound packet size
7. handshake RTT

Only the strangest half-percent is reported, at most twice a minute, as info
or low. It is a hint for curiosity, not an alarm.

## The threat level

```
pressure = Σ score × weight(severity) × e^(−age / 4 min)
weight: info 0 · low 0.3 · medium 0.6 · high 1 · critical 1.5
```

| Pressure | DEFCON |
|----------|--------|
| < 30     | 5      |
| < 70     | 4      |
| < 140    | 3      |
| < 260    | 2      |
| ≥ 260    | 1      |

A critical alert within the last 90 s holds the level at 2 or lower.
Calm returns on its own as the pressure decays.

## Trying it

`telluric --demo` cycles through every scenario above every four minutes.
Each scenario plays out in real packets that go through the very same
decoders and detectors as live traffic. The demo's villains live in RFC 5737
documentation address space at fictional organizations.

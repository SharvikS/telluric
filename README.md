# TELLURIC

**Your machine's live network traffic, rendered on a 3D globe.**

Every connection becomes an arc to where the other end actually is. Every
packet is a light trail racing along it. DNS lookups pop up over the cities
they resolve to, and a stack of detectors watches the traffic for beaconing
malware, generated domains, tunnels, scans and leaked credentials, then
lights the globe red when something looks wrong.

*Telluric currents are the electric currents that flow through the Earth.
These are yours.*

> **Status: under active construction.** Built in public, one commit at a
> time. The roadmap below is ticked off as pieces land.

## Why this is not a toy

The goal is to build every hard part from first principles:

- **Zero-copy capture.** A `TPACKET_V3` memory-mapped ring hands the engine
  whole 1 MiB blocks of frames, with no system call per packet.
- **Privilege separation.** Only a ~300-line helper holds `CAP_NET_RAW`. The
  parsers that read untrusted bytes never run as root (the design Wireshark
  uses with `dumpcap`).
- **Decoders that don't allocate.** IPv4/IPv6, TCP, UDP, ICMP, ARP, DNS, TLS
  and QUIC, all fuzz-tested and cross-checked against Wireshark's dissectors.
- **It reads names out of encrypted traffic.** It decrypts QUIC Initial
  packets (RFC 9001) to read the SNI of HTTP/3 connections, reassembles
  post-quantum-sized TLS ClientHellos, computes JA4 fingerprints, and runs
  passive DNS.
- **Its own MaxMind DB reader.** It reads the geolocation databases over a
  read-only `mmap` in a few hundred lines.
- **Its own RFC 6455 WebSocket server**, with a hybrid protocol: JSON for
  state, a 12-byte binary record per animated packet.
- **Detection built from scratch.** Streaming Half-Space Trees, beacon
  periodicity statistics, a character-bigram model for generated domains, and
  threat-intelligence matching.
- **A raw WebGL2 renderer with no 3D library.** Arcs and packets are animated
  entirely on the GPU.

The only dependency outside the Go standard library is `golang.org/x/sys`.

## Roadmap

- [x] Wire protocol specification ([docs/PROTOCOL.md](docs/PROTOCOL.md))
- [ ] Packet decoders + fuzzing + Wireshark differential tests
- [ ] pcap / pcapng reader, SLL2 writer
- [ ] TPACKET_V3 ring capture
- [ ] Privileged capture helper, `dumpcap` fallback
- [ ] DNS, TLS ClientHello + JA4, QUIC Initial decryption
- [ ] Flow table, TCP state machine, handshake RTT
- [ ] MaxMind DB reader, DB-IP downloads, home location via STUN
- [ ] Process attribution (`/proc`, cgroups → systemd units, containers)
- [ ] WebSocket server, auth, hub with backpressure
- [ ] Synthetic traffic generator (`--demo`)
- [ ] Threat-intel feeds and detectors
- [ ] WebGL2 globe: atmosphere, day/night terminator, city lights
- [ ] GPU-animated arcs and packet trails, DNS labels
- [ ] HUD, process and country leaderboards, alert theatre
- [ ] Static demo on GitHub Pages
- [ ] CI, benchmarks

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Privacy

Telluric never sends your traffic anywhere. The UI is served on loopback
only, behind a random session token. The only outbound requests it makes are:
geolocation database and threat-feed downloads, plus one STUN request to find
your public address (disable with `--no-stun`). Never commit real captures:
`.gitignore` blocks `*.pcap` by default.

## Credits

- IP geolocation by [DB-IP](https://db-ip.com) (CC BY 4.0)
- Map data from [Natural Earth](https://www.naturalearthdata.com) (public domain)
- Threat intelligence from [abuse.ch](https://abuse.ch), [Spamhaus](https://www.spamhaus.org)
  and the [Tor Project](https://www.torproject.org)

## License

MIT

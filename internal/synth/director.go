package synth

import (
	"encoding/hex"
	"fmt"
	"net/netip"
	"time"

	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/craft"
	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/procmap"
)

const (
	ms  = int64(time.Millisecond)
	sec = int64(time.Second)
)

// boot starts the always-on background of a normal desktop.
func (s *Source) boot(now int64) {
	// A long YouTube video over HTTP/3 on IPv6, and its watch page.
	s.quic(conn{sv: ytVideo, p: pFirefox, bulkIn: 3 << 30, rate: 700 << 10}, now+200*ms)
	s.quic(conn{sv: ytWeb, p: pFirefox, exchanges: 6, resp: 180 << 10}, now)
	// Discord's gateway: a long-lived TLS connection with heartbeats.
	s.heartbeat(conn{sv: discordGW, p: pDiscord}, now+300*ms, 15*time.Second, 40*time.Minute)
	// Spotify streaming a 320 kbps track after another.
	s.tcp(conn{sv: spotifyAP, p: pSpotify, exchanges: 4, resp: 30 << 10}, now+500*ms)
	s.tcp(conn{sv: spotifyAU, p: pSpotify, bulkIn: 400 << 20, rate: 42 << 10}, now+800*ms)
	// Claude Code talking to the API.
	s.heartbeat(conn{sv: anthropic, p: pClaude}, now+1*sec, 6*time.Second, 30*time.Minute)
	// Benign periodic traffic the beacon detector must not panic about.
	s.periodic(conn{sv: telemetry, p: pFirefox, exchanges: 1, resp: 600}, now+3*sec, 45*time.Second, 2*time.Hour)
	s.ntpLoop(now + 2*sec)
	s.lanChatter(now)
	s.nextBrowse = now + 1500*ms
	s.nextBackground = now + 6*sec
	s.nextIncident = now + 8*sec
}

// direct spawns new activity as time passes.
func (s *Source) direct(now int64) {
	for s.nextBrowse <= now {
		s.browse(s.nextBrowse)
		s.nextBrowse += s.jitter(2200*time.Millisecond, 0.8)
	}
	for s.nextBackground <= now {
		s.background(s.nextBackground)
		s.nextBackground += s.jitter(14*time.Second, 0.4)
	}
	for s.nextIncident <= now {
		s.runIncident(s.incident%10, s.nextIncident)
		s.incident++
		s.nextIncident += 24 * sec
	}
}

func (s *Source) browse(at int64) {
	total := 0
	for _, b := range browsing {
		total += b.w
	}
	pick := s.rng.IntN(total)
	var sv *service
	for _, b := range browsing {
		if pick -= b.w; pick < 0 {
			sv = b.s
			break
		}
	}
	c := conn{sv: sv, p: pFirefox, exchanges: 2 + s.rng.IntN(6), resp: (20 + s.rng.IntN(300)) << 10, linger: time.Duration(5+s.rng.IntN(25)) * time.Second}
	if sv.quic {
		s.quic(c, at)
	} else {
		s.tcp(c, at)
	}
}

func (s *Source) background(at int64) {
	switch s.rng.IntN(13) {
	case 0: // Steam pulls a game update over plain HTTP from Valve's CDN
		req := []byte("GET /depot/1086940/chunk/9f2c3b1e HTTP/1.1\r\nHost: cache5-fra1.steamcontent.com\r\nUser-Agent: Valve/Steam HTTP Client 1.0\r\n\r\n")
		s.tcp(conn{sv: steamAPI, p: pSteam, exchanges: 2, resp: 8 << 10}, at)
		s.tcp(conn{sv: steamCDN, p: pSteam, cleartext: req, bulkIn: 260 << 20, rate: 14 << 20}, at+400*ms)
	case 1: // git push over SSH
		s.tcp(conn{sv: githubSSH, p: pSSH, bulkOut: 24 << 20, rate: 3 << 20, linger: 2 * time.Second}, at)
	case 2: // docker pull
		s.tcp(conn{sv: docker, p: pDocker, exchanges: 5, resp: 12 << 10}, at)
		s.tcp(conn{sv: dockerCDN, p: pDocker, bulkIn: 90 << 20, rate: 9 << 20}, at+600*ms)
	case 3: // npm install
		for i := range 4 {
			s.tcp(conn{sv: npm, p: pNode, exchanges: 6, resp: 90 << 10}, at+int64(i)*150*ms)
		}
	case 4: // pip install torch
		s.tcp(conn{sv: pypi, p: pPip, bulkIn: 520 << 20, rate: 18 << 20}, at)
	case 5: // cargo build
		s.tcp(conn{sv: crates, p: pCargo, exchanges: 10, resp: 140 << 10}, at)
	case 6: // nightly backup to three random regions
		for i := range 3 {
			dst := s3[s.rng.IntN(len(s3))]
			s.tcp(conn{sv: dst, p: pRclone, bulkOut: 40 << 20, rate: 3 << 20}, at+int64(i)*sec)
		}
	case 7:
		s.voiceCall(at, 45*time.Second)
	case 8:
		s.tcp(conn{sv: telegram, p: pTelegram, exchanges: 4, resp: 40 << 10, linger: 20 * time.Second}, at)
	case 9:
		s.tcp(conn{sv: netflix, p: pFirefox, bulkIn: 180 << 20, rate: 2 << 20}, at)
	case 10:
		s.tcp(conn{sv: twitch, p: pFirefox, bulkIn: 120 << 20, rate: 900 << 10}, at)
	case 11:
		s.gameSession(at, 50*time.Second)
	case 12:
		s.heartbeat(conn{sv: vpsSG, p: pSSHvps, noDNS: true}, at, 1500*time.Millisecond, 70*time.Second)
	}
}

// heartbeat keeps one connection open with a small exchange every interval.
func (s *Source) heartbeat(c conn, at int64, every, life time.Duration) {
	c.exchanges, c.resp, c.every, c.life = 1, 4<<10, every, life
	s.tcp(c, at)
}

// periodic opens a fresh short connection every interval (with jitter).
func (s *Source) periodic(c conn, at int64, every, life time.Duration) {
	end := at + int64(life)
	next := at
	ss := &session{}
	ss.gen = func(now int64, _ *session) bool {
		for next <= now+50*ms && next < end {
			s.tcp(c, next)
			next += s.jitter(every, 0.3)
		}
		return next < end
	}
	s.add(ss)
}

func (s *Source) ntpLoop(at int64) {
	ss := &session{}
	next := at
	ss.gen = func(now int64, ss *session) bool {
		for next <= now+50*ms {
			port := s.ephemeral()
			s.attrib.set(17, port, pTimesync)
			cli := netip.AddrPortFrom(me4, port)
			srv := netip.AddrPortFrom(ntp.ip, 123)
			req := make([]byte, 48)
			req[0] = 0x23 // NTPv4 client
			resp := make([]byte, 48)
			resp[0] = 0x24
			if next == at {
				ss.script = append(ss.script, s.lookupNow(ntp, next)...)
			}
			rtt := rttTo(ntp.at)
			ss.script = append(ss.script, udpPkt(cli, srv, req, next, true, 0), udpPkt(srv, cli, resp, next+rtt, false, 0))
			next += 64 * sec
		}
		return true
	}
	s.add(ss)
}

func (s *Source) lookupNow(sv *service, at int64) []pkt {
	tmp := &session{}
	s.lookup(tmp, sv, at)
	return tmp.script
}

// lanChatter: mDNS and SSDP announcements, and ARP from the router.
func (s *Source) lanChatter(at int64) {
	tv := netip.MustParseAddr("192.168.1.20")
	printer := netip.MustParseAddr("192.168.1.33")
	mdnsGroup := netip.AddrPortFrom(netip.MustParseAddr("224.0.0.251"), 5353)
	ssdp := netip.AddrPortFrom(netip.MustParseAddr("239.255.255.250"), 1900)
	notify := []byte("NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nNT: upnp:rootdevice\r\nNTS: ssdp:alive\r\n\r\n")
	ss := &session{}
	next := at
	ss.gen = func(now int64, ss *session) bool {
		for next <= now+50*ms {
			for _, dev := range []netip.Addr{tv, printer} {
				name := "Living-Room-TV._googlecast._tcp.local"
				if dev == printer {
					name = "Brother-HL-L2350DW._ipp._tcp.local"
				}
				msg := craft.DNSResponse(0, name, 33, 0, craft.RR{Name: name, Type: decode.DNSTypeA, TTL: 120, Addr: dev})
				p := udpPkt(netip.AddrPortFrom(dev, 5353), mdnsGroup, msg, next+int64(s.rng.IntN(800))*ms, false, 0)
				p.pktType = capture.PacketMulticast
				ss.script = append(ss.script, p)
			}
			p := udpPkt(netip.AddrPortFrom(router, 1900), ssdp, notify, next+400*ms, false, 0)
			p.pktType = capture.PacketMulticast
			ss.script = append(ss.script, p)
			arp := pkt{at: next + 600*ms, et: decode.EtherTypeARP, data: craft.ARP(2, routerMAC, router, myMAC, me4), pktType: capture.PacketHost}
			ss.script = append(ss.script, arp)
			next += s.jitter(9*time.Second, 0.3)
		}
		return true
	}
	s.add(ss)
}

func (s *Source) voiceCall(at int64, d time.Duration) {
	port := s.ephemeral()
	s.attrib.set(17, port, pDiscord)
	cli := netip.AddrPortFrom(me4, port)
	srv := netip.AddrPortFrom(discordVC.ip, discordVC.port)
	stun := make([]byte, 20)
	stun[1] = 1
	stun[4], stun[5], stun[6], stun[7] = 0x21, 0x12, 0xa4, 0x42
	ss := &session{script: s.lookupNow(discordVC, at)}
	ss.script = append(ss.script, udpPkt(cli, srv, stun, at+20*ms, true, 0))
	next, end := at+60*ms, at+int64(d)
	rtt := rttTo(discordVC.at)
	ss.gen = func(now int64, ss *session) bool {
		for next <= now+50*ms && next < end {
			ss.script = append(ss.script,
				udpPkt(cli, srv, s.short(90+s.rng.IntN(70)), next, true, 0),
				udpPkt(srv, cli, s.short(90+s.rng.IntN(90)), next+rtt/2, false, 0))
			next += 20 * ms // 50 Opus frames per second each way
		}
		return next < end
	}
	s.add(ss)
}

func (s *Source) gameSession(at int64, d time.Duration) {
	port := s.ephemeral()
	s.attrib.set(17, port, pGame)
	cli := netip.AddrPortFrom(me4, port)
	srv := netip.AddrPortFrom(gameTokyo.ip, gameTokyo.port)
	ss := &session{}
	next, end := at, at+int64(d)
	rtt := rttTo(gameTokyo.at)
	ss.gen = func(now int64, ss *session) bool {
		for next <= now+50*ms && next < end {
			ss.script = append(ss.script,
				udpPkt(cli, srv, s.short(60+s.rng.IntN(40)), next, true, 0),
				udpPkt(srv, cli, s.short(180+s.rng.IntN(500)), next+rtt/2, false, 0))
			next += 16 * ms // 64 Hz tick rate
		}
		return next < end
	}
	s.add(ss)
}

// ---------------------------------------------------------------- incidents

func (s *Source) runIncident(i int, at int64) {
	switch i {
	case 0:
		s.beacon(at)
	case 1:
		s.dgaBurst(at)
	case 2:
		s.portScan(at)
	case 3:
		auth := []byte("GET /admin/wifi.html HTTP/1.1\r\nHost: 192.168.1.1\r\nUser-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0\r\n" +
			"Authorization: Basic YWRtaW46aHVudGVyMg==\r\n\r\n")
		lan := &service{name: "", ip: router, port: 80, at: frankfurt}
		s.tcp(conn{sv: lan, p: pFirefox, cleartext: auth, noDNS: true, exchanges: 1, resp: 6 << 10}, at)
	case 4:
		s.miner(at)
	case 5:
		s.tcp(conn{sv: exfilDst, p: pCurl, noDNS: true, bulkOut: 160 << 20, rate: 11 << 20}, at)
	case 6:
		s.arpSpoof(at)
	case 7:
		s.dnsTunnel(at)
	case 8:
		s.heartbeat(conn{sv: torRelay, p: pTor, noDNS: true}, at, 900*time.Millisecond, 90*time.Second)
	case 9:
		s.tcp(conn{sv: badIntel, p: pFirefox, exchanges: 2, resp: 14 << 10}, at)
	}
}

// beacon: a "python3" process in /tmp phoning home every 10 s ±1 %.
func (s *Source) beacon(at int64) {
	if s.beaconRunning {
		return
	}
	s.beaconRunning = true
	next, end := at, at+int64(30*time.Minute)
	ss := &session{}
	ss.gen = func(now int64, _ *session) bool {
		for next <= now+50*ms && next < end {
			s.tcp(conn{sv: c2, p: pBeacon, noDNS: true, exchanges: 1, resp: 300}, next)
			next += s.jitter(10*time.Second, 0.01)
		}
		return next < end
	}
	s.add(ss)
}

func (s *Source) randomLabel(n int, alphabet string) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = alphabet[s.rng.IntN(len(alphabet))]
	}
	return string(b)
}

// dgaBurst: malware hunting for its command server among generated names.
func (s *Source) dgaBurst(at int64) {
	tlds := []string{"biz", "top", "xyz", "info", "net", "online"}
	ss := &session{}
	for i := range 32 {
		name := s.randomLabel(10+s.rng.IntN(8), "abcdefghijklmnopqrstuvwxyz0123456789") + "." + tlds[s.rng.IntN(len(tlds))]
		port := s.ephemeral()
		s.attrib.set(17, port, pMalw)
		cli := netip.AddrPortFrom(me4, port)
		srv := netip.AddrPortFrom(router, 53)
		t := at + int64(i)*90*ms
		id := uint16(s.rng.Uint32())
		ss.script = append(ss.script,
			udpPkt(cli, srv, craft.DNSQuery(id, name, decode.DNSTypeA), t, true, 0),
			udpPkt(srv, cli, craft.DNSResponse(id, name, decode.DNSTypeA, decode.DNSRcodeNXDomain), t+18*ms, false, 0))
	}
	s.add(ss)
}

// portScan: a compromised LAN device sweeps our ports.
func (s *Source) portScan(at int64) {
	ss := &session{}
	for i := range 160 {
		port := uint16(1 + s.rng.IntN(10000))
		src := netip.AddrPortFrom(scanner, uint16(51000+i))
		dst := netip.AddrPortFrom(me4, port)
		t := at + int64(i)*18*ms
		syn := craft.TCP{Src: src.Addr(), Dst: dst.Addr(), SrcPort: src.Port(), DstPort: dst.Port(), Seq: s.rng.Uint32(), Flags: craft.SYN, Window: 1024}.Packet()
		rst := craft.TCP{Src: dst.Addr(), Dst: src.Addr(), SrcPort: dst.Port(), DstPort: src.Port(), Ack: 1, Flags: craft.RST | craft.ACK}.Packet()
		ss.script = append(ss.script,
			pkt{at: t, et: decode.EtherTypeIPv4, data: syn, pktType: capture.PacketHost},
			pkt{at: t + 200_000, out: true, et: decode.EtherTypeIPv4, data: rst, pktType: 0xff})
	}
	s.add(ss)
}

// miner: XMRig logging in to a Stratum pool, then receiving jobs.
func (s *Source) miner(at int64) {
	login := []byte(`{"id":1,"jsonrpc":"2.0","method":"login","params":{"login":"4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge","pass":"x","agent":"XMRig/6.22.2 (Linux x86_64) libuv/1.48.0 gcc/13.2.1","algo":["rx/0"]}}` + "\n")
	s.tcp(conn{sv: pool, p: pMiner, noDNS: true, cleartext: login, exchanges: 3, resp: 800, linger: 60 * time.Second}, at)
}

// arpSpoof: someone on the LAN claims to be the router.
func (s *Source) arpSpoof(at int64) {
	ss := &session{}
	for i := range 6 {
		ss.script = append(ss.script, pkt{at: at + int64(i)*sec, et: decode.EtherTypeARP,
			data: craft.ARP(2, attackerMAC, router, myMAC, me4), pktType: capture.PacketHost})
	}
	s.add(ss)
}

// dnsTunnel: data smuggled out in DNS labels, answered with TXT records.
func (s *Source) dnsTunnel(at int64) {
	ss := &session{}
	for i := range 45 {
		chunk := make([]byte, 28)
		for j := range chunk {
			chunk[j] = byte(s.rng.Uint32())
		}
		name := fmt.Sprintf("%s.%s.t.example.com", hex.EncodeToString(chunk), s.randomLabel(6, "abcdefghijklmnopqrstuvwxyz"))
		port := s.ephemeral()
		s.attrib.set(17, port, pDNSTun)
		cli := netip.AddrPortFrom(me4, port)
		srv := netip.AddrPortFrom(router, 53)
		id := uint16(s.rng.Uint32())
		txt := append([]byte{60}, []byte(s.randomLabel(60, "abcdefghijklmnopqrstuvwxyz0123456789"))...)
		t := at + int64(i)*180*ms
		ss.script = append(ss.script,
			udpPkt(cli, srv, craft.DNSQuery(id, name, decode.DNSTypeTXT), t, true, 0),
			udpPkt(srv, cli, craft.DNSResponse(id, name, decode.DNSTypeTXT, 0, craft.RR{Name: name, Type: decode.DNSTypeTXT, TTL: 0, Data: txt}), t+35*ms, false, 0))
	}
	s.add(ss)
}

// Procs lists every process of the demo world (for tests).
func Procs() []*procmap.Process {
	return []*procmap.Process{pFirefox, pDiscord, pSpotify, pSteam, pClaude, pSSH, pResolved, pTimesync, pDocker,
		pRclone, pTelegram, pNode, pPip, pCargo, pGame, pBeacon, pMalw, pMiner, pCurl, pTor, pDNSTun, pSSHvps}
}

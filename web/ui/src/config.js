// Shared visual vocabulary: the data palette (one source of truth for charts,
// arcs and comets), severities, threat levels and service names.

/** Okabe–Ito based palette per theme (sRGB hex). Mirrors --viz-* in tokens.css. */
const VIZ = {
  dark: {
    tls: '#5ab4ef', quic: '#d48ab4', http: '#eaa22a', dns: '#33bf94', ssh: '#e6da55',
    rtc: '#e8773d', p2p: '#4f8fe0', other: '#858a96', threat: '#f2555a', in: '#7b7ff6', out: '#33bf94',
    home: '#c7cbff', trace: '#f2b23e', orbit: '#7f86c9', sel: '#ffffff',
    critical: '#f2555a', high: '#f2853e', medium: '#f2b23e', low: '#4fb3f0', info: '#9aa0ad',
  },
  light: {
    tls: '#1677c4', quic: '#a7487f', http: '#b57a00', dns: '#008a62', ssh: '#8a7d00',
    rtc: '#c25200', p2p: '#2a5fb4', other: '#6e7380', threat: '#d93a3f', in: '#5b5bd6', out: '#008a62',
    home: '#4f46e5', trace: '#c27c0e', orbit: '#8b93b8', sel: '#0c0c0f',
    critical: '#d93a3f', high: '#d0610f', medium: '#c27c0e', low: '#1580c2', info: '#80808b',
  },
};

/** Which palette family an application protocol belongs to. */
const FAMILY = {
  tls: 'tls', quic: 'quic', http: 'http', dns: 'dns', doh: 'dns', dot: 'dns', mdns: 'dns',
  ssh: 'ssh', stun: 'rtc', bittorrent: 'p2p', wireguard: 'p2p', openvpn: 'p2p',
  smtp: 'http', imap: 'http', pop3: 'http', ftp: 'http', telnet: 'http',
};
export const family = (app) => FAMILY[app] || 'other';

let current = 'dark';
const linCache = new Map();

export function setVizTheme(mode) {
  current = mode === 'light' ? 'light' : 'dark';
}
export const vizTheme = () => current;

export function hex(app, theme = current) {
  const p = VIZ[theme];
  return p[app] || p[family(app)] || p.other;
}

function toLinear(hexStr) {
  let v = linCache.get(hexStr);
  if (v) return v;
  const n = parseInt(hexStr.slice(1), 16);
  v = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  linCache.set(hexStr, v);
  return v;
}

/** Linear RGB for GPU layers, for the current theme. */
export const appColor = (app) => toLinear(hex(app));
export const vizLinear = (key) => toLinear(hex(key));
export const THREAT_COLOR_FN = () => toLinear(hex('threat'));

export function cssColor(rgb, a = 1) {
  return `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${a})`;
}

/** Protocol families shown in charts and legends, in a stable order. */
export const APP_ROWS = [
  ['tls', 'TLS'], ['quic', 'QUIC'], ['http', 'HTTP'], ['dns', 'DNS'], ['ssh', 'SSH'],
  ['rtc', 'WebRTC'], ['p2p', 'P2P / VPN'], ['other', 'Other'],
];
export const APP_LABEL = Object.fromEntries(APP_ROWS);
export const appRow = (app) => family(app);
export const APP_NAMES = {
  tls: 'TLS', quic: 'QUIC', http: 'HTTP', dns: 'DNS', doh: 'DoH', dot: 'DoT', ssh: 'SSH', stun: 'WebRTC', mdns: 'mDNS',
  ssdp: 'SSDP', dhcp: 'DHCP', ntp: 'NTP', wireguard: 'WireGuard', openvpn: 'OpenVPN', bittorrent: 'BitTorrent',
  smtp: 'SMTP', imap: 'IMAP', pop3: 'POP3', ftp: 'FTP', telnet: 'Telnet', rdp: 'RDP', icmp: 'ICMP', unknown: 'Other',
};
export const appName = (app) => APP_NAMES[app] || String(app || 'other').toUpperCase();

export const SEVERITY = {
  critical: { rank: 4, label: 'Critical', css: 'danger', var: '--danger' },
  high: { rank: 3, label: 'High', css: 'orange', var: '--orange' },
  medium: { rank: 2, label: 'Medium', css: 'warning', var: '--warning' },
  low: { rank: 1, label: 'Low', css: 'info', var: '--info' },
  info: { rank: 0, label: 'Info', css: '', var: '--text-3' },
};
export const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

/** The engine's 5-level scale ("defcon" on the wire), named for humans. */
export const THREAT_LEVELS = {
  5: { label: 'Normal', css: 'success', var: '--success', blurb: 'No notable security activity.' },
  4: { label: 'Guarded', css: 'info', var: '--info', blurb: 'Low-severity findings worth a look.' },
  3: { label: 'Elevated', css: 'warning', var: '--warning', blurb: 'Suspicious activity in the last minutes.' },
  2: { label: 'High', css: 'orange', var: '--orange', blurb: 'Serious alerts need attention.' },
  1: { label: 'Critical', css: 'danger', var: '--danger', blurb: 'Critical activity is happening now.' },
};

export const ALERT_KINDS = {
  intel: 'Threat intel match', beacon: 'Beaconing', dga: 'Generated domains', tunnel: 'DNS tunneling', scan: 'Port scan',
  exfil: 'Exfiltration', cleartext: 'Cleartext credentials', 'arp-spoof': 'ARP spoofing', miner: 'Cryptomining',
  tor: 'Tor', port: 'Suspicious port', anomaly: 'Anomaly', novel: 'New destination', tls: 'Weak TLS',
};

export const SERVICES = {
  google: 'Google', youtube: 'YouTube', cloudflare: 'Cloudflare', aws: 'AWS', azure: 'Azure', gcp: 'Google Cloud',
  akamai: 'Akamai', fastly: 'Fastly', github: 'GitHub', discord: 'Discord', spotify: 'Spotify', steam: 'Steam',
  netflix: 'Netflix', anthropic: 'Anthropic', openai: 'OpenAI', meta: 'Meta', whatsapp: 'WhatsApp', apple: 'Apple',
  microsoft: 'Microsoft', twitch: 'Twitch', reddit: 'Reddit', x: 'X', telegram: 'Telegram', zoom: 'Zoom',
  slack: 'Slack', amazon: 'Amazon', jio: 'Jio', tor: 'Tor',
};

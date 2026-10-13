// Formatting for the UI. Units, clock style and time zone follow the user's
// preferences (setFormatPrefs).

const fp = { units: 'bytes', clock: '24h', tz: 'local' };

export function setFormatPrefs(p) {
  Object.assign(fp, p);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const BIT_UNITS = ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'];

function scale(n, units, base = 1000) {
  let i = 0;
  while (Math.abs(n) >= base && i < units.length - 1) {
    n /= base;
    i++;
  }
  return [n, units[i], i];
}

function num(n, i) {
  if (i === 0) return String(Math.round(n));
  return Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
}

/** [value, unit] for a byte count. */
export function bytesParts(n) {
  if (!Number.isFinite(n) || n <= 0) return ['0', 'B'];
  const [v, u, i] = scale(n, BYTE_UNITS);
  return [num(v, i), u];
}

export const bytes = (n) => bytesParts(n).join(' ');

/** [value, unit] for a rate in bytes per second, in the preferred units. */
export function rateParts(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return ['0', fp.units === 'bits' ? 'b/s' : 'B/s'];
  if (fp.units === 'bits') {
    const [v, u, i] = scale(bps * 8, BIT_UNITS);
    return [num(v, i), u];
  }
  const [v, u, i] = scale(bps, BYTE_UNITS);
  return [num(v, i), `${u}/s`];
}

export const rate = (bps) => rateParts(bps).join(' ');

/** Compact rate for axis labels: "1.2 MB/s", "340 KB/s". */
export function rateShort(bps) {
  const v = fp.units === 'bits' ? bps * 8 : bps;
  if (v <= 0) return '0';
  const [n, u] = scale(v, fp.units === 'bits' ? BIT_UNITS : ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']);
  return `${n >= 10 || Number.isInteger(n) ? Math.round(n) : n.toFixed(1)} ${u}`;
}

export const rateUnit = () => (fp.units === 'bits' ? 'b/s' : 'B/s');

export function bits(bps) {
  const [v, u, i] = scale((bps || 0) * 8, BIT_UNITS);
  return `${num(v, i)} ${u}`;
}

export function count(n) {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1e6) return `${(n / 1e3).toFixed(Math.abs(n) < 1e4 ? 1 : 0)}k`;
  if (Math.abs(n) < 1e9) return `${(n / 1e6).toFixed(Math.abs(n) < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export const integer = (n) => Math.round(n || 0).toLocaleString('en-US');

export function pct(x, digits = 0) {
  if (!Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function agoShort(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function duration(ms) {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const pad = (n) => String(n).padStart(2, '0');

function parts(ms) {
  const d = new Date(ms);
  return fp.tz === 'utc'
    ? [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMonth(), d.getUTCDate()]
    : [d.getHours(), d.getMinutes(), d.getSeconds(), d.getMonth(), d.getDate()];
}

/** "14:22:07" or "2:22:07 PM" in the preferred zone. */
export function time(ms, withSeconds = true) {
  const [H, M, S] = parts(ms);
  const sec = withSeconds ? `:${pad(S)}` : '';
  if (fp.clock === '12h') return `${((H + 11) % 12) + 1}:${pad(M)}${sec} ${H < 12 ? 'AM' : 'PM'}`;
  return `${pad(H)}:${pad(M)}${sec}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dateTime(ms) {
  const p = parts(ms);
  return `${MONTHS[p[3]]} ${p[4]}, ${time(ms, false)}`;
}

export const tzLabel = () => (fp.tz === 'utc' ? 'UTC' : 'local');

// Back-compat helpers used by the renderer layers.
export const timeOfDay = (ms) => time(ms);
export const clockUTC = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
export const clockLocal = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function latLon(lat, lon) {
  if (lat == null || lon == null) return '—';
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

/** Escapes text for safe insertion into HTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function middleTruncate(s, max = 32) {
  if (!s || s.length <= max) return s || '';
  const keep = max - 1;
  const head = Math.ceil(keep * 0.55);
  return `${s.slice(0, head)}…${s.slice(s.length - (keep - head))}`;
}

/** Nice round step for axes. */
export function niceStep(range, target = 4) {
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag;
}

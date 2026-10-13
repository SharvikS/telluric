import { Emitter } from '../util/emitter.js';

const KEY = 'telluric.prefs.v2';

export const DEFAULTS = {
  theme: 'system', // system | dark | light
  motion: 'system', // system | reduced | full
  cinema: false, // extra bloom, glow and drama on the globe
  units: 'bytes', // bytes | bits
  clock: '24h', // 24h | 12h
  tz: 'local', // local | utc
  sound: false,
  navCollapsed: false,
  range: '15m', // 5m | 15m | 1h | 6h | 24h
  density: 'comfortable', // comfortable | compact
  notify: 'medium', // minimum severity that raises a toast
  globe: { arcs: true, packets: true, labels: true, heat: true, terminator: true, traces: true, autoRotate: true },
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object') out[k] = merge(base[k], v);
    else if (k in base) out[k] = v;
  }
  return out;
}

/** User preferences, persisted per browser. Emits change(key, value, prefs). */
export class Prefs extends Emitter {
  constructor() {
    super();
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch {
      saved = null;
    }
    this.v = merge(DEFAULTS, saved);
  }

  get(key) {
    return key.split('.').reduce((o, k) => (o == null ? o : o[k]), this.v);
  }

  set(key, value) {
    const parts = key.split('.');
    let o = this.v;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    if (o[parts[parts.length - 1]] === value) return;
    o[parts[parts.length - 1]] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.v));
    } catch {
      /* private mode: preferences last for this tab */
    }
    this.emit('change', key, value, this.v);
  }

  toggle(key) {
    this.set(key, !this.get(key));
  }
}

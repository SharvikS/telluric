import { family } from '../config.js';

export const RANGES = {
  '5m': { ms: 5 * 60e3, label: '5 minutes', step: 1000 },
  '15m': { ms: 15 * 60e3, label: '15 minutes', step: 1000 },
  '1h': { ms: 60 * 60e3, label: '1 hour', step: 60e3 },
  '6h': { ms: 6 * 60 * 60e3, label: '6 hours', step: 60e3 },
  '24h': { ms: 24 * 60 * 60e3, label: '24 hours', step: 60e3 },
};

const ENTITY_SAMPLES = 90; // per-process/endpoint rate history (2 s apart = 3 min)

/**
 * Time series for charts. Short ranges come from 1 s samples (the engine
 * seeds 15 minutes; the client keeps extending it), long ranges from the
 * engine's one-minute averages, with the current partial minute stitched on
 * from the 1 s samples so charts stay live at every zoom level.
 */
export class History {
  constructor(store) {
    this.store = store;
    this.procs = new Map(); // proc id → Float32Array ring
    this.eps = new Map();
    this.sampledAt = 0;
  }

  /** Samples (oldest first) covering `range`, and their resolution. */
  series(range) {
    const r = RANGES[range] || RANGES['15m'];
    const now = this.store.now();
    const from = now - r.ms;
    const sec = this.store.history;
    const secFrom = sec.length ? sec[0].ts : Infinity;
    if (secFrom <= from + 2000 || r.ms <= RANGES['15m'].ms) {
      return { samples: sec.filter((s) => s.ts >= from), step: 1000, from, to: now };
    }
    const mins = this.store.historyMin.filter((s) => s.ts >= from);
    const lastMin = mins.length ? mins[mins.length - 1].ts + 60e3 : from;
    const tail = sec.filter((s) => s.ts >= lastMin);
    if (tail.length) mins.push(average(tail));
    return { samples: mins, step: 60e3, from, to: now };
  }

  /** Mean of a field over the range. */
  avg(range, key) {
    const { samples } = this.series(range);
    if (!samples.length) return 0;
    let s = 0;
    for (const x of samples) s += x[key] || 0;
    return s / samples.length;
  }

  /**
   * Change of the last minute against the whole range: (recent − mean) / mean.
   * Null when there is not enough data to say.
   */
  delta(range, key) {
    const { samples } = this.series(range);
    if (samples.length < 4) return null;
    const now = this.store.now();
    const recent = samples.filter((s) => s.ts >= now - 60e3);
    const base = samples.filter((s) => s.ts < now - 60e3);
    if (!recent.length || !base.length) return null;
    const m = (arr) => arr.reduce((a, x) => a + (x[key] || 0), 0) / arr.length;
    const b = m(base);
    if (b <= 0) return null;
    return (m(recent) - b) / b;
  }

  /** Bytes per protocol family over the range (integrated from rates). */
  appBytes(range) {
    const { samples, step } = this.series(range);
    const out = new Map();
    for (const s of samples) {
      for (const [app, r] of Object.entries(s.apps || {})) {
        const f = family(app);
        out.set(f, (out.get(f) || 0) + r * (step / 1000));
      }
    }
    if (!samples.length && this.store.stats) {
      for (const [app, r] of Object.entries(this.store.stats.apps || {})) out.set(family(app), (out.get(family(app)) || 0) + r);
    }
    return out;
  }

  /** Sample per-entity rates every 2 s for table sparklines. */
  tick(now) {
    if (now - this.sampledAt < 2000) return;
    this.sampledAt = now;
    sample(this.procs, this.store.procs);
    sample(this.eps, this.store.endpoints);
  }

  procSeries(id) {
    return this.procs.get(id) || null;
  }

  epSeries(id) {
    return this.eps.get(id) || null;
  }
}

function sample(rings, entities) {
  for (const [id, e] of entities) {
    let r = rings.get(id);
    if (!r) rings.set(id, (r = new Float32Array(ENTITY_SAMPLES)));
    r.copyWithin(0, 1);
    r[ENTITY_SAMPLES - 1] = (e.rateIn || 0) + (e.rateOut || 0);
  }
  for (const id of rings.keys()) if (!entities.has(id)) rings.delete(id);
}

function average(arr) {
  const out = { ...arr[arr.length - 1] };
  for (const k of ['rx', 'tx', 'pps', 'flows', 'eps', 'countries', 'procs']) {
    out[k] = arr.reduce((a, x) => a + (x[k] || 0), 0) / arr.length;
  }
  const apps = {};
  for (const x of arr) for (const [k, v] of Object.entries(x.apps || {})) apps[k] = (apps[k] || 0) + v / arr.length;
  out.apps = apps;
  out.ts = Math.floor(arr[0].ts / 60e3) * 60e3;
  return out;
}

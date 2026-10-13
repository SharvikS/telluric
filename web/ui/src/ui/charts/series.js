// Shared helpers for time-series charts: fixed-size buckets (so a 15-minute
// chart is ~180 calm points instead of 900 one-second spikes) and a
// monotone cubic curve that never overshoots the data.

const BUCKETS = [1e3, 2e3, 5e3, 10e3, 15e3, 20e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3];

/** Bucket width for a window of `span` ms drawn with about `points` points. */
export function bucketFor(span, step = 1000, points = 160) {
  const want = span / points;
  for (const b of BUCKETS) if (b >= want && b >= step) return b;
  return BUCKETS[BUCKETS.length - 1];
}

/**
 * Time-weighted bucket averages, aligned to multiples of `B` so buckets do not
 * shift as data arrives. Samples of mixed resolution (minute averages with a
 * tail of 1 s samples) are weighted by the time each one covers.
 * fns: value extractors. Returns [{ t0, ts, vals: Float64Array, partial }].
 */
export function bucketize(samples, B, fns, step = 1000) {
  const out = [];
  const n = fns.length;
  let cur = null, prevTs = null;
  for (const s of samples) {
    const w = prevTs == null ? step : Math.min(Math.max(s.ts - prevTs, 1000), Math.max(step, 60e3));
    prevTs = s.ts;
    const t0 = Math.floor(s.ts / B) * B;
    if (!cur || cur.t0 !== t0) {
      cur = { t0, ts: t0 + B / 2, vals: new Float64Array(n), w: 0, last: s.ts, partial: false };
      out.push(cur);
    }
    for (let k = 0; k < n; k++) cur.vals[k] += fns[k](s) * w;
    cur.w += w;
    cur.last = s.ts;
  }
  for (const c of out) for (let k = 0; k < n; k++) c.vals[k] /= c.w || 1;
  // The newest bucket is still filling: anchor it at its latest sample so
  // the curve ends at "now" instead of in the future.
  const tail = out[out.length - 1];
  if (tail && tail.last < tail.t0 + B - step) {
    tail.partial = true;
    tail.ts = Math.max(tail.t0, tail.last);
  }
  return out;
}

/** Appends a monotone cubic (Fritsch–Carlson) through the points to `ctx`. */
export function monotone(ctx, xs, ys, move = true) {
  const n = xs.length;
  if (!n) return;
  if (move) ctx.moveTo(xs[0], ys[0]);
  else ctx.lineTo(xs[0], ys[0]);
  if (n === 1) return;
  const d = new Float64Array(n - 1);
  const m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1e-9);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    ctx.bezierCurveTo(xs[i] + dx, ys[i] + m[i] * dx, xs[i + 1] - dx, ys[i + 1] - m[i + 1] * dx, xs[i + 1], ys[i + 1]);
  }
}

/** Bucket averages of one field, for sparklines. */
export function smoothValues(samples, span, key, points = 48, step = 1000) {
  if (!samples.length) return [];
  const B = bucketFor(span, step, points);
  const fn = typeof key === 'function' ? key : (s) => s[key] || 0;
  return bucketize(samples, B, [fn], step).map((b) => b.vals[0]);
}

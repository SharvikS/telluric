import { chartTheme, alpha, showTip, fitCanvas } from './theme.js';
import { bucketFor, bucketize, monotone } from './series.js';
import { time, niceStep } from '../../util/format.js';
import { approach } from '../../app/motion.js';

/**
 * Live time-series area chart on canvas. Samples are averaged into buckets
 * sized to the window (~160 points: 5 s buckets for 15 minutes, 10 minutes
 * for a day), drawn as monotone cubic curves with gradient fills. The window
 * scrolls every frame, the y-domain eases towards its target, and range
 * changes animate the span (a smooth zoom). Series overlay or stack.
 *
 * series: [{ key: string | (sample) => number, label, color: '--css-var', stack?: bool }]
 */
export class AreaChart {
  constructor(el, { series, format, axisFormat, points = 160 }) {
    this.el = el;
    el.classList.add('chart');
    this.cv = document.createElement('canvas');
    this.cross = document.createElement('div');
    this.cross.className = 'crosshair';
    el.append(this.cv, this.cross);
    this.series = series;
    this.format = format;
    this.axisFormat = axisFormat || format;
    this.points = points;
    this.samples = [];
    this.step = 1000;
    this.span = 0;
    this.spanTarget = 15 * 60e3;
    this.yMax = 0;
    this.hoverX = null;
    this.buckets = [];
    this.B = 5000;
    this.dirty = true;
    el.addEventListener('pointermove', (e) => {
      const r = this.cv.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.hoverY = e.clientY;
    });
    el.addEventListener('pointerleave', () => {
      this.hoverX = null;
      showTip(0, 0, null);
    });
  }

  value(s, ser) {
    return typeof ser.key === 'function' ? ser.key(s) : s[ser.key] || 0;
  }

  setSeries(series) {
    this.series = series;
    this.dirty = true;
  }

  setData({ samples, step, from, to }) {
    this.samples = samples;
    this.step = step;
    this.spanTarget = to - from;
    if (!this.span) this.span = this.spanTarget;
    this.dirty = true;
  }

  rebucket() {
    this.B = bucketFor(this.spanTarget, this.step, this.points);
    const fns = this.series.map((ser) => (s) => this.value(s, ser));
    this.buckets = bucketize(this.samples, this.B, fns, this.step);
    this.dirty = false;
  }

  /** end: right edge of the window (ms); pass a frozen time while paused. */
  draw(end, dt) {
    if (this.dirty) this.rebucket();
    const [W, H, dpr] = fitCanvas(this.cv);
    const ctx = this.cv.getContext('2d');
    const th = chartTheme();
    this.span = Math.abs(this.span - this.spanTarget) < 50 ? this.spanTarget : approach(this.span, this.spanTarget, dt, 6);
    const x1 = end - this.step * 1.2, x0 = x1 - this.span;
    const padT = 10 * dpr, padB = 22 * dpr;
    const pw = W, ph = H - padT - padB;
    const X = (ts) => ((ts - x0) / (x1 - x0)) * pw;

    // Buckets in view, plus one either side so curves leave the edges cleanly.
    const all = this.buckets;
    let i0 = 0;
    while (i0 < all.length - 1 && all[i0 + 1].ts < x0) i0++;
    const vis = all.slice(i0);
    const stacked = this.series.some((s) => s.stack);
    // Stacked: drop series that carry (almost) nothing in view and put the
    // biggest at the bottom, so the top edge is a real layer, not a hairline.
    let order = this.series.map((ser, k) => k);
    const share = this.series.map(() => 1);
    if (stacked) {
      const sums = this.series.map(() => 0);
      for (const b of vis) for (let k = 0; k < sums.length; k++) sums[k] += b.vals[k];
      const all = sums.reduce((a, x) => a + x, 0) || 1;
      for (let k = 0; k < sums.length; k++) share[k] = sums[k] / all;
      order = order.filter((k) => share[k] > 0.001).sort((a, b) => sums[b] - sums[a]);
    }
    const n = this.series.length;
    let peak = 0;
    for (const b of vis) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc = stacked ? acc + b.vals[k] : Math.max(acc, b.vals[k]);
      if (b.ts >= x0 - this.B) peak = Math.max(peak, acc);
    }
    const target = Math.max(peak * 1.15, 1);
    this.yMax = this.yMax ? approach(this.yMax, target, dt, 5) : target;
    const Y = (v) => padT + ph - (v / this.yMax) * ph;

    ctx.clearRect(0, 0, W, H);
    // Grid and y labels.
    const stepY = niceStep(this.yMax, 3);
    ctx.font = th.font.replace('11px', `${11 * dpr}px`);
    ctx.textBaseline = 'bottom';
    for (let v = stepY; v < this.yMax; v += stepY) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.fillStyle = th.grid;
      ctx.fillRect(0, y, pw, dpr);
      ctx.fillStyle = th.text3;
      ctx.fillText(this.axisFormat(v), 4 * dpr, y - 3 * dpr);
    }
    ctx.fillStyle = th.border2;
    ctx.fillRect(0, Math.round(Y(0)), pw, dpr);

    // X labels.
    const tickMs = pickTick(this.span);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillStyle = th.text3;
    for (let t = Math.ceil(x0 / tickMs) * tickMs; t <= x1; t += tickMs) {
      const x = X(t);
      if (x < 24 * dpr || x > W - 24 * dpr) continue;
      ctx.fillText(time(t, tickMs < 60e3), x, H - padB + 6 * dpr);
    }
    ctx.textAlign = 'left';

    // History that starts inside the window: mark where it begins.
    const first = all.length ? all[0].t0 : null;
    if (first != null && first > x0 + this.span * 0.04) {
      const fx = Math.round(X(first)) + 0.5;
      ctx.save();
      ctx.strokeStyle = th.border2;
      ctx.lineWidth = dpr;
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(fx, padT);
      ctx.lineTo(fx, padT + ph);
      ctx.stroke();
      ctx.restore();
      if (fx > 160 * dpr) {
        ctx.fillStyle = th.text3;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(`No data before ${time(first, this.B < 60e3)}`, fx - 8 * dpr, padT + ph / 2);
        ctx.textAlign = 'left';
      }
    }

    let hover = null;
    if (vis.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, pw, padT + ph + dpr);
      ctx.clip();
      const xs = vis.map((b) => X(b.ts));
      const base = new Float64Array(vis.length);
      const tops = [];
      for (const k of order) {
        const ser = this.series[k];
        const col = th.color(ser.color);
        const top = new Float64Array(vis.length);
        for (let i = 0; i < vis.length; i++) top[i] = (stacked ? base[i] : 0) + vis[i].vals[k];
        const ys = Array.from(top, Y);
        const ys0 = Array.from(stacked ? base : new Float64Array(vis.length), Y);
        ctx.beginPath();
        monotone(ctx, xs, ys, true);
        monotone(ctx, xs.slice().reverse(), ys0.reverse(), false);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, padT, 0, padT + ph);
        g.addColorStop(0, alpha(col, stacked ? 0.5 : 0.3));
        g.addColorStop(1, alpha(col, stacked ? 0.16 : 0));
        ctx.fillStyle = g;
        ctx.fill();
        // Slivers (< 3% of the stack) get no outline of their own.
        if (share[k] >= 0.03) {
          ctx.beginPath();
          monotone(ctx, xs, ys, true);
        } else ctx.beginPath();
        ctx.strokeStyle = col;
        ctx.lineWidth = (stacked ? 1.25 : 1.75) * dpr;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
        tops.push({ ys, col, stroked: share[k] >= 0.03 });
        if (stacked) base.set(top);
      }
      // Live head: a dot riding the newest point of each line.
      const last = vis.length - 1;
      if (xs[last] <= W + 2) {
        // Stacked: one head on the total, in the colour of the top outlined layer.
        const heads = stacked && tops.length
          ? [{ ys: tops[tops.length - 1].ys, col: (tops.filter((x) => x.stroked).pop() || tops[tops.length - 1]).col }]
          : tops;
        for (const { ys, col } of heads) {
          ctx.fillStyle = alpha(col, 0.22);
          ctx.beginPath();
          ctx.arc(xs[last], ys[last], 5.5 * dpr, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(xs[last], ys[last], 2.6 * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Hover: snap to the nearest bucket and ring each value.
      if (this.hoverX != null) {
        const hx = this.hoverX * dpr;
        let bi = 0, bd = Infinity;
        for (let i = 0; i < xs.length; i++) {
          const d = Math.abs(xs[i] - hx);
          if (d < bd) { bd = d; bi = i; }
        }
        hover = { b: vis[bi], x: xs[bi] };
        for (const { ys, col } of tops) {
          ctx.fillStyle = th.surface;
          ctx.strokeStyle = col;
          ctx.lineWidth = 2 * dpr;
          ctx.beginPath();
          ctx.arc(xs[bi], ys[bi], 3.6 * dpr, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
      ctx.restore();
      // Soft fade where history scrolls out on the left.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      const fade = ctx.createLinearGradient(0, 0, 28 * dpr, 0);
      fade.addColorStop(0, 'rgba(0,0,0,1)');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, padT - 2 * dpr, 28 * dpr, ph + 3 * dpr);
      ctx.restore();
    }

    if (hover) {
      const cx = hover.x / dpr;
      this.cross.style.transform = `translateX(${cx}px)`;
      const rect = this.cv.getBoundingClientRect();
      let total = 0;
      const rows = order.map((k) => {
        const v = hover.b.vals[k];
        total += v;
        return { ser: this.series[k], v };
      }).filter((r) => !stacked || r.v > 0).reverse().map(({ ser, v }) => `<div class="tt-row"><i style="background:${th.color(ser.color)}"></i>${ser.label}<b>${this.format(v)}</b></div>`).join('');
      const tot = stacked && n > 1 ? `<div class="tt-row tt-total">Total<b>${this.format(total)}</b></div>` : '';
      const B = this.B;
      const when = B >= 60e3 ? `${time(hover.b.t0)} – ${time(hover.b.t0 + B)}` : time(hover.b.t0, true);
      const res = hover.b.partial ? 'so far' : `${B >= 60e3 ? `${B / 60e3} min` : `${B / 1000} s`} average`;
      showTip(rect.left + cx, this.hoverY, `<div class="tt-title">${when}<span class="tt-sub">${res}</span></div>${rows}${tot}`);
    }
  }
}

function pickTick(span) {
  const opts = [10e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3];
  for (const o of opts) if (span / o <= 6) return o;
  return 12 * 3600e3;
}

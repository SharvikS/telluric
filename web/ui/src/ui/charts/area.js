import { chartTheme, alpha, showTip, fitCanvas } from './theme.js';
import { time, niceStep } from '../../util/format.js';
import { approach } from '../../app/motion.js';

/**
 * Live time-series area chart on canvas. The time window scrolls every frame
 * (no stepping), the y-domain eases towards its target, and range changes
 * animate the span (a smooth zoom). Series can be overlaid or stacked.
 *
 * series: [{ key: string | (sample) => number, label, color: '--css-var', stack?: bool }]
 */
export class AreaChart {
  constructor(el, { series, format, axisFormat, lagSteps = 1.2 }) {
    this.el = el;
    el.classList.add('chart');
    this.cv = document.createElement('canvas');
    this.cross = document.createElement('div');
    this.cross.className = 'crosshair';
    el.append(this.cv, this.cross);
    this.series = series;
    this.format = format;
    this.axisFormat = axisFormat || format;
    this.lagSteps = lagSteps;
    this.samples = [];
    this.step = 1000;
    this.span = 0;
    this.spanTarget = 15 * 60e3;
    this.yMax = 0;
    this.hoverX = null;
    this.end = 0;
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
  }

  setData({ samples, step, from, to }) {
    this.samples = samples;
    this.step = step;
    this.spanTarget = to - from;
    if (!this.span) this.span = this.spanTarget;
  }

  /** end: right edge of the window (ms); pass a frozen time while paused. */
  draw(end, dt) {
    const [W, H, dpr] = fitCanvas(this.cv);
    const ctx = this.cv.getContext('2d');
    const th = chartTheme();
    this.span = Math.abs(this.span - this.spanTarget) < 50 ? this.spanTarget : approach(this.span, this.spanTarget, dt, 6);
    const lag = this.step * this.lagSteps;
    const x1 = end - lag, x0 = x1 - this.span;
    const padT = 10 * dpr, padB = 22 * dpr, padL = 0, padR = 0;
    const pw = W - padL - padR, ph = H - padT - padB;
    const X = (ts) => padL + ((ts - x0) / (x1 - x0)) * pw;

    // Visible samples (one extra on each side for clean edges).
    const S = this.samples;
    let i0 = 0;
    while (i0 < S.length - 1 && S[i0 + 1].ts < x0) i0++;
    const vis = S.slice(i0);
    const stacked = this.series.some((s) => s.stack);
    let peak = 0;
    for (const s of vis) {
      let acc = 0;
      for (const ser of this.series) {
        const v = this.value(s, ser);
        acc = stacked ? acc + v : Math.max(acc, v);
      }
      peak = Math.max(peak, acc);
    }
    const target = Math.max(peak * 1.18, 1);
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
      ctx.fillRect(padL, y, pw, dpr);
      ctx.fillStyle = th.text3;
      ctx.fillText(this.axisFormat(v), padL + 4 * dpr, y - 3 * dpr);
    }
    ctx.fillStyle = th.border2;
    ctx.fillRect(padL, Math.round(Y(0)), pw, dpr);

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

    // Areas.
    if (vis.length > 1) {
      const base = new Float64Array(vis.length);
      const order = stacked ? this.series : [...this.series];
      for (const ser of order) {
        const col = th.color(ser.color);
        const top = new Float64Array(vis.length);
        for (let i = 0; i < vis.length; i++) top[i] = (stacked ? base[i] : 0) + this.value(vis[i], ser);
        ctx.beginPath();
        ctx.moveTo(X(vis[0].ts), Y(stacked ? base[0] : 0));
        for (let i = 0; i < vis.length; i++) ctx.lineTo(X(vis[i].ts), Y(top[i]));
        for (let i = vis.length - 1; i >= 0; i--) ctx.lineTo(X(vis[i].ts), Y(stacked ? base[i] : 0));
        ctx.closePath();
        const g = ctx.createLinearGradient(0, padT, 0, padT + ph);
        g.addColorStop(0, alpha(col, stacked ? 0.42 : 0.26));
        g.addColorStop(1, alpha(col, stacked ? 0.18 : 0.01));
        ctx.fillStyle = g;
        ctx.fill();
        ctx.beginPath();
        for (let i = 0; i < vis.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(vis[i].ts), Y(top[i]));
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6 * dpr;
        ctx.lineJoin = 'round';
        ctx.stroke();
        if (stacked) base.set(top);
      }
      // Live head on the newest point.
      const lastI = vis.length - 1;
      const hx = X(vis[lastI].ts);
      if (hx <= W && !stacked) {
        for (const ser of this.series) {
          const col = th.color(ser.color);
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(hx, Y(this.value(vis[lastI], ser)), 2.6 * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Hover crosshair and tooltip.
    if (this.hoverX != null && vis.length) {
      const tsAt = x0 + ((this.hoverX * dpr - padL) / pw) * (x1 - x0);
      let best = vis[0], bd = Infinity;
      for (const s of vis) {
        const d = Math.abs(s.ts - tsAt);
        if (d < bd) { bd = d; best = s; }
      }
      const cx = X(best.ts) / dpr;
      this.cross.style.transform = `translateX(${cx}px)`;
      const rect = this.cv.getBoundingClientRect();
      let total = 0;
      const rows = this.series.map((ser) => {
        const v = this.value(best, ser);
        total += v;
        return `<div class="tt-row"><i style="background:${th.color(ser.color)}"></i>${ser.label}<b>${this.format(v)}</b></div>`;
      }).join('');
      const tot = stacked && this.series.length > 1 ? `<div class="tt-row" style="border-top:1px solid ${th.border};margin-top:4px;padding-top:4px">Total<b>${this.format(total)}</b></div>` : '';
      showTip(rect.left + cx, this.hoverY, `<div class="tt-title">${time(best.ts)}</div>${rows}${tot}`);
    }
  }
}

function pickTick(span) {
  const opts = [10e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3];
  for (const o of opts) if (span / o <= 6) return o;
  return 12 * 3600e3;
}

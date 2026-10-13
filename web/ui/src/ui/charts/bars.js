import { chartTheme, showTip, fitCanvas } from './theme.js';
import { time, niceStep } from '../../util/format.js';
import { approach } from '../../app/motion.js';

/**
 * Stacked bar chart on canvas: one bar per time bucket, bars grow into
 * place when data changes, hover shows the bucket breakdown.
 * buckets: [{ ts, values: { key: n } }]; series: [{ key, label, color }]
 */
export class BarChart {
  constructor(el, { series, format = (v) => String(Math.round(v)), bucketMs = 60e3 }) {
    this.el = el;
    el.classList.add('chart');
    this.cv = document.createElement('canvas');
    el.appendChild(this.cv);
    this.series = series;
    this.format = format;
    this.bucketMs = bucketMs;
    this.buckets = [];
    this.shown = new Map(); // ts → animated totals per series
    this.yMax = 0;
    this.hover = null;
    el.addEventListener('pointermove', (e) => {
      const r = this.cv.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY, left: r.left };
    });
    el.addEventListener('pointerleave', () => {
      this.hover = null;
      showTip(0, 0, null);
    });
  }

  set(buckets) {
    this.buckets = buckets;
  }

  draw(dt) {
    const [W, H, dpr] = fitCanvas(this.cv);
    const ctx = this.cv.getContext('2d');
    const th = chartTheme();
    const B = this.buckets;
    const padB = 20 * dpr, padT = 8 * dpr;
    const ph = H - padB - padT;
    let peak = 1;
    for (const b of B) {
      let s = 0;
      for (const ser of this.series) s += b.values[ser.key] || 0;
      peak = Math.max(peak, s);
    }
    const target = peak * 1.15;
    this.yMax = this.yMax ? approach(this.yMax, target, dt, 6) : target;
    ctx.clearRect(0, 0, W, H);
    const stepY = niceStep(this.yMax, 3);
    ctx.font = th.font.replace('11px', `${11 * dpr}px`);
    ctx.textBaseline = 'bottom';
    for (let v = stepY; v < this.yMax; v += stepY) {
      const y = Math.round(padT + ph - (v / this.yMax) * ph) + 0.5;
      ctx.fillStyle = th.grid;
      ctx.fillRect(0, y, W, dpr);
      ctx.fillStyle = th.text3;
      ctx.fillText(this.format(v), 4 * dpr, y - 3 * dpr);
    }
    const n = Math.max(B.length, 1);
    const slot = W / n;
    const bw = Math.max(2 * dpr, slot * 0.68);
    const seen = new Set();
    let hoverB = null;
    B.forEach((b, i) => {
      seen.add(b.ts);
      let cur = this.shown.get(b.ts);
      if (!cur) this.shown.set(b.ts, (cur = {}));
      let y = padT + ph;
      const x = i * slot + (slot - bw) / 2;
      const hovered = this.hover && this.hover.x * dpr >= i * slot && this.hover.x * dpr < (i + 1) * slot;
      if (hovered) hoverB = { b, cx: (i + 0.5) * slot / dpr };
      for (const ser of this.series) {
        const v = b.values[ser.key] || 0;
        cur[ser.key] = approach(cur[ser.key] || 0, v, dt, 9);
        const hgt = (cur[ser.key] / this.yMax) * ph;
        if (hgt < 0.5) continue;
        ctx.fillStyle = th.color(ser.color);
        ctx.globalAlpha = this.hover && !hovered ? 0.55 : 0.92;
        roundTop(ctx, x, y - hgt, bw, hgt, Math.min(3 * dpr, bw / 2));
        y -= hgt;
      }
      ctx.globalAlpha = 1;
    });
    for (const k of this.shown.keys()) if (!seen.has(k)) this.shown.delete(k);
    ctx.fillStyle = th.text3;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const every = Math.ceil(n / 6);
    B.forEach((b, i) => {
      if (i % every) return;
      ctx.fillText(time(b.ts, false), (i + 0.5) * slot, H - padB + 6 * dpr);
    });
    ctx.textAlign = 'left';
    if (hoverB) {
      const rows = this.series.map((s) => `<div class="tt-row"><i style="background:${th.color(s.color)}"></i>${s.label}<b>${this.format(hoverB.b.values[s.key] || 0)}</b></div>`).join('');
      showTip(this.hover.left + hoverB.cx, this.hover.y, `<div class="tt-title">${time(hoverB.b.ts, false)}</div>${rows}`);
    }
  }
}

function roundTop(ctx, x, y, w, h, r) {
  r = Math.min(r, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

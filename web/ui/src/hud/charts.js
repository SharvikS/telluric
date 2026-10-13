import { appColor, cssColor, APP_ROWS } from '../config.js';
import { rate } from '../util/format.js';

/** Fit a canvas's backing store to its CSS box. Returns [w, h, dpr]. */
export function fitCanvas(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  return [w, h, dpr];
}

/** Area sparkline of `values` (oldest first). */
export function sparkline(cv, values, rgb, floor = 1024) {
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  let max = floor;
  for (const v of values) if (v > max) max = v;
  const n = values.length;
  const x = (i) => (i / (n - 1)) * (w - 2) + 1;
  const y = (v) => h - 2 - (Math.log1p(v) / Math.log1p(max)) * (h - 5);
  ctx.beginPath();
  ctx.moveTo(x(0), h);
  for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(values[i]));
  ctx.lineTo(x(n - 1), h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, cssColor(rgb, 0.35));
  g.addColorStop(1, cssColor(rgb, 0.0));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(i), y(values[i]));
  ctx.strokeStyle = cssColor(rgb, 0.95);
  ctx.lineWidth = Math.max(1, h / 24);
  ctx.shadowColor = cssColor(rgb, 0.8);
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.shadowBlur = 0;
  // Live head.
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(x(n - 1), y(values[n - 1]), Math.max(1.5, h / 16), 0, Math.PI * 2);
  ctx.fill();
}

/** Protocol mix ring. rows: Map(appRow → bytes/s). */
export function donut(cv, rows, legendEl) {
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 6;
  ctx.clearRect(0, 0, w, h);
  let total = 0;
  for (const [, v] of rows) total += v;
  ctx.lineWidth = r * 0.26;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(94, 242, 255, 0.07)';
  ctx.beginPath();
  ctx.arc(cx, cy, r - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();
  let a = -Math.PI / 2;
  const legend = [];
  for (const [key, label] of APP_ROWS) {
    const v = rows.get(key) || 0;
    const frac = total > 0 ? v / total : 0;
    const rgb = appColor(key === 'other' ? 'unknown' : key);
    legend.push([label, rgb, frac]);
    if (frac < 0.004) continue;
    const span = frac * Math.PI * 2;
    ctx.strokeStyle = cssColor(rgb, 0.95);
    ctx.shadowColor = cssColor(rgb, 0.9);
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r - ctx.lineWidth / 2, a + 0.03, a + Math.max(0.035, span - 0.03));
    ctx.stroke();
    a += span;
  }
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#d3f2ff';
  ctx.font = `700 ${Math.round(r * 0.3)}px 'JetBrains Mono', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const [num, unit] = rate(total).split(' ');
  ctx.fillText(num, cx, cy - r * 0.08);
  ctx.fillStyle = '#6d8ca2';
  ctx.font = `500 ${Math.round(r * 0.17)}px 'JetBrains Mono', monospace`;
  ctx.fillText(unit || '', cx, cy + r * 0.24);
  if (legendEl) {
    legendEl.innerHTML = legend
      .sort((x, y) => y[2] - x[2])
      .slice(0, 6)
      .map(([label, rgb, frac]) => `<i style="background:${cssColor(rgb)};box-shadow:0 0 6px ${cssColor(rgb, 0.8)}"></i><span>${label}</span><b>${frac > 0 ? (frac * 100).toFixed(frac < 0.1 ? 1 : 0) : '0'}%</b>`)
      .join('');
  }
}

/**
 * Scrolling spectrogram: one row per protocol family, one column per sample,
 * brightness ∝ log(bytes/s). Columns are painted into an offscreen canvas
 * that is shifted left by one column per sample.
 */
export class Waterfall {
  constructor(cv, { seconds = 120, step = 0.5 } = {}) {
    this.cv = cv;
    this.cols = Math.round(seconds / step);
    this.step = step;
    this.off = document.createElement('canvas');
    this.max = 1e5;
    this.last = 0;
    this.labelW = 54;
    this.compactW = 16;
  }

  push(rows, now) {
    if (now - this.last < this.step * 1000) return;
    this.last = now;
    const [w, h, dpr] = fitCanvas(this.cv);
    const rowsH = h / APP_ROWS.length;
    const lw = Math.round((rowsH >= 9.5 * dpr ? this.labelW : this.compactW) * dpr);
    const gw = Math.max(1, w - lw);
    if (this.off.width !== gw || this.off.height !== h) {
      const old = this.off;
      const n = document.createElement('canvas');
      n.width = gw;
      n.height = h;
      if (old.width && old.height) n.getContext('2d').drawImage(old, 0, 0, gw, h);
      this.off = n;
    }
    const octx = this.off.getContext('2d');
    const colW = gw / this.cols;
    octx.drawImage(this.off, -colW, 0);
    octx.fillStyle = '#020a12';
    octx.fillRect(gw - colW - 1, 0, colW + 2, h);
    let peak = 0;
    for (const [, v] of rows) peak = Math.max(peak, v);
    this.max = Math.max(peak, this.max * 0.995, 2e4);
    const rowH = h / APP_ROWS.length;
    APP_ROWS.forEach(([key], i) => {
      const v = rows.get(key) || 0;
      const k = v > 0 ? Math.min(1, Math.log1p(v) / Math.log1p(this.max)) : 0;
      if (k <= 0.02) return;
      const rgb = appColor(key === 'other' ? 'unknown' : key);
      const e = Math.pow(k, 1.6);
      octx.fillStyle = cssColor([rgb[0] * e + 0.02, rgb[1] * e + 0.04, rgb[2] * e + 0.06], 1);
      octx.fillRect(gw - colW - 0.5, i * rowH + 1, colW + 1, rowH - 2);
      if (k > 0.82) {
        octx.fillStyle = `rgba(255,255,255,${(k - 0.82) * 2.2})`;
        octx.fillRect(gw - colW - 0.5, i * rowH + rowH * 0.35, colW + 1, rowH * 0.3);
      }
    });
    this.draw(w, h, dpr, lw, rowH);
  }

  draw(w, h, dpr, lw, rowH) {
    const ctx = this.cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.off, lw, 0);
    ctx.font = `700 ${Math.round(9 * dpr)}px 'JetBrains Mono', monospace`;
    ctx.textBaseline = 'middle';
    const showText = rowH >= 9.5 * dpr;
    APP_ROWS.forEach(([key, label], i) => {
      const rgb = appColor(key === 'other' ? 'unknown' : key);
      const sq = Math.min(4 * dpr, rowH * 0.6);
      ctx.fillStyle = cssColor(rgb, 0.85);
      ctx.fillRect(6 * dpr, i * rowH + rowH / 2 - sq / 2, sq, sq);
      if (!showText) return;
      ctx.fillStyle = 'rgba(160, 200, 220, 0.75)';
      ctx.fillText(label, 15 * dpr, i * rowH + rowH / 2 + 0.5);
    });
    // Time ticks every 30 s.
    ctx.fillStyle = 'rgba(94, 242, 255, 0.18)';
    const gw = w - lw;
    for (let s = 30; s < this.cols * this.step; s += 30) {
      const x = lw + gw - (s / (this.cols * this.step)) * gw;
      ctx.fillRect(Math.round(x), 0, 1, h);
    }
  }
}

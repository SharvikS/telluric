import { chartTheme, alpha, showTip, fitCanvas } from './theme.js';
import { time } from '../../util/format.js';

/**
 * Heatmap: rows × time buckets, cell opacity ∝ value. Used for alert
 * activity by severity and DNS activity by type.
 * rows: [{ key, label, color }]; cols: [{ ts, values: { key: n } }]
 */
export class Heatmap {
  constructor(el, { rows, format = (v) => String(v), labelW = 74 }) {
    this.el = el;
    el.classList.add('chart');
    this.cv = document.createElement('canvas');
    el.appendChild(this.cv);
    this.rows = rows;
    this.format = format;
    this.labelW = labelW;
    this.cols = [];
    this.hover = null;
    el.addEventListener('pointermove', (e) => {
      const r = this.cv.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
      this.dirty = true;
    });
    el.addEventListener('pointerleave', () => {
      this.hover = null;
      this.dirty = true;
      showTip(0, 0, null);
    });
  }

  set(cols) {
    this.cols = cols;
    this.dirty = true;
  }

  draw() {
    const [W, H, dpr] = fitCanvas(this.cv);
    if (!this.dirty && this._w === W && this._h === H) return;
    this.dirty = false;
    this._w = W;
    this._h = H;
    const ctx = this.cv.getContext('2d');
    const th = chartTheme();
    ctx.clearRect(0, 0, W, H);
    const lw = this.labelW * dpr, padB = 18 * dpr;
    const rh = (H - padB) / this.rows.length;
    const n = Math.max(1, this.cols.length);
    const cw = (W - lw) / n;
    let max = 1;
    for (const c of this.cols) for (const r of this.rows) max = Math.max(max, c.values[r.key] || 0);
    ctx.font = th.font.replace('11px', `${11 * dpr}px`);
    ctx.textBaseline = 'middle';
    let tip = null;
    this.rows.forEach((r, ri) => {
      ctx.fillStyle = th.text2;
      ctx.fillText(r.label, 0, ri * rh + rh / 2);
      const col = th.color(r.color);
      this.cols.forEach((c, ci) => {
        const v = c.values[r.key] || 0;
        const x = lw + ci * cw + 1 * dpr, y = ri * rh + 1.5 * dpr;
        const w = cw - 2 * dpr, hh = rh - 3 * dpr;
        ctx.fillStyle = v ? alpha(col, 0.18 + 0.82 * Math.sqrt(v / max)) : th.grid;
        const rr = Math.min(3 * dpr, w / 3, hh / 3);
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, y, w, hh, rr) : ctx.rect(x, y, w, hh);
        ctx.fill();
        if (this.hover) {
          const hx = this.hover.x * dpr, hy = this.hover.y * dpr;
          if (hx >= x && hx < x + w && hy >= y && hy < y + hh) {
            tip = `<div class="tt-title">${time(c.ts, false)}</div><div class="tt-row"><i style="background:${col}"></i>${r.label}<b>${this.format(v)}</b></div>`;
            ctx.strokeStyle = th.text;
            ctx.lineWidth = 1.5 * dpr;
            ctx.stroke();
          }
        }
      });
    });
    ctx.fillStyle = th.text3;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const every = Math.ceil(n / 6);
    this.cols.forEach((c, i) => {
      if (i % every) return;
      ctx.fillText(time(c.ts, false), lw + (i + 0.5) * cw, H - padB + 5 * dpr);
    });
    ctx.textAlign = 'left';
    if (this.hover) showTip(this.hover.cx, this.hover.cy, tip);
  }
}

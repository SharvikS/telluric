import { chartTheme } from './theme.js';
import { motion } from '../../app/motion.js';

const TAU = Math.PI * 2;

function arcPath(cx, cy, R, r, a0, a1) {
  if (a1 - a0 >= TAU - 1e-4) a1 = a0 + TAU - 1e-4;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (rad, a) => `${(cx + rad * Math.sin(a)).toFixed(2)} ${(cy - rad * Math.cos(a)).toFixed(2)}`;
  return `M${p(R, a0)}A${R} ${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r} ${r} 0 ${large} 0 ${p(r, a0)}Z`;
}

/**
 * SVG donut whose segments tween between data updates; hovering a segment
 * (or its legend row) lifts it and shows its share in the centre.
 */
export class Donut {
  constructor(el, { thickness = 14, format, centerLabel = 'total' }) {
    this.el = el;
    el.classList.add('chart');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'chart-svg');
    this.center = document.createElement('div');
    this.center.className = 'donut-center';
    el.append(this.svg, this.center);
    this.thickness = thickness;
    this.format = format;
    this.centerLabel = centerLabel;
    this.paths = new Map();
    this.cur = new Map(); // key → [a0, a1]
    this.from = new Map();
    this.to = new Map();
    this.t = 1;
    this.rows = [];
    this.hover = null;
  }

  set(rows) {
    this.rows = rows;
    const total = rows.reduce((s, r) => s + r.value, 0) || 1;
    let a = 0;
    this.from = new Map(this.cur);
    this.to = new Map();
    const gap = rows.filter((r) => r.value > 0).length > 1 ? 0.035 : 0;
    for (const r of rows) {
      const span = (r.value / total) * TAU;
      this.to.set(r.key, [a + (span > gap ? gap / 2 : 0), a + Math.max(span - gap / 2, span > gap ? gap / 2 + 0.001 : 0)]);
      a += span;
    }
    for (const [k, v] of this.from) if (!this.to.has(k)) this.to.set(k, [v[1], v[1]]);
    for (const [k, v] of this.to) if (!this.from.has(k)) this.from.set(k, [v[0], v[0]]);
    this.t = motion.reduced ? 1 : 0;
    this.total = rows.reduce((s, r) => s + r.value, 0);
    this.renderCenter();
  }

  setHover(key) {
    this.hover = key;
    this.renderCenter();
  }

  renderCenter() {
    const r = this.hover ? this.rows.find((x) => x.key === this.hover) : null;
    const total = this.total || 0;
    const html = r
      ? `<div><b>${total ? Math.round((r.value / total) * 100) : 0}%</b><small>${r.label}</small></div>`
      : `<div><b>${this.format(total)}</b><small>${this.centerLabel}</small></div>`;
    if (this.center._h !== html) {
      this.center._h = html;
      this.center.innerHTML = html;
    }
  }

  frame(dt) {
    if (this.t >= 1 && this._drawn && this._hoverDrawn === this.hover) return;
    this.t = Math.min(1, this.t + dt / 0.65);
    const e = 1 - Math.pow(1 - this.t, 3);
    const w = this.el.clientWidth, hgt = this.el.clientHeight;
    const size = Math.min(w, hgt);
    const cx = w / 2, cy = hgt / 2, R = size / 2 - 4, r = R - this.thickness;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    const th = chartTheme();
    for (const [k, to] of this.to) {
      const fr = this.from.get(k) || to;
      const a0 = fr[0] + (to[0] - fr[0]) * e, a1 = fr[1] + (to[1] - fr[1]) * e;
      this.cur.set(k, [a0, a1]);
      let p = this.paths.get(k);
      if (!p) {
        p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.addEventListener('pointerenter', () => this.setHover(k));
        p.addEventListener('pointerleave', () => this.setHover(null));
        this.svg.appendChild(p);
        this.paths.set(k, p);
      }
      const row = this.rows.find((x) => x.key === k);
      const lift = this.hover === k ? 3 : 0;
      p.setAttribute('d', a1 - a0 > 0.0005 ? arcPath(cx, cy, R + lift, r - (lift ? 1 : 0), a0, a1) : '');
      p.setAttribute('fill', row ? th.color(row.color) : 'transparent');
      p.style.opacity = this.hover && this.hover !== k ? '0.35' : '1';
      p.style.transition = 'opacity 180ms';
    }
    for (const [k, p] of this.paths) if (!this.to.has(k)) { p.remove(); this.paths.delete(k); }
    this._drawn = true;
    this._hoverDrawn = this.hover;
  }
}

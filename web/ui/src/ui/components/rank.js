import { h } from '../dom.js';

const ROW = 48;

/**
 * Leaderboard. Rows are keyed nodes positioned with transforms, so rank
 * changes glide (FLIP without measuring); ranking uses a smoothed value with
 * hysteresis so rows only move for real changes.
 * items: [{ key, icon (html), name, sub, value, display, color, bar (0..1) }]
 */
export class RankList {
  constructor({ max = 6, onClick, rowH = ROW } = {}) {
    this.max = max;
    this.onClick = onClick;
    this.rowH = rowH;
    this.el = h('div.rank');
    this.rows = new Map();
    this.smooth = new Map();
    this.order = [];
  }

  set(items) {
    for (const it of items) {
      const p = this.smooth.get(it.key);
      it._rank = p == null ? it.value : p * 0.6 + it.value * 0.4;
      this.smooth.set(it.key, it._rank);
    }
    const pos = new Map(this.order.map((k, i) => [k, i]));
    items.sort((a, b) => {
      const hi = Math.max(a._rank, b._rank), lo = Math.min(a._rank, b._rank);
      if (hi > 0 && (hi - lo) / hi < 0.18 && pos.has(a.key) && pos.has(b.key)) return pos.get(a.key) - pos.get(b.key);
      return b._rank - a._rank;
    });
    const shown = items.slice(0, this.max);
    this.order = shown.map((x) => x.key);
    this.el.style.height = `${Math.max(shown.length, 1) * this.rowH}px`;
    const keep = new Set();
    shown.forEach((it, i) => {
      keep.add(it.key);
      let r = this.rows.get(it.key);
      if (!r) {
        r = h('div.rank-row', { role: 'button', tabindex: '0' },
          h('div.r-ic'), h('div.r-main', h('div.r-name'), h('div.r-sub'), h('div.r-bar', h('i'))), h('div.r-val'));
        r.style.height = `${this.rowH}px`;
        r.style.transform = `translateY(${i * this.rowH + 8}px)`;
        r.style.opacity = '0';
        r.addEventListener('click', () => this.onClick?.(r._key, r));
        r.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.onClick?.(r._key, r); });
        this.el.appendChild(r);
        this.rows.set(it.key, r);
        requestAnimationFrame(() => { r.style.opacity = '1'; });
      }
      r._key = it.key;
      r.style.transform = `translateY(${i * this.rowH}px)`;
      r.style.opacity = '1';
      const [ic, main, val] = r.children;
      if (ic._h !== it.icon) { ic._h = it.icon; ic.innerHTML = it.icon || ''; }
      const [nm, sub, bar] = main.children;
      if (nm.textContent !== it.name) nm.textContent = it.name;
      if (sub.textContent !== (it.sub || '')) sub.textContent = it.sub || '';
      const fill = bar.firstChild;
      fill.style.transform = `scaleX(${Math.max(0.002, Math.min(1, it.bar))})`;
      fill.style.background = it.color || 'var(--accent)';
      if (val._h !== it.display) { val._h = it.display; val.innerHTML = it.display; }
    });
    for (const [k, r] of this.rows) {
      if (keep.has(k)) continue;
      this.rows.delete(k);
      r.style.opacity = '0';
      setTimeout(() => r.remove(), 320);
    }
  }
}

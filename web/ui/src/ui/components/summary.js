import { h } from '../dom.js';
import { Tweens } from '../../app/motion.js';
import { esc } from '../../util/format.js';

/**
 * Summary strip above a table: a few headline numbers and a distribution bar
 * whose segments (and legend entries) act as one-click filters.
 *
 * stats: [{ key, label, tip, format(v) → html, tone(v) → 'danger' | 'warning' | '' }]
 * dist:  { title, onPick(key) }
 */
export class Summary {
  constructor({ stats, dist }) {
    this.tw = new Tweens();
    this.stats = new Map();
    this.segs = new Map();
    this.order = '';
    const cells = stats.map((s) => {
      const v = h('div.sum-v');
      const cell = h('div.sum-stat', { 'data-tip': s.tip || null }, h('div.sum-l', s.label), v);
      this.stats.set(s.key, { def: s, v, cell, num: null });
      return cell;
    });
    this.dist = dist;
    this.bar = h('div.dist-bar', { role: 'list' });
    this.legend = h('div.dist-legend');
    this.distTitle = h('span', dist ? dist.title : '');
    this.distNote = h('span.sub');
    this.el = h('div.card.summary',
      h('div.sum-stats', ...cells),
      dist ? h('div.sum-dist', h('div.dist-head', this.distTitle, h('span.spacer'), this.distNote), this.bar, this.legend) : null);
    const pick = (e) => {
      const t = e.target.closest('[data-seg]');
      if (t && t.dataset.seg !== '__other') dist.onPick?.(t.dataset.seg);
    };
    this.bar.addEventListener('click', pick);
    this.legend.addEventListener('click', pick);
  }

  /** values: { key: number }, segments: [{ key, label, value, color }] (sorted). */
  set(values, segments, note = '') {
    for (const [k, st] of this.stats) {
      const v = values[k];
      const { def } = st;
      if (typeof v === 'number' && !def.format) {
        if (!st.num) st.num = this.tw.number(st.v, (x) => Math.round(x).toLocaleString());
        st.num.to(v);
      } else {
        const html = def.format ? def.format(v) : esc(String(v ?? '—'));
        if (st.v._h !== html) { st.v._h = html; st.v.innerHTML = html; }
      }
      const tone = def.tone ? def.tone(v) : '';
      if (st.cell._tone !== tone) {
        st.cell._tone = tone;
        st.cell.classList.toggle('danger', tone === 'danger');
        st.cell.classList.toggle('warning', tone === 'warning');
      }
    }
    if (!this.dist) return;
    if (this.distNote.textContent !== note) this.distNote.textContent = note;
    const total = segments.reduce((a, s) => a + s.value, 0) || 1;
    // Keep DOM order stable while the set of keys is unchanged so widths can
    // glide; re-order only when segments come or go.
    const keys = segments.map((s) => s.key).join('|');
    const reorder = keys !== this.order;
    this.order = keys;
    const keep = new Set();
    for (const s of segments) {
      keep.add(s.key);
      let g = this.segs.get(s.key);
      if (!g) {
        const seg = h('i', { 'data-seg': s.key, role: 'listitem' });
        seg.style.width = '0%';
        const item = h('button', { type: 'button', 'data-seg': s.key }, h('i'), h('span.l'), h('b'));
        g = { seg, item };
        this.segs.set(s.key, g);
      }
      const pct = (s.value / total) * 100;
      g.seg.style.background = s.color;
      g.item.firstChild.style.background = s.color;
      g.seg.dataset.tip = `${s.label} · ${pct < 1 ? '<1' : Math.round(pct)}%`;
      requestAnimationFrame(() => { g.seg.style.width = `${pct}%`; });
      const [, l, b] = g.item.children;
      if (l.textContent !== s.label) l.textContent = s.label;
      const pt = `${pct < 1 ? '<1' : Math.round(pct)}%`;
      if (b.textContent !== pt) b.textContent = pt;
      g.item.classList.toggle('static', s.key === '__other');
      if (reorder) {
        this.bar.appendChild(g.seg);
        this.legend.appendChild(g.item);
      }
    }
    for (const [k, g] of this.segs) {
      if (keep.has(k)) continue;
      g.seg.remove();
      g.item.remove();
      this.segs.delete(k);
    }
  }

  frame(dt) {
    this.tw.update(dt);
  }
}

/** Top-N segments plus an "Other" remainder. */
export function topSegments(map, n, label, color, otherColor = 'var(--border-3)') {
  const all = [...map].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const head = all.slice(0, n).map(([k, v], i) => ({ key: k, label: label(k), value: v, color: color(k, i) }));
  const rest = all.slice(n).reduce((a, [, v]) => a + v, 0);
  if (rest > 0) head.push({ key: '__other', label: 'Other', value: rest, color: otherColor });
  return head;
}

/** Ordinal ramp of the accent for categories without a semantic colour. */
export const accentRamp = (i) => `color-mix(in srgb, var(--accent) ${[100, 78, 60, 46, 34, 24][i] ?? 20}%, var(--surface-3))`;

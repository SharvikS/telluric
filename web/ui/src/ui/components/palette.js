import { h, isTyping } from '../dom.js';
import { icon } from '../icons.js';
import { esc } from '../../util/format.js';

/**
 * Fuzzy subsequence match with bonuses for word starts and runs.
 * Returns { score, idx } or null.
 */
export function fuzzy(query, text) {
  if (!query) return { score: 0, idx: [] };
  const q = query.toLowerCase(), t = text.toLowerCase();
  let ti = 0, score = 0, run = 0;
  const idx = [];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === ' ') continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === c) { found = ti; break; }
      ti++;
    }
    if (found < 0) return null;
    const prev = found > 0 ? t[found - 1] : ' ';
    const boundary = /[\s._\-/:@]/.test(prev);
    score += 1 + (boundary ? 8 : 0) + (found === 0 ? 10 : 0);
    if (idx.length && idx[idx.length - 1] === found - 1) {
      run++;
      score += 4 + run;
    } else run = 0;
    idx.push(found);
    ti = found + 1;
  }
  // Scattered letters are not a match: require the matched characters to
  // sit reasonably close together (or be word-start chains).
  const qn = q.replace(/\s+/g, '').length;
  const span = idx.length ? idx[idx.length - 1] - idx[0] + 1 : 0;
  const starts = idx.filter((i) => i === 0 || /[\s._\-/:@]/.test(t[i - 1])).length;
  if (qn > 1 && span > qn * 3 + 2 && starts < Math.ceil(qn / 2)) return null;
  score -= (span - qn) * 0.6 + (t.length - idx.length) * 0.02;
  return { score, idx };
}

function highlight(text, idx) {
  if (!idx || !idx.length) return esc(text);
  let out = '';
  const set = new Set(idx);
  for (let i = 0; i < text.length; i++) out += set.has(i) ? `<mark>${esc(text[i])}</mark>` : esc(text[i]);
  return out;
}

/**
 * Command palette (⌘K): navigate, run actions, jump to any entity.
 * source() returns groups: [{ name, items: [{ title, sub, icon, end, run, keywords }] }].
 */
export class Palette {
  constructor(source) {
    this.source = source;
    this.input = h('input', { type: 'text', placeholder: 'Search hosts, processes, alerts… or type a command', spellcheck: 'false', 'aria-label': 'Command palette' });
    this.list = h('div.palette-list', { role: 'listbox' });
    this.el = h('div.palette', { role: 'dialog', 'aria-modal': 'true' },
      h('div.palette-input', { html: icon('search') }, this.input),
      this.list,
      h('div.palette-foot', h('span', h('kbd', '↑'), h('kbd', '↓'), 'navigate'), h('span', h('kbd', '↵'), 'open'), h('span', h('kbd', 'esc'), 'close')));
    this.el.firstChild.appendChild(this.input);
    this.scrim = h('div.palette-scrim');
    document.body.append(this.scrim, this.el);
    this.scrim.addEventListener('click', () => this.close());
    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); this.move(1); }
      else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); this.move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); this.choose(this.sel); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    this.items = [];
    this.sel = 0;
  }

  get isOpen() {
    return this.el.classList.contains('show');
  }

  open(prefill = '') {
    this.prev = document.activeElement;
    this.el.classList.add('show');
    this.scrim.classList.add('show');
    this.input.value = prefill;
    this.run();
    requestAnimationFrame(() => this.input.focus());
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.remove('show');
    this.scrim.classList.remove('show');
    this.input.blur();
    if (this.prev && this.prev.focus && !isTyping({ target: this.prev })) this.prev.focus({ preventScroll: true });
  }

  run() {
    const q = this.input.value.trim();
    const groups = this.source(q);
    const out = [];
    this.list.innerHTML = '';
    for (const g of groups) {
      let scored = g.items.map((it) => {
        const m = fuzzy(q, it.title) || (it.keywords ? (() => { const k = fuzzy(q, it.keywords); return k ? { score: k.score * 0.6, idx: [] } : null; })() : null);
        return m ? { it, m } : null;
      }).filter(Boolean);
      if (q) scored.sort((a, b) => b.m.score - a.m.score);
      scored = scored.slice(0, q ? g.limit || 6 : g.emptyLimit ?? g.limit ?? 6);
      if (!scored.length) continue;
      this.list.appendChild(h('div.palette-group', g.name));
      for (const { it, m } of scored) {
        const i = out.length;
        const row = h('div.palette-item', { role: 'option' },
          h('div.p-ic', { html: icon(it.icon || 'arrow-right') }),
          h('div.p-main', h('div.p-title', { html: highlight(it.title, m.idx) }), it.sub ? h('div.p-sub', it.sub) : null),
          it.end ? h('div.p-end', { html: it.end }) : null);
        row.addEventListener('pointermove', () => { if (this.sel !== i) this.setSel(i); });
        row.addEventListener('click', () => this.choose(i));
        this.list.appendChild(row);
        out.push({ it, row });
      }
    }
    this.items = out;
    if (!out.length) this.list.appendChild(h('div.palette-empty', q ? `No results for “${q}”` : 'Nothing here yet'));
    this.setSel(0);
  }

  setSel(i) {
    if (!this.items.length) return;
    this.sel = (i + this.items.length) % this.items.length;
    this.items.forEach((x, k) => x.row.classList.toggle('on', k === this.sel));
    this.items[this.sel].row.scrollIntoView({ block: 'nearest' });
  }

  move(d) {
    this.setSel(this.sel + d);
  }

  choose(i) {
    const x = this.items[i];
    if (!x) return;
    this.close();
    x.it.run();
  }
}

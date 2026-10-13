import { h, download } from '../dom.js';
import { icon } from '../icons.js';
import { openMenu, openPopover, closePopover } from './popover.js';
import { emptyState } from './controls.js';
import { esc } from '../../util/format.js';
import { motion } from '../../app/motion.js';

const OVERSCAN = 8;
// Live data re-sorts at most this often, and never under the pointer, so
// rows don't keep sliding away from the cursor.
const RESORT_MS = 3000;

/**
 * Virtualized data table.
 *
 * columns: [{ key, label, w (px), flex, align: 'right', visible, hide (px: auto-hide when the table is
 *   narrower), sort(row), html(row), text(row) }]
 * Options: rowKey(row), onOpen(row, el), filters: [{ key, label, value(row), format(v) }],
 * search(row) → haystack, sort: { key, dir }, rowClass(row), empty: { ill, title, body },
 * exportName, expand: { has(row), children(row), html(child, row) }, isNew(row).
 *
 * Only the rows in view exist in the DOM. Rows are keyed nodes positioned with
 * transforms; when the order changes, visible rows glide to their new slots.
 */
export class DataTable {
  constructor(opts) {
    this.o = opts;
    this.cols = opts.columns.map((c) => ({ visible: true, ...c }));
    this.sort = opts.sort || { key: this.cols[0].key, dir: 'desc' };
    this.filters = []; // [{ key, value }]
    this.query = '';
    this.rows = [];
    this.view = [];
    this.sel = -1;
    this.selKey = null;
    this.expanded = new Set();
    this.rowEls = new Map();
    this.seen = new Set();
    this.firstFill = true;
    this.rowH = 36;
    this.build();
  }

  build() {
    const o = this.o;
    this.input = h('input', { type: 'text', placeholder: o.placeholder || 'Filter…', spellcheck: 'false' });
    this.input.addEventListener('input', () => {
      this.query = this.input.value.trim().toLowerCase();
      this.apply();
    });
    const search = h('label.input', { html: icon('search') }, this.input);
    this.chips = h('div.dt-chips');
    const filterBtn = h('button.btn.sm', { type: 'button', html: `${icon('filter')}<span>Filter</span>` });
    filterBtn.addEventListener('click', () => this.openFilterMenu(filterBtn));
    const colBtn = h('button.btn.sm.ghost', { type: 'button', 'data-tip': 'Columns', html: icon('columns') });
    colBtn.addEventListener('click', () => openMenu(colBtn, [
      { header: 'Columns' },
      ...this.cols.filter((c) => c.label).map((c) => ({
        label: c.label, checked: this.shown().includes(c), keep: true,
        onSelect: () => {
          // An explicit choice beats auto-hiding on narrow screens.
          c.visible = !this.shown().includes(c);
          c.pinned = c.visible;
          this.relayout();
        },
      })),
    ]));
    const expBtn = h('button.btn.sm.ghost', { type: 'button', 'data-tip': 'Export', html: icon('download') });
    expBtn.addEventListener('click', () => openMenu(expBtn, [
      { header: `Export ${this.view.length} rows` },
      { label: 'CSV', icon: 'download', onSelect: () => this.export('csv') },
      { label: 'JSON', icon: 'download', onSelect: () => this.export('json') },
    ]));
    this.countEl = h('span.subtle.num');
    this.toolbar = h('div.dt-toolbar', search, filterBtn, this.chips, h('div.spacer'), this.countEl, colBtn, expBtn);
    if (o.toolbarExtra) this.toolbar.insertBefore(o.toolbarExtra, this.countEl);

    this.head = h('div.dt-head');
    this.spacer = h('div.dt-spacer');
    this.body = h('div.dt-body', { tabindex: '0', role: 'grid' }, this.head, this.spacer);
    this.emptyEl = h('div.dt-empty.hidden', o.empty ? emptyState(o.empty.ill, o.empty.title, o.empty.body) : h('div.subtle', 'No rows'));
    this.frame = h('div.dt-frame', this.body, this.emptyEl);
    this.el = h('div.dt', this.toolbar, this.frame);

    this.head.style.position = 'sticky';
    this.head.style.top = '0';
    this.body.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.frame.addEventListener('pointerenter', () => { this.hovering = true; });
    this.frame.addEventListener('pointerleave', () => { this.hovering = false; });
    this.body.addEventListener('keydown', (e) => this.key(e));
    new ResizeObserver(() => {
      const w = this.body.clientWidth;
      if (w !== this.lastW) { this.lastW = w; this.relayout(); }
    }).observe(this.body);
    this.relayout();
  }

  /** Columns on screen: the user's choice minus low-priority columns that
   *  step aside when the table is narrower than their `hide` width. */
  shown() {
    const w = this.body.clientWidth;
    return this.cols.filter((c) => c.visible && !(c.hide && !c.pinned && w > 0 && w < c.hide));
  }

  /** Column pixel widths; flex columns share the remaining space. */
  widths() {
    const vis = this.shown();
    const avail = Math.max(this.body.clientWidth, 400);
    const fixed = vis.reduce((s, c) => s + (c.flex ? (c.min || 160) : c.w || 100), 0);
    const flexTotal = vis.reduce((s, c) => s + (c.flex || 0), 0);
    const extra = Math.max(0, avail - fixed);
    return vis.map((c) => (c.flex ? (c.min || 160) + (extra * c.flex) / flexTotal : c.w || 100));
  }

  relayout() {
    const vis = this.shown();
    const ws = this.widths();
    this.totalW = ws.reduce((a, b) => a + b, 0);
    this.head.innerHTML = '';
    this.head.style.width = `${this.totalW}px`;
    vis.forEach((c, i) => {
      const th = h(`div.dt-th${c.align === 'right' ? '.right' : ''}`, { style: { width: `${ws[i]}px` }, 'data-tip': c.tip || null, role: 'columnheader' });
      const lab = h('span', c.label || '');
      const caret = h('span.sort', { html: icon('arrow-down') });
      if (c.align === 'right') th.append(caret, lab);
      else th.append(lab, caret);
      if (c.sort) {
        th.classList.add('sortable');
        th.addEventListener('click', () => {
          if (this.sort.key === c.key) this.sort.dir = this.sort.dir === 'desc' ? 'asc' : 'desc';
          else this.sort = { key: c.key, dir: c.defaultDir || 'desc' };
          this.updateSortHeader();
          this.apply();
        });
      } else th.style.cursor = 'default';
      th.dataset.key = c.key;
      this.head.appendChild(th);
    });
    this.updateSortHeader();
    for (const el of this.rowEls.values()) el.remove();
    this.rowEls.clear();
    this.spacer.style.width = `${this.totalW}px`;
    this.render(true);
  }

  updateSortHeader() {
    for (const th of this.head.children) {
      const on = th.dataset.key === this.sort.key;
      th.classList.toggle('sorted', on);
      th.classList.toggle('asc', on && this.sort.dir === 'asc');
    }
  }

  /** Replace the dataset (filter + sort + render). */
  setRows(rows) {
    this.rows = rows;
    this.apply(true);
  }

  /** live: a data refresh (order may be held) rather than a user action. */
  apply(live = false) {
    const o = this.o;
    let v = this.rows;
    for (const f of this.filters) {
      const def = o.filters.find((x) => x.key === f.key);
      v = v.filter((r) => String(def.value(r)) === String(f.value));
    }
    if (this.query && o.search) {
      const toks = this.query.split(/\s+/);
      v = v.filter((r) => {
        const hay = o.search(r);
        return toks.every((t) => hay.includes(t));
      });
    }
    const col = this.cols.find((c) => c.key === this.sort.key);
    if (col && col.sort) {
      const dir = this.sort.dir === 'asc' ? 1 : -1;
      const key = o.rowKey;
      const sorted = (rows) => rows.map((r) => [col.sort(r), r]).sort((a, b) => {
        if (a[0] < b[0]) return -dir;
        if (a[0] > b[0]) return dir;
        return key(a[1]) < key(b[1]) ? -1 : 1;
      }).map((x) => x[1]);
      const now = performance.now();
      const prev = this.order;
      if (live && prev && (this.hovering || now - this.lastSort < RESORT_MS)) {
        // Hold the order: known rows keep their places; newcomers slot in
        // where they sort (so a time-sorted log still grows at the top).
        const known = [], fresh = [];
        for (const r of v) (prev.has(key(r)) ? known : fresh).push(r);
        known.sort((a, b) => prev.get(key(a)) - prev.get(key(b)));
        const before = (a, b) => {
          const x = col.sort(a), y = col.sort(b);
          return x < y ? dir < 0 : x > y ? dir > 0 : key(a) < key(b);
        };
        for (const f of sorted(fresh)) {
          let i = 0;
          while (i < known.length && !before(f, known[i])) i++;
          known.splice(i, 0, f);
        }
        v = known;
      } else {
        v = sorted(v);
        this.lastSort = now;
      }
      this.order = new Map(v.map((r, i) => [key(r), i]));
    }
    // Expansion inserts child rows after their parent.
    if (o.expand && this.expanded.size) {
      const out = [];
      for (const r of v) {
        out.push(r);
        if (this.expanded.has(o.rowKey(r))) {
          for (const c of o.expand.children(r)) out.push({ __child: true, parent: r, row: c });
        }
      }
      v = out;
    }
    this.view = v;
    if (this.selKey != null) this.sel = this.view.findIndex((r) => !r.__child && o.rowKey(r) === this.selKey);
    const total = this.rows.length, shown = v.filter((r) => !r.__child).length;
    this.countEl.textContent = shown === total ? `${total.toLocaleString()} rows` : `${shown.toLocaleString()} of ${total.toLocaleString()}`;
    this.emptyEl.classList.toggle('hidden', v.length > 0);
    this.frame.classList.toggle('empty', v.length === 0);
    this.spacer.style.height = `${v.length * this.rowH}px`;
    this.render(false);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render(false);
    });
  }

  childKey(r) {
    return `c:${this.o.rowKey(r.parent)}:${this.o.expand.key(r.row)}`;
  }

  render(force) {
    const o = this.o;
    const vis = this.shown();
    const ws = this.widths();
    const top = this.body.scrollTop;
    const viewH = this.body.clientHeight || 600;
    const i0 = Math.max(0, Math.floor(top / this.rowH) - OVERSCAN);
    const i1 = Math.min(this.view.length, Math.ceil((top + viewH) / this.rowH) + OVERSCAN);
    const keep = new Set();
    const now = performance.now();
    for (let i = i0; i < i1; i++) {
      const r = this.view[i];
      const key = r.__child ? this.childKey(r) : o.rowKey(r);
      keep.add(key);
      let el = this.rowEls.get(key);
      const isNew = !el;
      if (!el) {
        el = h('div.dt-row', { role: 'row' });
        el.style.width = `${this.totalW}px`;
        el.style.transform = `translateY(${i * this.rowH}px)`;
        el.style.transition = 'none';
        if (r.__child) {
          el.classList.add('child');
          el.appendChild(h('div.dt-td', { style: { width: `${this.totalW}px`, paddingLeft: '38px' } }));
        } else {
          vis.forEach((c, ci) => el.appendChild(h(`div.dt-td${c.align === 'right' ? '.right' : ''}`, { style: { width: `${ws[ci]}px` } })));
          el.addEventListener('click', (e) => this.clickRow(el, e));
        }
        el._key = key;
        this.spacer.appendChild(el);
        this.rowEls.set(key, el);
        // Highlight rows that appear after the first fill.
        const rk = r.__child ? null : o.rowKey(r);
        if (!r.__child && !this.firstFill && !this.seen.has(rk) && (!o.isNew || o.isNew(r, now))) {
          el.classList.add('fresh');
          setTimeout(() => el.classList.remove('fresh'), 1700);
        }
        if (!r.__child) this.seen.add(rk);
        requestAnimationFrame(() => { el.style.transition = ''; });
      }
      el._row = r;
      const from = el._index;
      el._index = i;
      const y = `translateY(${i * this.rowH}px)`;
      if (el._y !== y) {
        el._y = y;
        if (!isNew && from != null && Math.abs(from - i) > 3 && !motion.reduced) {
          // Long jumps cross-fade instead of sliding through other rows.
          el.style.transition = 'none';
          el.style.transform = y;
          el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
          requestAnimationFrame(() => { el.style.transition = ''; });
        } else el.style.transform = y;
      }
      if (r.__child) {
        const td = el.firstChild;
        const s = o.expand.html(r.row, r.parent);
        if (td._s !== s) { td._s = s; td.innerHTML = s; }
      } else {
        const cells = el.children;
        for (let ci = 0; ci < vis.length; ci++) {
          const s = vis[ci].html ? vis[ci].html(r, this) : esc(vis[ci].text ? vis[ci].text(r) : r[vis[ci].key]);
          const td = cells[ci];
          if (td._s !== s) { td._s = s; td.innerHTML = s; }
        }
        el.classList.toggle('sel', i === this.sel);
        const extra = o.rowClass ? o.rowClass(r) : '';
        if (el._extra !== extra) {
          if (el._extra) el.classList.remove(...el._extra.split(' '));
          if (extra) el.classList.add(...extra.split(' '));
          el._extra = extra;
        }
      }
      if (isNew && force) el.style.transition = 'none';
    }
    for (const [k, el] of this.rowEls) {
      if (!keep.has(k)) {
        el.remove();
        this.rowEls.delete(k);
      }
    }
    if (this.view.length) this.firstFill = false;
  }

  clickRow(el, e) {
    const r = el._row;
    if (!r) return;
    if (this.o.expand && e.target.closest('[data-expand]')) {
      const k = this.o.rowKey(r);
      if (this.expanded.has(k)) this.expanded.delete(k);
      else this.expanded.add(k);
      this.apply();
      return;
    }
    if (e.target.closest('a,[data-stop]')) return;
    this.select(el._index, false);
    this.o.onOpen?.(r, el);
  }

  select(i, scroll = true) {
    if (!this.view.length) return;
    i = Math.max(0, Math.min(this.view.length - 1, i));
    if (this.view[i].__child) i += i > this.sel ? 1 : -1;
    i = Math.max(0, Math.min(this.view.length - 1, i));
    this.sel = i;
    const r = this.view[i];
    this.selKey = r && !r.__child ? this.o.rowKey(r) : null;
    if (scroll) {
      const y = i * this.rowH, top = this.body.scrollTop, vh = this.body.clientHeight - 36;
      if (y < top) this.body.scrollTop = y;
      else if (y + this.rowH > top + vh) this.body.scrollTop = y + this.rowH - vh;
    }
    this.render(false);
  }

  key(e) {
    const pg = Math.max(1, Math.floor((this.body.clientHeight - 36) / this.rowH) - 1);
    const map = { ArrowDown: 1, ArrowUp: -1, PageDown: pg, PageUp: -pg, j: 1, k: -1 };
    if (e.key in map) {
      e.preventDefault();
      this.select((this.sel < 0 ? -1 : this.sel) + map[e.key]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.select(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      this.select(this.view.length - 1);
    } else if (e.key === 'Enter' && this.sel >= 0) {
      const r = this.view[this.sel];
      if (r && !r.__child) this.o.onOpen?.(r, this.rowEls.get(this.o.rowKey(r)));
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && this.o.expand && this.sel >= 0) {
      const r = this.view[this.sel];
      if (!r || r.__child) return;
      const k = this.o.rowKey(r);
      if (e.key === 'ArrowRight') this.expanded.add(k);
      else this.expanded.delete(k);
      this.apply();
    }
  }

  focus() {
    this.body.focus({ preventScroll: true });
  }

  /** Re-render visible cells (live values) without refiltering. */
  refresh() {
    this.render(false);
  }

  addFilter(key, value) {
    if (this.filters.some((f) => f.key === key && String(f.value) === String(value))) return;
    this.filters = this.filters.filter((f) => f.key !== key);
    this.filters.push({ key, value });
    this.renderChips();
    this.apply();
  }

  renderChips() {
    this.chips.innerHTML = '';
    for (const f of this.filters) {
      const def = this.o.filters.find((x) => x.key === f.key);
      const x = h('button', { type: 'button', 'aria-label': 'Remove filter', html: icon('x') });
      x.addEventListener('click', () => {
        this.filters = this.filters.filter((g) => g !== f);
        this.renderChips();
        this.apply();
      });
      this.chips.appendChild(h('span.chip', h('span', `${def.label}: `), h('b', def.format ? def.format(f.value) : String(f.value)), x));
    }
  }

  openFilterMenu(anchor) {
    const o = this.o;
    const items = [{ header: 'Filter by' }];
    for (const def of o.filters || []) {
      items.push({ label: def.label, end: icon('chevron-right'), keep: true, onSelect: () => this.openValueMenu(anchor, def) });
    }
    openMenu(anchor, items, { align: 'start' });
  }

  openValueMenu(anchor, def) {
    const counts = new Map();
    for (const r of this.rows) {
      const v = def.value(r);
      if (v == null || v === '') continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const vals = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 24);
    closePopover();
    requestAnimationFrame(() => openMenu(anchor, [
      { header: def.label },
      ...(vals.length ? vals.map(([v, n]) => ({ label: def.format ? def.format(v) : String(v), end: String(n), onSelect: () => this.addFilter(def.key, v) })) : [{ label: 'No values', onSelect: () => {} }]),
    ], { align: 'start' }));
  }

  export(kind) {
    const vis = this.cols.filter((c) => c.visible && c.label);
    const rows = this.view.filter((r) => !r.__child);
    const name = `telluric-${this.o.exportName || 'export'}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
    if (kind === 'json') {
      download(`${name}.json`, JSON.stringify(rows.map((r) => this.o.raw ? this.o.raw(r) : r), (k, v) => (k[0] === '_' ? undefined : v), 2), 'application/json');
      return;
    }
    const q = (s) => {
      s = String(s ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [vis.map((c) => q(c.label)).join(',')];
    for (const r of rows) lines.push(vis.map((c) => q(c.text ? c.text(r) : r[c.key])).join(','));
    download(`${name}.csv`, lines.join('\n'), 'text/csv');
  }
}

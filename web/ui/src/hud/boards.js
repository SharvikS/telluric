import { rate, count, esc, middleTruncate } from '../util/format.js';

const ROW_H = 36;

/**
 * A ranked list whose rows are keyed DOM nodes moved with transforms, so
 * rank changes animate instead of flickering.
 */
class Board {
  constructor(container, countEl, { onClick }) {
    this.el = container;
    this.countEl = countEl;
    this.rows = new Map();
    this.onClick = onClick;
    this.selected = null;
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'empty';
    this.emptyEl.textContent = 'awaiting traffic';
    this.el.appendChild(this.emptyEl);
  }

  render(items, total) {
    const cap = Math.max(1, Math.floor(this.el.clientHeight / ROW_H));
    const shown = items.slice(0, cap);
    const max = shown.reduce((m, x) => Math.max(m, x.rate), 1);
    const keep = new Set();
    shown.forEach((it, i) => {
      keep.add(it.key);
      let row = this.rows.get(it.key);
      if (!row) {
        row = document.createElement('div');
        row.className = 'row';
        row.style.opacity = '0';
        row.style.transform = `translateY(${(i + 1) * ROW_H}px)`;
        row.innerHTML = '<div class="l1"><span class="name"></span><span class="sub"></span><span class="val"></span></div><div class="bar"><i class="in"></i><i class="out"></i></div>';
        row.addEventListener('click', () => this.onClick(row.dataset.key));
        this.el.appendChild(row);
        this.rows.set(it.key, row);
        requestAnimationFrame(() => { row.style.opacity = '1'; });
      }
      row.dataset.key = it.key;
      row.style.transform = `translateY(${i * ROW_H}px)`;
      row.style.opacity = '1';
      row.classList.toggle('sel', this.selected === String(it.key));
      const [nameEl, subEl, valEl] = row.firstChild.children;
      if (nameEl.innerHTML !== it.nameHtml) nameEl.innerHTML = it.nameHtml;
      subEl.textContent = it.sub;
      valEl.textContent = rate(it.rate);
      const scale = (v) => (v > 0 ? (Math.log1p(v) / Math.log1p(max)) * 100 : 0);
      const tot = it.rateIn + it.rateOut || 1;
      const w = scale(it.rate);
      const [inBar, outBar] = row.lastChild.children;
      inBar.style.width = `${w * (it.rateIn / tot)}%`;
      outBar.style.left = `${w * (it.rateIn / tot)}%`;
      outBar.style.width = `${w * (it.rateOut / tot)}%`;
    });
    for (const [key, row] of this.rows) {
      if (keep.has(key)) continue;
      row.style.opacity = '0';
      this.rows.delete(key);
      setTimeout(() => row.remove(), 450);
    }
    this.emptyEl.style.display = shown.length ? 'none' : '';
    if (this.countEl) this.countEl.textContent = total ? `${total}` : '';
  }
}

export class ProcBoard extends Board {
  update(store) {
    const items = [];
    for (const p of store.procs.values()) {
      const r = (p.rateIn || 0) + (p.rateOut || 0);
      if (!p.flows && r < 1) continue;
      items.push({
        key: String(p.id),
        nameHtml: esc(p.name),
        sub: `pid ${p.pid} · ${p.flows || 0} flow${p.flows === 1 ? '' : 's'}${p.container ? ' · ' + p.container : ''}`,
        rate: r, rateIn: p.rateIn || 0, rateOut: p.rateOut || 0, bytes: (p.bytesIn || 0) + (p.bytesOut || 0),
      });
    }
    // Unattributed traffic is real traffic too: show it as a pseudo-process.
    let ui = 0, uo = 0, un = 0;
    for (const f of store.flows.values()) {
      if (f.proc) continue;
      ui += f.rateIn || 0; uo += f.rateOut || 0; un++;
    }
    if (un) items.push({ key: '0', nameHtml: '<span style="color:var(--muted)">unattributed</span>', sub: `${un} flow${un === 1 ? '' : 's'}`, rate: ui + uo, rateIn: ui, rateOut: uo, bytes: 0 });
    items.sort((a, b) => b.rate - a.rate || b.bytes - a.bytes);
    this.render(items, items.length);
  }
}

export class CountryBoard extends Board {
  update(store) {
    const rows = store.countries();
    const items = rows.map((c) => ({
      key: c.cc,
      nameHtml: `<span class="cc">${esc(c.cc)}</span> ${esc(middleTruncate(c.country, 18))}`,
      sub: `${count(c.eps)} host${c.eps === 1 ? '' : 's'}`,
      rate: c.rate, rateIn: c.rateIn, rateOut: c.rateOut, bytes: c.bytes,
    }));
    this.render(items, items.length);
  }
}

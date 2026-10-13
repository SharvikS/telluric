import { esc, rate, middleTruncate } from '../util/format.js';
import { SEVERITY, ALERT_KINDS } from '../config.js';

/**
 * Command palette (Ctrl+K or "/"): fuzzy-ish search over endpoints,
 * processes, countries and alerts. Every whitespace-separated token must
 * match; prefix matches score higher than substring matches.
 */
export class Search {
  constructor(store, geo, { onPick }) {
    this.store = store;
    this.geo = geo;
    this.onPick = onPick;
    this.el = document.getElementById('search');
    this.back = document.getElementById('modal-back');
    this.input = document.getElementById('search-input');
    this.list = document.getElementById('search-results');
    this.results = [];
    this.sel = 0;
    this.input.addEventListener('input', () => this.run());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { this.move(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.move(-1); e.preventDefault(); }
      else if (e.key === 'Enter') { this.choose(this.sel); e.preventDefault(); }
      else if (e.key === 'Escape') { this.close(); e.preventDefault(); }
      e.stopPropagation();
    });
    this.list.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (li) this.choose(Number(li.dataset.i));
    });
    this.back.addEventListener('click', () => this.close());
  }

  get isOpen() { return this.el.classList.contains('open'); }

  open() {
    this.el.classList.add('open');
    this.back.classList.add('open');
    this.input.value = '';
    this.run();
    setTimeout(() => this.input.focus(), 0);
  }

  close() {
    this.el.classList.remove('open');
    this.back.classList.remove('open');
    this.input.blur();
  }

  index() {
    const s = this.store;
    const out = [];
    for (const ep of s.endpoints.values()) {
      const r = (ep.rateIn || 0) + (ep.rateOut || 0);
      out.push({ type: 'host', id: ep.id, name: ep.name || ep.ip, sub: `${ep.ip}${ep.city ? ' · ' + ep.city : ''}${ep.cc ? ', ' + ep.cc : ''}${ep.org ? ' · ' + ep.org : ''}`,
        hay: [ep.name, ...(ep.names || []), ep.ip, ep.org, ep.city, ep.country, ep.cc, ep.svc, `as${ep.asn}`].filter(Boolean).join(' ').toLowerCase(), right: rate(r), w: r });
    }
    for (const p of s.procs.values()) {
      const r = (p.rateIn || 0) + (p.rateOut || 0);
      out.push({ type: 'proc', id: p.id, name: p.name, sub: `pid ${p.pid} · ${middleTruncate(p.cmd || p.exe || '', 48)}`,
        hay: [p.name, String(p.pid), p.cmd, p.exe, p.unit, p.user].filter(Boolean).join(' ').toLowerCase(), right: rate(r), w: r });
    }
    for (const c of s.countries()) {
      out.push({ type: 'country', id: c.cc, name: c.country, sub: `${c.cc} · ${c.eps} hosts`, hay: `${c.country} ${c.cc}`.toLowerCase(), right: rate(c.rate), w: c.rate });
    }
    for (const id of s.alertOrder.slice(0, 80)) {
      const a = s.alerts.get(id);
      if (!a) continue;
      const sev = SEVERITY[a.sev] || SEVERITY.medium;
      out.push({ type: 'alert', id: a.id, name: a.title, sub: `${sev.label} · ${ALERT_KINDS[a.kind] || a.kind} · ${a.detail || ''}`,
        hay: `${a.title} ${a.detail} ${a.kind} ${a.sev}`.toLowerCase(), right: '', w: 1e9 + a.ts, color: sev.color });
    }
    return out;
  }

  run() {
    const q = this.input.value.trim().toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    const items = this.index();
    let res;
    if (!tokens.length) {
      res = items.filter((x) => x.type !== 'alert').sort((a, b) => b.w - a.w).slice(0, 12);
    } else {
      res = [];
      for (const it of items) {
        let score = 0;
        let ok = true;
        for (const t of tokens) {
          const i = it.hay.indexOf(t);
          if (i < 0) { ok = false; break; }
          score += i === 0 ? 3 : it.hay[i - 1] === ' ' || it.hay[i - 1] === '.' ? 2 : 1;
        }
        if (ok) res.push([score + Math.log10(1 + Math.min(it.w, 1e9)) * 0.1, it]);
      }
      res = res.sort((a, b) => b[0] - a[0]).slice(0, 30).map((x) => x[1]);
    }
    this.results = res;
    this.sel = 0;
    this.list.innerHTML = res.length
      ? res.map((r, i) => `<li data-i="${i}" class="${i === 0 ? 'on' : ''}"><span class="t" ${r.color ? `style="color:${r.color}"` : ''}>${r.type.toUpperCase()}</span><span><div class="n">${esc(r.name)}</div><div class="s">${esc(middleTruncate(r.sub, 80))}</div></span><span class="s">${esc(r.right)}</span></li>`).join('')
      : '<li><span></span><span class="s">no matches</span><span></span></li>';
  }

  move(d) {
    if (!this.results.length) return;
    this.sel = (this.sel + d + this.results.length) % this.results.length;
    [...this.list.children].forEach((li, i) => li.classList.toggle('on', i === this.sel));
    this.list.children[this.sel]?.scrollIntoView({ block: 'nearest' });
  }

  choose(i) {
    const r = this.results[i];
    if (!r) return;
    this.close();
    this.onPick(r);
  }
}

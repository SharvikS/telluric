import { h } from '../dom.js';
import { icon, ILLUSTRATIONS } from '../icons.js';
import { emptyState } from '../components/controls.js';
import { hopTable } from '../entity.js';
import { View } from './overview.js';
import { esc, agoShort, time } from '../../util/format.js';
import { vec3ToLatLon, clamp } from '../../util/math.js';

/** Traceroutes: list of reconstructed paths, the route on a globe, hop table. */
export class TracesView extends View {
  constructor(app) {
    super(app, 'traces', 'Traceroutes');
    this.sel = 0;
  }

  mount() {
    this.listEl = h('div.tr-list');
    this.slotEl = h('div.globe-slot');
    this.globeTitle = h('h3', 'Route');
    this.globeSub = h('span.sub');
    this.hops = h('div.card-body', { style: { paddingTop: '4px' } });
    this.empty = emptyState(ILLUSTRATIONS.route, 'No traceroutes yet',
      'Run <code>mtr example.com</code> or <code>traceroute example.com</code> on this machine. Telluric matches each probe with the router that answers and draws the path here.');
    this.main = h('div.tr-main',
      h('div.card.globe-card.tr-globe', this.slotEl, h('div.globe-overlay', h('div.card-head', this.globeTitle, this.globeSub))),
      h('div.card.tr-hops', h('div.card-head', h('h3', 'Hops'), h('span.sub', 'best round-trip time per hop')), this.hops));
    this.layout = h('div.tr-layout', h('div.col', { style: { minHeight: '0', gap: '10px' } }, h('div.caps', 'Recent traces'), this.listEl), this.main);
    this.el.appendChild(h('div.page.fill',
      h('div.view-head', h('div', h('h1', 'Traceroutes'), h('p', 'Paths reconstructed from mtr / traceroute probes on the wire — every router along the way, located on the globe.'))),
      this.layout, this.empty));
    this.listEl.addEventListener('click', (e) => {
      const it = e.target.closest('[data-trace]');
      if (it) this.select(Number(it.dataset.trace), true);
    });
  }

  slot() {
    return this.slotEl;
  }

  show(params) {
    if (params.trace) this.select(Number(params.trace), true);
    this.refresh();
  }

  select(id, fly) {
    this.sel = id;
    this.refresh();
    if (fly) this.frameTrace();
  }

  frameTrace() {
    const g = this.app.world.traces.frameOf(this.sel);
    if (!g) return;
    const [c, span] = g;
    const [lat, lon] = vec3ToLatLon(c);
    this.app.camera.flyTo(lat - 4, lon, clamp(1.9 + span * 2.2, 2.0, 5.4), 1.6);
  }

  refresh() {
    const s = this.app.store;
    const traces = [...s.traces.values()].sort((a, b) => b.ts - a.ts);
    const has = traces.length > 0;
    this.layout.classList.toggle('hidden', !has);
    this.empty.classList.toggle('hidden', has);
    if (!has) return;
    if (!traces.some((t) => t.id === this.sel)) {
      this.sel = traces[0].id;
      setTimeout(() => this.frameTrace(), 50);
    }
    const html = traces.map((t) => {
      const last = t.hops[t.hops.length - 1];
      return `<div class="card hoverable tr-item${t.id === this.sel ? ' on' : ''}" data-trace="${t.id}">
        <div class="row"><span class="tr-dst ellipsis">${esc(t.name || t.dst)}</span><span class="spacer"></span>${t.done ? '<span class="badge success">Complete</span>' : '<span class="badge warning">Probing</span>'}</div>
        <div class="tr-meta">${esc(t.dst)} · ${last ? last.n : t.hops.length} hops${last && last.rtt != null ? ` · ${Math.round(last.rtt)} ms` : ''} · ${agoShort(t.ts, s.now())} ago</div></div>`;
    }).join('');
    if (this.listEl._h !== html) { this.listEl._h = html; this.listEl.innerHTML = html; }
    const t = s.traces.get(this.sel);
    if (!t) return;
    // Spotlight the route: other traffic dims, host labels step aside.
    const f = this.app.world.focus;
    const dst = s.byIp.get(t.dst);
    f.trace = t.id;
    f.active = true;
    f.eps = new Set(dst ? [dst.id] : []);
    this.globeTitle.textContent = t.name || t.dst;
    const last = t.hops[t.hops.length - 1];
    this.globeSub.textContent = `${last ? last.n : t.hops.length} hops · started ${time(t.ts)}`;
    const hh = hopTable(t);
    if (this.hops._h !== hh) { this.hops._h = hh; this.hops.innerHTML = hh; }
  }
}

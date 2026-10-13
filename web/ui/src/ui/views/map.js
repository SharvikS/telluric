import { h } from '../dom.js';
import { icon } from '../icons.js';
import { toggle } from '../components/controls.js';
import { View } from './overview.js';
import { rateParts, integer } from '../../util/format.js';
import { APP_ROWS } from '../../config.js';

const LAYERS = [
  ['arcs', 'Connections'], ['packets', 'Packets'], ['labels', 'Labels'],
  ['heat', 'Country heat'], ['terminator', 'Day & night'], ['traces', 'Traceroutes'],
];

/** Full-bleed globe with floating glass controls. */
export class MapView extends View {
  constructor(app) {
    super(app, 'map', 'Live map', { flush: true });
    this.refreshEvery = 500;
  }

  mount() {
    const app = this.app;
    this.el.classList.add('map-view');
    this.slotEl = h('div.globe-slot');
    this.toggles = new Map();
    const layers = h('div.glass.map-layers', h('div.caps', { style: { marginBottom: '6px' } }, 'Layers'),
      LAYERS.map(([k, label]) => {
        const t = toggle(app.prefs.get(`globe.${k}`), (v) => app.prefs.set(`globe.${k}`, v), label);
        this.toggles.set(k, t);
        return h('div.lyr', h('span', label), t.el);
      }));
    app.prefs.on('change', (key) => {
      const k = key.split('.')[1];
      if (key.startsWith('globe.') && this.toggles.has(k)) this.toggles.get(k).set(app.prefs.get(key));
      if (key === 'globe.autoRotate') this.rotBtn.classList.toggle('on', app.prefs.get(key));
    });

    const stat = (label) => {
      const v = h('div.ms-v');
      return [h('div', h('div.ms-l', label), v), v];
    };
    const [inEl, inV] = stat('Inbound');
    const [outEl, outV] = stat('Outbound');
    const [cEl, cV] = stat('Connections');
    const [hEl, hV] = stat('Hosts');
    const rf = (v) => {
      const [n, u] = rateParts(v);
      return `${n}<small>${u}</small>`;
    };
    this.tw = {
      rx: app.tweens.number(inV, rf), tx: app.tweens.number(outV, rf),
      flows: app.tweens.number(cV, (v) => integer(v)), eps: app.tweens.number(hV, (v) => integer(v)),
    };
    const stats = h('div.glass.map-stats', inEl, outEl, cEl, hEl);

    const legend = h('div.glass.map-legend', h('div.caps', { style: { marginBottom: '8px' } }, 'Legend'),
      h('div.legend', APP_ROWS.slice(0, 6).map(([k, l]) => h('div.legend-row', h('i', { style: { background: `var(--viz-${k})` } }), l)),
        h('div.legend-row', h('i', { style: { background: 'var(--viz-threat)' } }), 'Threat'),
        h('div.legend-row', h('i', { style: { background: 'var(--warning)', borderRadius: '50%' } }), 'Traceroute')),
      h('div.subtle', { style: { fontSize: '11px', marginTop: '8px', maxWidth: '240px' } }, 'Local-network hosts orbit just above home; hosts that can’t be located orbit higher.'));

    const btn = (ic, tip, kbd, fn) => {
      const b = h('button.icon-btn', { type: 'button', 'data-tip': tip, 'data-kbd': kbd, html: icon(ic) });
      b.addEventListener('click', fn);
      return b;
    };
    this.rotBtn = btn('rotate', 'Auto-rotate', 'A', () => app.prefs.set('globe.autoRotate', !app.prefs.get('globe.autoRotate')));
    this.rotBtn.classList.toggle('on', app.prefs.get('globe.autoRotate'));
    const zoom = h('div.glass.map-zoom',
      btn('plus', 'Zoom in', '+', () => app.camera.zoomBy(0.8)),
      btn('minus', 'Zoom out', '−', () => app.camera.zoomBy(1.25)),
      btn('target', 'Back to home', 'R', () => this.home()),
      this.rotBtn);
    this.panels = [layers, stats, legend, zoom];
    this.el.append(this.slotEl, ...this.panels, h('div.map-hint', 'Drag to rotate · scroll to zoom · click a host for details'));
  }

  home() {
    const hm = this.app.store.home;
    if (hm) this.app.camera.flyTo(hm.lat - 10, hm.lon + 14, 2.6, 1.4);
  }

  slot() {
    return this.slotEl;
  }

  obstacles() {
    if (!this._obsAt || performance.now() - this._obsAt > 500) {
      this._obsAt = performance.now();
      this._obs = this.panels.map((p) => {
        const r = p.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      }).filter((r) => r[2] > 0);
    }
    return this._obs;
  }

  key(e) {
    const cam = this.app.camera;
    if (e.key === 'a' || e.key === 'A') this.app.prefs.set('globe.autoRotate', !this.app.prefs.get('globe.autoRotate'));
    else if (e.key === 'r' || e.key === 'R') this.home();
    else if (e.key === '+' || e.key === '=') cam.zoomBy(0.8);
    else if (e.key === '-' || e.key === '_') cam.zoomBy(1.25);
  }

  refresh() {
    const st = this.app.store.stats;
    if (!st) return;
    this.tw.rx.to(st.rx);
    this.tw.tx.to(st.tx);
    this.tw.flows.to(st.flows);
    this.tw.eps.to(st.eps);
  }
}

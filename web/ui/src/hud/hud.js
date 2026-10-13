import { TopBar } from './topbar.js';
import { ProcBoard, CountryBoard } from './boards.js';
import { Feed } from './feed.js';
import { AlertList, Banner } from './alerts.js';
import { Waterfall, donut, fitCanvas } from './charts.js';
import { Minimap } from './minimap.js';
import { Labels } from './labels.js';
import { Detail } from './detail.js';
import { Search } from './search.js';
import { Help } from './help.js';
import { esc, rate, middleTruncate } from '../util/format.js';
import { appColor, cssColor } from '../config.js';

const $ = (id) => document.getElementById(id);

/** Owns every DOM panel and updates each at its own cadence. */
export class Hud {
  constructor({ store, conn, world, camera, geo, actions }) {
    this.store = store;
    this.world = world;
    this.camera = camera;
    this.actions = actions;
    this.root = $('hud');
    this.topbar = new TopBar(store);
    this.procs = new ProcBoard($('procs'), $('c-procs'), { onClick: (k) => actions.focusProc(Number(k)) });
    this.countries = new CountryBoard($('countries'), $('c-countries'), { onClick: (cc) => actions.focusCountry(cc) });
    this.feed = new Feed($('feed'), $('c-feed'), store);
    this.alerts = new AlertList($('alerts'), $('c-alerts'), store, { onSelect: (a) => actions.selectAlert(a) });
    this.banner = new Banner(store, { onShow: (a) => actions.alertShown(a), onClick: (a) => actions.selectAlert(a) });
    this.waterfall = new Waterfall($('waterfall'));
    this.minimap = new Minimap($('minimap'), geo, store, world, camera, { onPick: (lat, lon) => camera.flyTo(lat, lon, camera.targetDist, 1.4) });
    this.labels = new Labels($('labels'), store, world);
    this.detail = new Detail(store, { onClose: () => actions.clearSelection(), onFocusProc: (id) => actions.focusProc(id) });
    this.search = new Search(store, geo, { onPick: (r) => actions.pick(r) });
    this.help = new Help();
    this.tooltip = $('tooltip');
    this.toastEl = $('toast');
    this.chip = $('filterchip');
    this.chipText = $('filter-text');
    $('filter-clear').addEventListener('click', () => actions.clearFocus());
    $('btn-help').addEventListener('click', () => this.help.toggle());
    this.soundBtn = $('btn-sound');
    this.soundBtn.addEventListener('click', () => actions.toggleSound());
    this.t = { top: 0, boards: 0, proto: 0, layout: 0 };

    conn.on('status', ({ state, detail }) => {
      this.topbar.setMode(state, detail);
      if (state === 'demo' && detail && detail.startsWith('no engine')) {
        this.toast('No engine found — running the built-in demo. Start <code>telluric</code> and this page switches to live traffic.', 9000);
        this.feed.system('no engine found · demo traffic is simulated');
      } else if (state === 'demo') {
        this.feed.system(detail && detail.startsWith('telluric') ? `linked to ${esc(detail)} · synthetic world` : 'demo mode · simulated traffic, no capture');
      } else if (state === 'live') {
        this.feed.system(`linked to ${esc(detail || 'engine')}`);
      } else if (state === 'reconnecting') {
        this.feed.system('engine link lost · retrying');
      }
    });
    store.on('hello', (h) => {
      $('credits').innerHTML = (h.credits || []).map((c) => esc(c).replace(/\((https?:[^)]+)\)/, '(<a href="$1" target="_blank" rel="noopener">$1</a>)')).join(' · ')
        + ' · <a href="https://github.com/SharvikS/telluric" target="_blank" rel="noopener">github.com/SharvikS/telluric</a>';
    });
  }

  toast(html, ms = 5000) {
    this.toastEl.innerHTML = html;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  setFilter(text) {
    this.chip.classList.toggle('show', !!text);
    this.chipText.textContent = text || '';
  }

  setSound(on) {
    this.soundBtn.classList.toggle('on', on);
  }

  /** Screen rectangle of the free area between the panels (CSS px). */
  globeRect() {
    const r = $('globe-area').getBoundingClientRect();
    if (r.width < 50 || r.height < 50 || this.root.classList.contains('hidden')) {
      return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    }
    return r;
  }

  showTooltip(x, y, html) {
    const t = this.tooltip;
    if (!html) {
      t.classList.remove('show');
      return;
    }
    t.innerHTML = html;
    t.classList.add('show');
    const w = t.offsetWidth, h = t.offsetHeight;
    const tx = x + 16 + w > window.innerWidth ? x - w - 16 : x + 16;
    const ty = y + 14 + h > window.innerHeight ? y - h - 14 : y + 14;
    t.style.transform = `translate(${tx}px, ${ty}px)`;
  }

  endpointTooltip(ep) {
    const flows = this.store.flowsOf(ep.id);
    const procs = [...new Set(flows.map((f) => f.proc && this.store.procs.get(f.proc)?.name).filter(Boolean))];
    const rgb = appColor(ep._app);
    const where = ep.scope === 'public' ? [ep.city, ep.cc].filter(Boolean).join(', ') || 'unlocated' : ep.scope.toUpperCase();
    return `<div class="h">${esc(middleTruncate(ep.name || ep.ip, 34))}</div>
      <div class="m">${esc(ep.ip)} · ${esc(where)}</div>
      ${ep.org ? `<div class="m">${ep.asn ? 'AS' + ep.asn + ' · ' : ''}${esc(middleTruncate(ep.org, 36))}</div>` : ''}
      <div class="r"><span style="color:${cssColor(rgb)}">${esc(String(ep._app).toUpperCase())}</span><span>↓ ${rate(ep.rateIn)} ↑ ${rate(ep.rateOut)}</span></div>
      ${procs.length ? `<div class="m" style="margin-top:3px">${esc(procs.slice(0, 3).join(', '))}</div>` : ''}
      ${ep.threat ? `<div style="color:var(--red);margin-top:3px;font-weight:700">threat score ${ep.threat}</div>` : ''}`;
  }

  update(frame, now, dt) {
    this.feed.update();
    this.labels.update(frame, dt);
    if (now - this.t.top > 250) {
      this.t.top = now;
      this.topbar.update(now);
    }
    if (now - this.t.boards > 600) {
      this.t.boards = now;
      this.procs.update(this.store);
      this.countries.update(this.store);
      this.alerts.update(now);
    }
    if (now - this.t.proto > 1000) {
      this.t.proto = now;
      const cv = $('proto');
      if (cv.offsetParent) {
        fitCanvas(cv);
        donut(cv, this.store.appMix(), $('proto-legend'));
      }
    }
    if ($('waterfall').offsetParent) this.waterfall.push(this.store.appMix(), now);
    if ($('minimap').offsetParent) this.minimap.update(now);
    this.detail.update(now);
  }
}

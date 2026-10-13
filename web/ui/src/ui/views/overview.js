import { h } from '../dom.js';
import { icon } from '../icons.js';
import { segmented } from '../components/controls.js';
import { RankList } from '../components/rank.js';
import { Activity } from '../components/activity.js';
import { AreaChart } from '../charts/area.js';
import { Donut } from '../charts/donut.js';
import { spark } from '../charts/spark.js';
import { rateParts, rate, rateShort, bytes, integer, pct, esc, middleTruncate, agoShort } from '../../util/format.js';
import { APP_ROWS, THREAT_LEVELS, SEVERITY, hex, family } from '../../config.js';
import { RANGES } from '../../app/history.js';

/** Base class for routed views. */
export class View {
  constructor(app, name, title, { flush = false } = {}) {
    this.app = app;
    this.name = name;
    this.title = title;
    this.el = h(`section.view${flush ? '.flush' : ''}`, { hidden: true, 'aria-label': title });
    this.mounted = false;
    this.refreshEvery = 1000;
    this.lastRefresh = 0;
  }

  ensure() {
    if (!this.mounted) {
      this.mount();
      this.mounted = true;
    }
  }

  mount() {}
  show() {}
  hide() {}
  frame() {}
  refresh() {}
  slot() { return null; }
  obstacles() { return []; }
}

const FAMILY_SERIES = APP_ROWS.map(([key, label]) => ({
  key: (s) => {
    let v = 0;
    for (const [app, r] of Object.entries(s.apps || {})) if (family(app) === key) v += r;
    return v;
  },
  label, color: `--viz-${key}`, stack: true, fam: key,
}));

export class OverviewView extends View {
  constructor(app) {
    super(app, 'overview', 'Overview');
    this.refreshEvery = 500;
    this.mode = 'direction';
  }

  mount() {
    const app = this.app;
    const kpis = h('div.ov-kpis');
    this.kpis = [
      this.kpi(kpis, { label: 'Inbound', ic: 'arrow-down-left', key: 'rx', color: 'var(--viz-in)', rate: true }),
      this.kpi(kpis, { label: 'Outbound', ic: 'arrow-up-right', key: 'tx', color: 'var(--viz-out)', rate: true }),
      this.kpi(kpis, { label: 'Connections', ic: 'connections', key: 'flows', color: 'var(--accent)' }),
      this.kpi(kpis, { label: 'Hosts', ic: 'hosts', key: 'eps', color: 'var(--accent)' }),
      this.kpi(kpis, { label: 'Countries', ic: 'flag', key: 'countries', color: 'var(--accent)' }),
    ];
    this.threatTile = this.threatKpi(kpis);

    // Globe card.
    this.slotEl = h('div.globe-slot');
    this.globeSub = h('span.sub');
    const openMap = h('a.card-link', { href: '#/map' }, 'Open live map', h('span', { html: icon('arrow-right') }));
    this.legend = h('div.globe-legend');
    const globe = h('div.card.ov-globe.globe-card', this.slotEl,
      h('div.globe-overlay', h('div.card-head', h('h3', 'Live map'), this.globeSub, h('div.right', openMap)), this.legend));

    // Protocol mix.
    const donutEl = h('div.donut');
    this.donut = new Donut(donutEl, { thickness: 15, format: (v) => bytes(v), centerLabel: 'transferred' });
    this.mixLegend = h('div.legend');
    this.mixRange = h('span.sub');
    const mix = h('div.card', h('div.card-head', h('h3', 'Protocol mix'), this.mixRange), h('div.card-body', h('div.mix', donutEl, this.mixLegend)));

    // Security summary.
    this.secShield = h('div.shield', { html: icon('shield') });
    this.secLevel = h('b');
    this.secBlurb = h('span');
    this.sevCounts = h('div.sev-counts');
    this.secRecent = h('div');
    const sec = h('div.card', h('div.card-head', h('h3', 'Security'), h('div.right', h('a.card-link', { href: '#/security' }, 'View all', h('span', { html: icon('arrow-right') })))),
      h('div.card-body', h('div.sec-level', this.secShield, h('div', this.secLevel, this.secBlurb)), this.sevCounts, this.secRecent));
    this.secRecent.addEventListener('click', (e) => {
      const r = e.target.closest('[data-alert]');
      if (r) app.openEntity({ type: 'alert', id: Number(r.dataset.alert) });
    });

    // Throughput.
    const chartEl = h('div', { style: { position: 'absolute', inset: '0 16px 12px 16px', width: 'auto', height: 'auto' } });
    this.chart = new AreaChart(chartEl, {
      series: this.dirSeries(), format: (v) => rate(v), axisFormat: (v) => rateShort(v),
    });
    this.chartLegend = h('div.chart-legend');
    const modeSeg = segmented([{ value: 'direction', label: 'Direction' }, { value: 'protocol', label: 'Protocol' }], this.mode, (v) => {
      this.mode = v;
      this.chart.setSeries(v === 'direction' ? this.dirSeries() : FAMILY_SERIES);
      this.renderChartLegend();
    });
    this.thruRange = h('span.sub');
    const thru = h('div.card.ov-thru', h('div.card-head', h('h3', 'Throughput'), this.thruRange, h('div.right', this.chartLegend, modeSeg.el)),
      h('div.card-body.flush', chartEl));
    this.renderChartLegend();

    // Leaderboards.
    const open = (type) => (key, el) => {
      const r = el.getBoundingClientRect();
      app.openEntity({ type, id: Number(key) }, { from: { x: r.left + 24, y: r.top + r.height / 2, color: 'var(--accent)' } });
    };
    this.hosts = new RankList({ max: 6, onClick: open('ep') });
    this.procs = new RankList({ max: 7, onClick: open('proc') });
    this.countries = new RankList({ max: 7, onClick: (cc) => app.navigate('hosts', { country: cc }) });
    const card = (cls, title, sub, body, linkTo) => h(`div.card.${cls}`,
      h('div.card-head', h('h3', title), sub, linkTo ? h('div.right', h('a.card-link', { href: `#/${linkTo}` }, 'View all', h('span', { html: icon('arrow-right') }))) : null),
      h('div.card-body.flush', { style: { overflowY: 'hidden' } }, body));
    this.activity = new Activity(app.store, {
      max: 7,
      onOpen: (ev) => {
        if (ev.kind === 'alert') app.openEntity({ type: 'alert', id: ev.alert });
        else if (ev.kind === 'conn') app.openEntity({ type: 'flow', id: ev.flow });
        else if (ev.kind === 'trace') app.navigate('traces', { trace: ev.trace });
        else if (ev.dns) app.navigate('dns', { q: ev.dns.q });
      },
    });
    app.activity = this.activity;

    this.el.appendChild(h('div.ov.stagger',
      kpis, globe, h('div.ov-side', mix, sec), thru,
      card('ov-hosts', 'Top hosts', h('span.sub', 'by throughput'), this.hosts.el, 'hosts'),
      card('ov-procs', 'Top processes', h('span.sub', 'by throughput'), this.procs.el, 'processes'),
      card('ov-countries', 'Top countries', h('span.sub', 'by throughput'), this.countries.el, 'hosts'),
      card('ov-activity', 'Activity', h('span.sub', 'live'), this.activity.el, null)));
  }

  dirSeries() {
    return [
      { key: 'rx', label: 'Inbound', color: '--viz-in' },
      { key: 'tx', label: 'Outbound', color: '--viz-out' },
    ];
  }

  renderChartLegend() {
    const ser = this.mode === 'direction' ? this.dirSeries() : [];
    this.chartLegend.innerHTML = ser.map((s) => `<span><i style="background:var(${s.color})"></i>${s.label}</span>`).join('');
  }

  kpi(parent, { label, ic, key, color, rate: isRate }) {
    const value = h('div.kpi-value');
    const delta = h('span.delta');
    const note = h('span.delta-note');
    const sp = h('div.kpi-spark', { style: { color } });
    const el = h('div.card.kpi', h('div.kpi-label', h('span', { html: icon(ic) }), label), value, h('div.kpi-foot', delta, note), sp);
    parent.appendChild(el);
    const fmt = isRate
      ? (v) => {
        const [n, u] = rateParts(v);
        return `${n}<small>${u}</small>`;
      }
      : (v) => integer(v);
    const tw = this.app.tweens.number(value, fmt, { rate: 6 });
    return { key, tw, delta, note, sp, isRate };
  }

  threatKpi(parent) {
    const value = h('div.kpi-value', { style: { fontSize: '22px', marginTop: '8px' } });
    const meter = h('div.threat-meter', [0, 1, 2, 3, 4].map(() => h('i')));
    const foot = h('span.delta-note');
    const el = h('div.card.kpi', { style: { cursor: 'pointer' } }, h('div.kpi-label', h('span', { html: icon('shield') }), 'Threat level'), value, meter, h('div.kpi-foot', foot));
    el.addEventListener('click', () => this.app.navigate('security'));
    parent.appendChild(el);
    return { value, meter, foot };
  }

  slot() {
    return this.slotEl;
  }

  frame(now, dt) {
    const end = this.app.paused ? this.app.pausedAt : this.app.store.now();
    this.chart.draw(end, dt);
    this.donut.frame(dt);
    this.activity.flush();
  }

  refresh(now) {
    const app = this.app;
    const s = app.store;
    const st = s.stats;
    const range = app.prefs.get('range');
    const label = RANGES[range].label;
    const series = app.history.series(range);
    this.chart.setData(series);
    this.thruRange.textContent = `last ${label}`;
    this.mixRange.textContent = `last ${label}`;
    if (st) {
      const samples = series.samples;
      const stride = Math.max(1, Math.floor(samples.length / 90));
      for (const k of this.kpis) {
        k.tw.to(st[k.key] || 0);
        const vals = [];
        for (let i = 0; i < samples.length; i += stride) vals.push(samples[i][k.key] || 0);
        if (vals.length > 1) spark(k.sp, vals, 'currentColor', { floor: k.isRate ? 1024 : 1 });
        const d = app.history.delta(range, k.key);
        if (d == null || !Number.isFinite(d)) {
          k.delta.className = 'delta flat';
          k.delta.innerHTML = '—';
          k.note.textContent = '';
        } else {
          const up = d > 0.005, down = d < -0.005;
          k.delta.className = `delta neutral ${up ? 'up' : down ? 'down' : 'flat'}`;
          k.delta.innerHTML = `${up ? icon('arrow-up') : down ? icon('arrow-down') : ''}${pct(Math.abs(d), Math.abs(d) < 0.1 ? 1 : 0)}`;
          k.note.textContent = `vs ${range} avg`;
        }
      }
      // Threat level.
      const lvl = Math.min(5, Math.max(1, st.defcon || 5));
      const T = THREAT_LEVELS[lvl];
      this.threatTile.value.textContent = T.label;
      this.threatTile.value.style.color = `var(${T.var})`;
      const lit = 6 - lvl;
      [...this.threatTile.meter.children].forEach((c, i) => { c.style.background = i < lit ? `var(${T.var})` : ''; });
      const counts = s.alertCounts();
      const open = counts.critical + counts.high + counts.medium + counts.low + counts.info;
      this.threatTile.foot.textContent = open ? `${open} open alert${open === 1 ? '' : 's'}` : 'No open alerts';
      this.renderSecurity(lvl, counts);
    }

    // Globe card subtitle and legend.
    const located = [...s.endpoints.values()].filter((e) => e.lat != null).length;
    this.globeSub.textContent = `${integer(s.endpoints.size)} hosts · ${integer(st ? st.countries : 0)} countries`;
    const famRates = new Map();
    for (const f of s.flows.values()) famRates.set(family(f.app), (famRates.get(family(f.app)) || 0) + (f.rateIn || 0) + (f.rateOut || 0));
    const topFam = [...famRates].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    const lg = topFam.map((k) => `<span><i style="background:var(--viz-${k})"></i>${APP_ROWS.find((r) => r[0] === k)?.[1] || k}</span>`).join('') + `<span><i style="background:var(--viz-threat)"></i>Threat</span>`;
    if (this.legend._h !== lg) { this.legend._h = lg; this.legend.innerHTML = lg; }
    void located;

    // Protocol mix over the range.
    const bytesBy = app.history.appBytes(range);
    const rows = APP_ROWS.map(([key, lab]) => ({ key, label: lab, value: bytesBy.get(key) || 0, color: `--viz-${key}` })).filter((r) => r.value > 0);
    this.donut.set(rows);
    const total = rows.reduce((a, r) => a + r.value, 0) || 1;
    const lhtml = rows.sort((a, b) => b.value - a.value).slice(0, 6).map((r) =>
      `<div class="legend-row" data-k="${r.key}"><i style="background:var(${r.color})"></i>${r.label}<b>${bytes(r.value)}</b><span class="pct">${pct(r.value / total, r.value / total < 0.1 ? 1 : 0)}</span></div>`).join('');
    if (this.mixLegend._h !== lhtml) {
      this.mixLegend._h = lhtml;
      this.mixLegend.innerHTML = lhtml;
      for (const row of this.mixLegend.children) {
        row.addEventListener('pointerenter', () => this.donut.setHover(row.dataset.k));
        row.addEventListener('pointerleave', () => this.donut.setHover(null));
      }
    }

    // Leaderboards.
    const eps = [...s.endpoints.values()].map((e) => ({ e, r: (e.rateIn || 0) + (e.rateOut || 0) })).filter((x) => x.r > 0 || x.e.flows);
    const maxE = Math.max(1, ...eps.map((x) => x.r));
    this.hosts.set(eps.map(({ e, r }) => ({
      key: e.id,
      icon: e.cc ? `<span class="flag">${esc(e.cc)}</span>` : icon(e.scope === 'public' ? 'globe' : 'wifi'),
      name: middleTruncate(e.name || e.ip, 30),
      sub: [e.org, e.city].filter(Boolean).join(' · ') || (e.scope === 'public' ? 'Unlocated' : 'Local network'),
      value: r, display: `<span class="num">${rate(r)}</span>`, bar: r / maxE, color: (e.threat || 0) >= 40 ? 'var(--viz-threat)' : `var(--viz-${family(e._app)})`,
    })));
    const procs = [...s.procs.values()].map((p) => ({ p, r: (p.rateIn || 0) + (p.rateOut || 0) })).filter((x) => x.r > 0 || x.p.flows);
    const maxP = Math.max(1, ...procs.map((x) => x.r));
    this.procs.set(procs.map(({ p, r }) => ({
      key: p.id, icon: icon('cpu'), name: p.name, sub: `${p.flows || 0} connection${p.flows === 1 ? '' : 's'} · pid ${p.pid}`,
      value: r, display: `<span class="num">${rate(r)}</span>`, bar: r / maxP, color: 'var(--accent)',
    })));
    const cs = s.countries();
    const maxC = Math.max(1, ...cs.map((c) => c.rate));
    this.countries.set(cs.map((c) => ({
      key: c.cc, icon: `<span class="flag">${esc(c.cc)}</span>`, name: c.country, sub: `${c.eps} host${c.eps === 1 ? '' : 's'}`,
      value: c.rate, display: `<span class="num">${rate(c.rate)}</span>`, bar: c.rate / maxC, color: 'var(--accent)',
    })));
    this.activity.tickTimes();
  }

  renderSecurity(lvl, counts) {
    const T = THREAT_LEVELS[lvl];
    this.secShield.style.background = `var(--${T.css}-soft)`;
    this.secShield.style.color = `var(${T.var})`;
    this.secLevel.textContent = T.label;
    this.secLevel.style.color = `var(${T.var})`;
    this.secBlurb.textContent = T.blurb;
    const ch = ['critical', 'high', 'medium', 'low'].map((sv) => `<div class="sev-count"><div class="n">${counts[sv] || 0}</div><div class="l"><i style="background:var(${SEVERITY[sv].var})"></i>${SEVERITY[sv].label}</div></div>`).join('');
    if (this.sevCounts._h !== ch) { this.sevCounts._h = ch; this.sevCounts.innerHTML = ch; }
    const s = this.app.store;
    const recent = s.alertOrder.map((id) => s.alerts.get(id)).filter((a) => a && !a.muted && (a.state || 'open') !== 'resolved').slice(0, 3);
    const rh = recent.length
      ? recent.map((a) => `<div class="alert-mini" data-alert="${a.id}"><span class="sev ${a.sev}"><i></i></span><span class="t">${esc(a.title)}</span><span class="w">${agoShort(a.ts, s.now())}</span></div>`).join('')
      : '<div class="alert-mini" style="cursor:default"><span class="sev info"><i></i></span><span class="t subtle">No open alerts</span></div>';
    if (this.secRecent._h !== rh) { this.secRecent._h = rh; this.secRecent.innerHTML = rh; }
  }
}

export { hex };

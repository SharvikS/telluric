import { h } from '../dom.js';
import { icon } from '../icons.js';
import { segmented, toggle } from '../components/controls.js';
import { View } from './overview.js';
import { esc, integer, count, duration, dateTime, ago } from '../../util/format.js';

/** Settings and system status. */
export class SettingsView extends View {
  constructor(app) {
    super(app, 'settings', 'Settings');
    this.refreshEvery = 2000;
  }

  row(title, desc, control) {
    return h('div.set-row', h('div.sr-text', h('div.sr-title', title), desc ? h('div.sr-desc', desc) : null), control);
  }

  seg(key, opts) {
    const p = this.app.prefs;
    const c = segmented(opts, p.get(key), (v) => p.set(key, v));
    p.on('change', (k) => { if (k === key) c.set(p.get(key)); });
    return c.el;
  }

  sw(key, label) {
    const p = this.app.prefs;
    const t = toggle(!!p.get(key), (v) => p.set(key, v), label);
    p.on('change', (k) => { if (k === key) t.set(!!p.get(key)); });
    return t.el;
  }

  mount() {
    const app = this.app;
    const themeSeg = segmented([
      { value: 'system', label: 'System', icon: 'monitor' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' },
    ], app.prefs.get('theme'), (v) => {
      const r = themeSeg.el.querySelector(`[data-v="${v}"]`).getBoundingClientRect();
      app.theme.set(v, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    });
    app.prefs.on('change', (k) => { if (k === 'theme') themeSeg.set(app.prefs.get('theme')); });

    const card = (id, title, desc, ...rows) => h(`div.card.set-card#set-${id}`, h('h3', title), desc ? h('p.desc', desc) : null, ...rows);
    this.sys = h('div');
    this.el.appendChild(h('div.page',
      h('div.view-head', h('div', h('h1', 'Settings'), h('p', 'Preferences are stored in this browser. The engine’s own configuration lives in its command-line flags.'))),
      h('div.settings.stagger',
        card('appearance', 'Appearance', null,
          this.row('Theme', 'Follow the system, or pick one.', themeSeg.el),
          this.row('Sidebar', 'Collapse to icons for more room.', this.sw('navCollapsed', 'Collapse sidebar'))),
        card('motion', 'Motion', null,
          this.row('Animation', 'Reduced keeps transitions instant and stops ambient motion.', this.seg('motion', [{ value: 'system', label: 'System' }, { value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }])),
          this.row('Cinema mode', 'More glow, film grain and dramatic alert effects on the globe — for big screens and demos.', this.sw('cinema', 'Cinema mode')),
          this.row('Auto-rotate', 'Slowly turn the globe when idle.', this.sw('globe.autoRotate', 'Auto-rotate'))),
        card('globe', 'Globe layers', null,
          this.row('Connections', 'An arc to every host, coloured by protocol.', this.sw('globe.arcs')),
          this.row('Packets', 'Comets for packets in flight (rate-limited per host).', this.sw('globe.packets')),
          this.row('Labels', 'DNS answers and the busiest hosts.', this.sw('globe.labels')),
          this.row('Country heat', 'Tint countries by traffic.', this.sw('globe.heat')),
          this.row('Day & night', 'The real terminator, with city lights at night.', this.sw('globe.terminator')),
          this.row('Traceroutes', 'Paths reconstructed from mtr / traceroute.', this.sw('globe.traces'))),
        card('units', 'Units & time', null,
          this.row('Throughput', null, this.seg('units', [{ value: 'bytes', label: 'Bytes /s' }, { value: 'bits', label: 'Bits /s' }])),
          this.row('Clock', null, this.seg('clock', [{ value: '24h', label: '24-hour' }, { value: '12h', label: '12-hour' }])),
          this.row('Time zone', null, this.seg('tz', [{ value: 'local', label: 'Local' }, { value: 'utc', label: 'UTC' }]))),
        card('notifications', 'Notifications', null,
          this.row('Alert toasts', 'Minimum severity that pops a notification.', this.seg('notify', [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' }])),
          this.row('Sound', 'Soft cues for new connections and alarms for serious alerts.', this.sw('sound', 'Sound'))),
        card('system', 'System status', 'Live health report from the engine (refreshed every 2 seconds).', this.sys),
        card('about', 'About', null,
          this.row('Telluric', 'Your machine’s live network traffic on a 3D globe.', h('a.btn.sm', { href: 'https://github.com/SharvikS/telluric', target: '_blank', rel: 'noopener', html: `${icon('external')}<span>GitHub</span>` })),
          this.credits = h('div.set-row', h('div.sr-text', h('div.sr-title', 'Credits'), h('div.sr-desc', { html: 'Map data © Natural Earth (public domain) · IP geolocation by <a href="https://db-ip.com" target="_blank" rel="noopener">DB-IP</a> (CC BY 4.0) · Inter and JetBrains Mono (SIL Open Font License)' })))))));
  }

  show(params) {
    this.refresh();
    if (params.section) {
      const el = this.el.querySelector(`#set-${params.section}`);
      if (el) setTimeout(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.animate?.([{ boxShadow: '0 0 0 0 var(--accent-ring)' }, { boxShadow: '0 0 0 4px var(--accent-ring)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1200 });
      }, 120);
    }
  }

  refresh() {
    const s = this.app.store;
    const st = s.status;
    if (!st) {
      const key = `none|${this.app.conn.state}`;
      if (this.sys._k !== key) {
        this.sys._k = key;
        this.sys.innerHTML = `<div class="subtle" style="padding:6px 0 14px">No status reported yet (${esc(this.app.conn.state)}).</div>`;
      }
      return;
    }
    const tile = (l, v) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`;
    const cap = st.capture || {}, en = st.engine || {};
    const html = `
      <div class="sys-grid">
        ${tile('Mode', esc(st.mode))}${tile('Version', `<span class="mono" style="font-size:14px">${esc(st.version)}</span>`)}${tile('Uptime', duration((st.uptime || 0) * 1000))}${tile('Clients', integer(st.clients || 0))}
        ${tile('Capture', esc(cap.source || '—'))}${tile('Packets / s', integer(cap.pps || 0))}${tile('Received', count(cap.received || 0))}${tile('Dropped', `<span style="color:${cap.dropped ? 'var(--warning)' : 'inherit'}">${integer(cap.dropped || 0)}</span>`)}
        ${tile('Engine CPU', `${(en.cpu ?? 0).toFixed(1)}%`)}${tile('Heap', `${(en.heapMB ?? 0).toFixed(1)} MB`)}${tile('Goroutines', integer(en.goroutines || 0))}${tile('Frames / s', integer(en.framesPS || 0))}
      </div>
      ${(st.warnings || []).length ? `<div style="margin-bottom:12px">${st.warnings.map((w) => `<div class="row" style="color:var(--warning);gap:8px;padding:3px 0">${icon('alert')}<span>${esc(w)}</span></div>`).join('')}</div>` : ''}
      <table class="src-table"><thead><tr><th>Data source</th><th>Kind</th><th style="text-align:right">Entries</th><th>Updated</th><th>Status</th></tr></thead><tbody>
      ${(st.sources || []).map((x) => `<tr><td>${esc(x.name)}${x.detail ? `<div class="subtle" style="font-size:11px">${esc(x.detail)}</div>` : ''}</td><td><span class="badge outline">${esc(x.kind)}</span></td><td class="num" style="text-align:right">${integer(x.entries || 0)}</td><td class="subtle">${x.updated ? `${dateTime(x.updated)} · ${ago(x.updated, s.now())}` : '—'}</td><td>${x.ok ? '<span class="badge success">OK</span>' : '<span class="badge warning">Check</span>'}</td></tr>`).join('')}
      </tbody></table>`;
    if (this.sys._h !== html) {
      this.sys._h = html;
      this.sys._k = '';
      this.sys.innerHTML = html;
    }
  }
}

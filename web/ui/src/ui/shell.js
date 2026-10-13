import { h } from './dom.js';
import { icon, MARK_SMALL } from './icons.js';
import { segmented } from './components/controls.js';
import { openPopover, closePopover, openMenu } from './components/popover.js';
import { esc, ago, duration, integer, count, dateTime } from '../util/format.js';
import { SEVERITY, ALERT_KINDS } from '../config.js';

export const NAV = [
  { section: 'Monitor' },
  { route: 'overview', label: 'Overview', icon: 'overview', key: 'G O' },
  { route: 'map', label: 'Live map', icon: 'globe', key: 'G M' },
  { route: 'connections', label: 'Connections', icon: 'connections', key: 'G C' },
  { section: 'Investigate' },
  { route: 'hosts', label: 'Hosts', icon: 'hosts', key: 'G H' },
  { route: 'processes', label: 'Processes', icon: 'cpu', key: 'G P' },
  { route: 'dns', label: 'DNS', icon: 'dns', key: 'G D' },
  { route: 'traces', label: 'Traceroutes', icon: 'route', key: 'G T' },
  { section: 'Protect' },
  { route: 'security', label: 'Security', icon: 'shield', key: 'G S', badge: true },
];

/** Left navigation rail with a spring-animated active indicator. */
export class Nav {
  constructor(app) {
    this.app = app;
    this.items = new Map();
    const scroll = h('div.nav-scroll');
    this.indicator = h('div.nav-indicator');
    scroll.appendChild(this.indicator);
    for (const it of NAV) {
      if (it.section) {
        scroll.appendChild(h('div.nav-section', it.section));
        continue;
      }
      scroll.appendChild(this.item(it));
    }
    const settings = this.item({ route: 'settings', label: 'Settings', icon: 'settings', key: 'G ,' });
    const collapse = h('button.nav-item', { type: 'button', 'data-tip': 'Collapse sidebar', 'data-kbd': '[' },
      h('span', { html: icon('sidebar') }), h('span.nav-label', 'Collapse'));
    collapse.addEventListener('click', () => app.prefs.toggle('navCollapsed'));
    this.el = h('nav.nav', { 'aria-label': 'Primary' },
      h('div.nav-brand', h('div.brand-mark', { html: MARK_SMALL }), h('span.brand-name', 'Telluric'), this.ver = h('span.brand-ver', '')),
      scroll,
      h('div.nav-foot', settings, collapse));
    this.scroll = scroll;
  }

  item(it) {
    const badge = it.badge ? h('span.nav-badge') : null;
    const b = h('a.nav-item', { href: `#/${it.route}`, 'data-tip': it.label, 'data-kbd': it.key },
      h('span', { html: icon(it.icon) }), h('span.nav-label', it.label), badge);
    b._badge = badge;
    this.items.set(it.route, b);
    return b;
  }

  setVersion(v) {
    this.ver.textContent = v || '';
    this.ver.style.display = v ? '' : 'none';
  }

  setActive(route) {
    for (const [r, b] of this.items) b.classList.toggle('active', r === route);
    const b = this.items.get(route);
    if (!b) return;
    if (b.closest('.nav-foot')) {
      this.indicator.style.opacity = '0';
      return;
    }
    this.indicator.style.opacity = '1';
    this.indicator.style.transform = `translateY(${b.offsetTop}px)`;
  }

  setBadge(route, n) {
    const b = this.items.get(route)?._badge;
    if (!b) return;
    const s = n > 0 ? String(n > 99 ? '99+' : n) : '';
    if (b.textContent !== s) b.textContent = s;
  }
}

/** Top bar: breadcrumbs, search, live/pause, time range, status, bell, theme, help. */
export class TopBar {
  constructor(app) {
    this.app = app;
    this.title = h('span.crumb-title');
    const crumbs = h('div.crumbs', h('span.crumb-root', 'Telluric'), h('span.crumb-sep', '/'), this.title);
    const search = h('button.search-trigger', { type: 'button', 'aria-label': 'Search' },
      h('span', { html: icon('search') }), h('span.label', 'Search or jump to…'),
      h('span.kbds', h('kbd', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'), h('kbd', 'K')));
    search.addEventListener('click', () => app.palette.open());

    this.live = h('button.pill', { type: 'button', 'data-tip': 'Pause live updates', 'data-kbd': 'L' });
    this.live.addEventListener('click', () => app.setPaused(!app.paused));

    this.range = segmented(
      ['5m', '15m', '1h', '6h', '24h'].map((v) => ({ value: v, label: v })),
      app.prefs.get('range'),
      (v) => app.prefs.set('range', v),
    );
    this.range.el.dataset.tip = 'Time range for charts';
    // Narrow windows: the same choice as a compact menu.
    const RANGE_LABEL = { '5m': 'Last 5 minutes', '15m': 'Last 15 minutes', '1h': 'Last hour', '6h': 'Last 6 hours', '24h': 'Last 24 hours' };
    this.rangeBtn = h('button.btn.sm.ghost.top-show-sm', { type: 'button', 'data-tip': 'Time range for charts' });
    const rangeLabel = () => { this.rangeBtn.innerHTML = `${icon('clock')}<span class="num">${app.prefs.get('range')}</span>${icon('chevron-down')}`; };
    rangeLabel();
    app.prefs.on('change', (k) => { if (k === 'range') rangeLabel(); });
    this.rangeBtn.addEventListener('click', () => openMenu(this.rangeBtn, [
      { header: 'Time range' },
      ...Object.entries(RANGE_LABEL).map(([v, label]) => ({ label, checked: app.prefs.get('range') === v, end: v, onSelect: () => app.prefs.set('range', v) })),
    ], { align: 'end' }));

    this.status = h('button.pill', { type: 'button' });
    this.status.addEventListener('click', () => this.openStatus());

    this.bell = h('button.icon-btn', { type: 'button', 'data-tip': 'Notifications', html: `${icon('bell')}<span class="dot-badge"></span>` });
    this.bell.addEventListener('click', () => this.openNotifications());
    this.badge = this.bell.querySelector('.dot-badge');

    this.themeBtn = h('button.icon-btn', { type: 'button', 'data-tip': 'Toggle theme', 'data-kbd': '⇧ T' });
    this.themeBtn.addEventListener('click', (e) => app.theme.toggle({ x: e.clientX, y: e.clientY }));
    const help = h('button.icon-btn', { type: 'button', 'data-tip': 'Keyboard shortcuts', 'data-kbd': '?', html: icon('help') });
    help.addEventListener('click', () => app.showShortcuts());

    this.el = h('header.topbar', crumbs, search,
      h('div.top-actions', this.live, h('div.top-hide-sm', this.range.el), this.rangeBtn, h('div.top-sep.top-hide-sm'), this.status, this.bell, this.themeBtn, help));
    this.unread = 0;
    this.lastStatusKey = '';
  }

  setTitle(t) {
    if (this.title.textContent === t) return;
    this.title.textContent = t;
    this.title.classList.remove('swap');
    void this.title.offsetWidth;
    this.title.classList.add('swap');
  }

  setTheme(mode) {
    this.themeBtn.innerHTML = icon(mode === 'dark' ? 'sun' : 'moon');
  }

  setLive(paused, buffered) {
    const html = paused
      ? `${icon('play')}<span>Paused</span>${buffered ? `<span class="badge accent num">+${count(buffered)}</span>` : ''}`
      : '<span class="dot live"></span><span>Live</span>';
    if (this.live._h !== html) {
      this.live._h = html;
      this.live.innerHTML = html;
      this.live.querySelector('svg')?.setAttribute('style', 'width:13px;height:13px');
      this.live.dataset.tip = paused ? 'Resume live updates' : 'Pause live updates';
    }
  }

  /** Engine status pill. state: live|demo|replay|connecting|reconnecting|offline */
  setStatus(state, detail) {
    const st = this.app.store.status;
    const warn = st && st.warnings && st.warnings.length;
    // Engine warnings turn the health dot amber in every mode.
    const base = state === 'live' ? 'live' : state === 'demo' ? 'demo' : state === 'replay' ? 'replay' : state === 'offline' ? 'bad' : 'warn';
    const dot = warn && base !== 'bad' ? 'warn' : base;
    const label = { live: 'Engine', demo: 'Demo', replay: 'Replay', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline' }[state] || state;
    const extra = warn ? ` · ${warn} warning${warn > 1 ? 's' : ''}` : st && state === 'live' ? ` · ${st.version}` : '';
    const key = `${dot}|${label}|${extra}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.status.innerHTML = `<span class="dot ${dot}"></span><span>${esc(label)}${esc(extra)}</span>`;
    this.status.dataset.tip = detail || 'Engine status';
  }

  setUnread(n) {
    const s = n > 0 ? String(n > 99 ? '99+' : n) : '';
    if (this.badge.textContent !== s) {
      if (n > this.unread) {
        this.badge.classList.remove('bump');
        void this.badge.offsetWidth;
        this.badge.classList.add('bump');
      }
      this.badge.textContent = s;
    }
    this.unread = n;
  }

  openNotifications() {
    const app = this.app;
    const list = h('div', { style: { maxHeight: '420px', overflowY: 'auto', margin: '0 -5px', padding: '0 5px' } });
    const alerts = app.store.alertOrder.map((id) => app.store.alerts.get(id)).filter((a) => a && !a.muted).slice(0, 12);
    if (!alerts.length) list.appendChild(h('div.empty', { style: { padding: '24px 12px' } }, h('div.ill', { html: icon('bell'), style: { width: '28px', height: '28px' } }), h('p', 'You’re all caught up.')));
    for (const a of alerts) {
      const sev = SEVERITY[a.sev] || SEVERITY.medium;
      const unread = a._born > app.notifSeenAt;
      const row = h('button.menu-item', { type: 'button', style: { height: 'auto', padding: '9px', alignItems: 'flex-start' } },
        h('span', { html: icon('shield-alert'), style: { color: `var(${sev.var})`, marginTop: '1px' } }),
        h('span.grow', { style: { minWidth: '0' } },
          h('div.ellipsis', { style: { fontWeight: unread ? '600' : '500' } }, a.title),
          h('div.subtle.ellipsis', { style: { fontSize: '12px' } }, `${sev.label} · ${ALERT_KINDS[a.kind] || a.kind} · ${ago(a.ts, app.store.now())}`)),
        unread ? h('span.dot', { style: { background: 'var(--accent)', marginTop: '6px' } }) : null);
      row.addEventListener('click', () => {
        closePopover();
        app.openEntity({ type: 'alert', id: a.id });
      });
      list.appendChild(row);
    }
    const markAll = h('button.btn.xs.ghost', { type: 'button' }, 'Mark all read');
    markAll.addEventListener('click', () => {
      app.markNotificationsRead();
      closePopover();
    });
    const viewAll = h('button.btn.xs', { type: 'button' }, 'View all in Security');
    viewAll.addEventListener('click', () => {
      closePopover();
      app.navigate('security');
    });
    openPopover(this.bell, h('div', { style: { width: '360px' } },
      h('div.row', { style: { padding: '6px 6px 8px' } }, h('b', 'Notifications'), h('span.spacer'), markAll),
      list,
      h('div.menu-sep'),
      h('div.row', { style: { padding: '2px 4px 2px', justifyContent: 'flex-end' } }, viewAll)), { onClose: () => app.markNotificationsRead() });
  }

  openStatus() {
    const app = this.app;
    const st = app.store.status;
    const conn = app.conn.state;
    const rows = st
      ? [
        ['Mode', esc(st.mode)],
        ['Version', `<span class="mono">${esc(st.version)}</span>`],
        ['Uptime', duration((st.uptime || 0) * 1000)],
        ['Capture', `${esc(st.capture?.source || '—')} · ${integer(st.capture?.pps || 0)} pkt/s`],
        ['Dropped', integer(st.capture?.dropped || 0)],
        ['Engine CPU', `${(st.engine?.cpu ?? 0).toFixed(1)}% · ${(st.engine?.heapMB ?? 0).toFixed(0)} MB heap`],
        ['Clients', integer(st.clients || 1)],
      ]
      : [['Connection', esc(conn)]];
    const warns = st && st.warnings && st.warnings.length
      ? h('div', { style: { marginTop: '10px' } }, st.warnings.map((w) => h('div.row', { style: { color: 'var(--warning)', fontSize: '12px', alignItems: 'flex-start', gap: '6px', marginTop: '4px' } }, h('span', { html: icon('alert'), style: { width: '14px', height: '14px', flex: 'none' } }), h('span', w))))
      : null;
    const go = h('button.btn.xs', { type: 'button' }, 'System status');
    go.addEventListener('click', () => {
      closePopover();
      app.navigate('settings', { section: 'system' });
    });
    openPopover(this.status, h('div', { style: { width: '300px', padding: '6px' } },
      h('div.row', { style: { marginBottom: '10px', gap: '8px' } }, h('span', { class: `dot ${st && st.warnings && st.warnings.length ? 'warn' : conn === 'live' ? 'live' : conn === 'demo' ? 'demo' : 'warn'}` }), h('b', conn === 'demo' ? 'Demo engine' : 'Telluric engine'), h('span.spacer'), go),
      h('dl.kv', { style: { gridTemplateColumns: '96px 1fr', fontSize: '12px', rowGap: '5px' }, html: rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') }),
      warns,
      st ? h('div.subtle', { style: { fontSize: '11px', marginTop: '10px' } }, `Reported ${dateTime(st.ts)}`) : null));
  }
}

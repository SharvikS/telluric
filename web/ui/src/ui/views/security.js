import { h } from '../dom.js';
import { icon, ILLUSTRATIONS } from '../icons.js';
import { tabs, emptyState } from '../components/controls.js';
import { Heatmap } from '../charts/heatmap.js';
import { View } from './overview.js';
import { esc, agoShort, time, integer, middleTruncate } from '../../util/format.js';
import { SEVERITY, SEV_ORDER, THREAT_LEVELS, ALERT_KINDS } from '../../config.js';

const STATES = [
  ['open', 'Open'], ['acknowledged', 'Acknowledged'], ['resolved', 'Resolved'], ['muted', 'Muted'], ['all', 'All'],
];

/** Security: threat level, alert activity, and the incident workflow. */
export class SecurityView extends View {
  constructor(app) {
    super(app, 'security', 'Security');
    this.tab = 'open';
    this.sel = new Set();
    this.collapsed = new Set(['info']);
    this.rows = new Map();
    this.refreshEvery = 1000;
  }

  mount() {
    const app = this.app;
    this.lvlShield = h('div.shield', { html: icon('shield') });
    this.lvlName = h('b');
    this.lvlBlurb = h('p');
    this.meter = h('div.threat-meter', [0, 1, 2, 3, 4].map(() => h('i')));
    const hero = h('div.card.sec-hero',
      h('div.lvl', this.lvlShield, h('div', h('small', 'Threat level'), this.lvlName)), this.meter, this.lvlBlurb);
    const hm = h('div', { style: { position: 'absolute', inset: '4px 16px 12px 16px', width: 'auto', height: 'auto' } });
    this.heat = new Heatmap(hm, {
      rows: SEV_ORDER.map((s) => ({ key: s, label: SEVERITY[s].label, color: SEVERITY[s].var })),
      format: (v) => `${v} alert event${v === 1 ? '' : 's'}`,
    });
    const activity = h('div.card.sec-activity', h('div.card-head', h('h3', 'Alert activity'), h('span.sub', 'last 60 minutes, by severity')), h('div.card-body', hm));

    this.tabsCtl = tabs(STATES.map(([v, l]) => ({ value: v, label: l, count: 0 })), this.tab, (v) => {
      this.tab = v;
      this.sel.clear();
      this.render(true);
    });
    this.search = h('input', { type: 'text', placeholder: 'Filter alerts…', spellcheck: 'false' });
    this.search.addEventListener('input', () => this.render(true));
    this.bulk = h('div.bulk.hidden');
    this.list = h('div');
    this.list.addEventListener('click', (e) => this.onClick(e));
    this.el.appendChild(h('div.page',
      h('div.view-head', h('div', h('h1', 'Security'), h('p', 'Detections from threat intelligence and behavioural analysis. Acknowledge, resolve or mute — every open tab stays in sync.'))),
      h('div.sec-top.stagger', hero, activity),
      h('div.sec-tools', this.tabsCtl.el, h('span.spacer'), this.bulk, h('label.input', { style: { width: '240px' }, html: icon('search') }, this.search)),
      this.list));
  }

  show() {
    this.render(true);
  }

  onDrawer() {
    this.render(false);
  }

  matches(a) {
    const st = a.state || 'open';
    if (this.tab === 'muted') { if (!a.muted) return false; }
    else if (this.tab !== 'all') { if (a.muted || st !== this.tab) return false; }
    const q = this.search.value.trim().toLowerCase();
    if (q && !`${a.title} ${a.detail} ${a.kind} ${ALERT_KINDS[a.kind] || ''}`.toLowerCase().includes(q)) return false;
    return true;
  }

  onClick(e) {
    const app = this.app;
    const row = e.target.closest('[data-id]');
    if (!row) {
      const g = e.target.closest('[data-group]');
      if (g) {
        const k = g.dataset.group;
        if (this.collapsed.has(k)) this.collapsed.delete(k); else this.collapsed.add(k);
        this.render(false);
      }
      return;
    }
    const id = Number(row.dataset.id);
    const a = app.store.alerts.get(id);
    if (!a) return;
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      app.alertCommand(a, act.dataset.act);
      return;
    }
    if (e.target.closest('[data-check]')) {
      if (this.sel.has(id)) this.sel.delete(id); else this.sel.add(id);
      this.render(false);
      return;
    }
    const ent = e.target.closest('[data-open]');
    if (ent) {
      e.preventDefault();
      const [type, eid] = ent.dataset.open.split(':');
      app.openEntity({ type, id: Number(eid) });
      return;
    }
    const r = row.getBoundingClientRect();
    app.openEntity({ type: 'alert', id }, { from: { x: r.left + 26, y: r.top + 24, color: `var(${(SEVERITY[a.sev] || SEVERITY.medium).var})` } });
  }

  bulkAction(action) {
    const app = this.app;
    const ids = [...this.sel];
    for (const id of ids) {
      const a = app.store.alerts.get(id);
      if (!a) continue;
      app.conn.command({ t: `alert.${action}`, id });
      app.store.patchAlert(id, action === 'mute' ? { muted: true } : { state: action === 'ack' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'open' });
    }
    const verb = { ack: 'Acknowledged', resolve: 'Resolved', mute: 'Muted', reopen: 'Reopened' }[action];
    app.toast({ kind: 'success', title: `${verb} ${ids.length} alert${ids.length === 1 ? '' : 's'}`, duration: 3000 });
    this.sel.clear();
    this.render(false);
  }

  renderBulk() {
    const n = this.sel.size;
    this.bulk.classList.toggle('hidden', !n);
    if (!n) return;
    const key = `${n}|${this.tab}`;
    if (this.bulk._k === key) return;
    this.bulk._k = key;
    const btn = (label, act, ic) => {
      const b = h('button.btn.xs', { type: 'button', html: `${icon(ic)}<span>${label}</span>` });
      b.addEventListener('click', () => this.bulkAction(act));
      return b;
    };
    const clear = h('button.btn.xs.ghost', { type: 'button' }, 'Clear');
    clear.addEventListener('click', () => { this.sel.clear(); this.render(false); });
    this.bulk.replaceChildren(h('b', `${n} selected`),
      this.tab !== 'acknowledged' && this.tab !== 'resolved' ? btn('Acknowledge', 'ack', 'check') : null,
      this.tab !== 'resolved' ? btn('Resolve', 'resolve', 'check-circle') : btn('Reopen', 'reopen', 'undo'),
      btn('Mute', 'mute', 'mute'), clear);
  }

  refresh() {
    const s = this.app.store;
    const st = s.stats;
    const lvl = st ? Math.min(5, Math.max(1, st.defcon || 5)) : 5;
    const T = THREAT_LEVELS[lvl];
    this.lvlShield.style.background = `var(--${T.css}-soft)`;
    this.lvlShield.style.color = `var(${T.var})`;
    this.lvlName.textContent = T.label;
    this.lvlName.style.color = `var(${T.var})`;
    const c = s.alertCounts();
    const open = c.critical + c.high + c.medium + c.low + c.info;
    this.lvlBlurb.textContent = `${T.blurb} ${open ? `${open} open alert${open === 1 ? '' : 's'}${c.muted ? `, ${c.muted} muted` : ''}.` : 'Nothing open.'}`;
    [...this.meter.children].forEach((m, i) => { m.style.background = i < 6 - lvl ? `var(${T.var})` : ''; });

    // Heatmap: alert events (first sightings, recurrences, state changes) per 5 minutes.
    const now = s.now();
    const b0 = Math.floor(now / 300e3) * 300e3 - 11 * 300e3;
    const cols = Array.from({ length: 12 }, (_, i) => ({ ts: b0 + i * 300e3, values: {} }));
    for (const a of s.alerts.values()) {
      const stamps = new Set([a.first || a.ts, a.ts, ...(a._events || []).map((e) => e.at)]);
      for (const t of stamps) {
        const i = Math.floor((t - b0) / 300e3);
        if (i >= 0 && i < 12) cols[i].values[a.sev] = (cols[i].values[a.sev] || 0) + 1;
      }
    }
    this.heat.set(cols);
    this.render(false);
  }

  frame() {
    this.heat.draw();
  }

  render(fresh) {
    const s = this.app.store;
    const all = s.alertOrder.map((id) => s.alerts.get(id)).filter(Boolean);
    const counts = { open: 0, acknowledged: 0, resolved: 0, muted: 0, all: all.length };
    for (const a of all) {
      if (a.muted) counts.muted++;
      else counts[a.state || 'open']++;
    }
    for (const [v] of STATES) this.tabsCtl.count(v, counts[v]);
    const shown = all.filter((a) => this.matches(a));
    for (const id of this.sel) if (!shown.some((a) => a.id === id)) this.sel.delete(id);
    this.renderBulk();
    if (!shown.length) {
      const msg = {
        open: ['All clear', 'No open alerts. New detections appear here instantly.'],
        acknowledged: ['Nothing acknowledged', 'Acknowledge an alert to signal someone is on it.'],
        resolved: ['Nothing resolved yet', 'Resolved alerts reopen automatically if the condition recurs.'],
        muted: ['No muted alerts', 'Muted alerts keep updating silently and don’t raise the threat level.'],
        all: ['No alerts yet', 'Telluric is watching. Detections appear here as they happen.'],
      }[this.tab];
      const key = `empty|${this.tab}`;
      if (this.list._k !== key) {
        this.list._k = key;
        this.list.replaceChildren(emptyState(ILLUSTRATIONS.shield, msg[0], msg[1]));
      }
      return;
    }
    this.list._k = 'list';
    const groups = SEV_ORDER.map((sev) => [sev, shown.filter((a) => a.sev === sev)]).filter(([, l]) => l.length);
    const html = groups.map(([sev, list]) => {
      const S = SEVERITY[sev];
      const col = this.collapsed.has(sev);
      return `<div class="sev-group${col ? ' collapsed' : ''}">
        <div class="sev-group-head" data-group="${sev}">${icon('chevron-down', 'caret')}<span class="sev ${sev}"><i></i></span><b>${S.label}</b><span class="badge">${list.length}</span></div>
        ${col ? '' : `<div class="sev-group-body">${list.map((a) => this.rowHTML(a)).join('')}</div>`}</div>`;
    }).join('');
    if (this.list._h !== html) {
      this.list._h = html;
      this.list.innerHTML = html;
      if (fresh) this.list.querySelectorAll('.alert-row').forEach((r, i) => {
        r.style.animation = `rise-in var(--dur-slow) var(--ease-out) ${Math.min(i, 10) * 25}ms both`;
      });
    }
  }

  rowHTML(a) {
    const s = this.app.store;
    const st = a.state || 'open';
    const ep = a.ep ? s.endpoints.get(a.ep) : null;
    const p = a.proc ? s.procs.get(a.proc) : null;
    const selected = this.sel.has(a.id);
    const drawerSel = this.app.drawer.ref && this.app.drawer.ref.type === 'alert' && this.app.drawer.ref.id === a.id;
    const stBadge = a.muted ? '<span class="badge outline">Muted</span>' : st === 'open' ? '<span class="badge danger">Open</span>' : st === 'acknowledged' ? '<span class="badge warning">Acknowledged</span>' : '<span class="badge success">Resolved</span>';
    const actions = [
      st === 'open' && !a.muted ? `<button class="btn xs" data-act="ack" data-tip="Acknowledge">${icon('check')}</button>` : '',
      st !== 'resolved' ? `<button class="btn xs" data-act="resolve" data-tip="Resolve">${icon('check-circle')}</button>` : `<button class="btn xs" data-act="reopen" data-tip="Reopen">${icon('undo')}</button>`,
      `<button class="btn xs" data-act="${a.muted ? 'unmute' : 'mute'}" data-tip="${a.muted ? 'Unmute' : 'Mute similar'}">${icon(a.muted ? 'bell' : 'mute')}</button>`,
    ].join('');
    return `<div class="alert-row${selected || drawerSel ? ' sel' : ''}" data-id="${a.id}">
      <span class="check-box${selected ? ' on' : ''}" data-check style="margin-top:3px">${icon('check')}</span>
      <div style="min-width:0">
        <div class="ar-title"><span class="sev ${a.sev}"><i></i></span>${esc(a.title)}${a.count > 1 ? `<span class="badge outline num">×${integer(a.count)}</span>` : ''}${a._pending ? '<span class="badge outline">Syncing…</span>' : ''}</div>
        <div class="ar-detail">${esc(a.detail || '')}</div>
        <div class="ar-meta"><span>${esc(ALERT_KINDS[a.kind] || a.kind)}</span><span>·</span><span title="${time(a.first || a.ts)}">first ${agoShort(a.first || a.ts, s.now())} ago</span><span>·</span><span>last ${agoShort(a.ts, s.now())} ago</span>
          ${ep ? `<a href="#" class="ent-chip" data-open="ep:${ep.id}">${icon('globe')}${esc(middleTruncate(ep.name || ep.ip, 28))}</a>` : ''}
          ${p ? `<a href="#" class="ent-chip" data-open="proc:${p.id}">${icon('cpu')}${esc(p.name)}</a>` : ''}</div>
      </div>
      <div class="ar-right">${stBadge}<div class="ar-actions">${actions}</div></div>
    </div>`;
  }

  escape() {
    if (this.sel.size) {
      this.sel.clear();
      this.render(false);
    }
  }
}

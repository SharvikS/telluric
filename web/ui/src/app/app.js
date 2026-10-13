import { h, isTyping } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { Nav, TopBar, NAV } from '../ui/shell.js';
import { Drawer } from '../ui/components/drawer.js';
import { Palette } from '../ui/components/palette.js';
import { Toaster } from '../ui/components/toasts.js';
import { installTooltips } from '../ui/components/tooltip.js';
import { closePopover, popoverOpen, openPopover } from '../ui/components/popover.js';
import { GlobeLabels } from '../ui/globe-labels.js';
import { showTip, refreshChartTheme } from '../ui/charts/theme.js';
import { Router } from './router.js';
import { Tweens, animate, motion, setReducedMotion, approach } from './motion.js';
import { Controls } from '../scene/camera.js';
import { Placement } from '../scene/placement.js';
import { clearFocus } from '../scene/focus.js';
import {
  latLonToVec3, vec3ToLatLon, subsolarPoint, screenRay, raySphere, clamp, easeInOutCubic,
} from '../util/math.js';
import { esc, rate, setFormatPrefs, middleTruncate } from '../util/format.js';
import { setVizTheme, SEVERITY, ALERT_KINDS, hex, family, appName, SERVICES } from '../config.js';

/**
 * The globe lives on one full-window canvas behind the app; views provide a
 * "slot" element and the renderer draws into that rectangle. When the slot
 * changes (Overview card → full-bleed map), the rectangle morphs between the
 * two so the globe appears to move with the layout.
 */
class GlobeSlot {
  constructor() {
    this.target = null;
    this.rect = null;
    this.from = null;
    this.t = 1;
    this.alpha = 0;
    this.radius = new WeakMap();
  }

  setTarget(el) {
    if (el === this.target) return;
    this.from = el && this.rect && this.alpha > 0.4 && !motion.reduced ? { ...this.rect } : null;
    this.t = this.from ? 0 : 1;
    this.target = el;
  }

  measure(el) {
    const r = el.getBoundingClientRect();
    let rad = this.radius.get(el);
    if (rad == null) {
      rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      this.radius.set(el, rad);
    }
    return { x: r.left, y: r.top, w: r.width, h: r.height, r: rad };
  }

  update(dt) {
    const el = this.target;
    const visible = el && el.isConnected && el.offsetParent !== null;
    if (!visible) {
      this.alpha = motion.reduced ? 0 : Math.max(0, this.alpha - dt / 0.22);
      return this.rect ? { ...this.rect, alpha: this.alpha } : null;
    }
    const m = this.measure(el);
    if (this.from && this.t < 1) {
      this.t = Math.min(1, this.t + dt / 0.6);
      const e = easeInOutCubic(this.t);
      const f = this.from;
      this.rect = { x: f.x + (m.x - f.x) * e, y: f.y + (m.y - f.y) * e, w: f.w + (m.w - f.w) * e, h: f.h + (m.h - f.h) * e, r: f.r + (m.r - f.r) * e };
    } else {
      this.rect = m;
    }
    this.alpha = motion.reduced ? 1 : Math.min(1, this.alpha + dt / 0.35);
    return { ...this.rect, alpha: this.alpha };
  }
}

export class App {
  constructor(deps) {
    Object.assign(this, deps); // geo, renderer, store, conn, world, camera, prefs, theme, history, audio, views
    this.tweens = new Tweens();
    this.toaster = new Toaster();
    this.paused = false;
    this.pausedAt = 0;
    this.buffered = 0;
    this.notifSeenAt = performance.now();
    this.slotMgr = new GlobeSlot();
    this.viewMap = new Map();
    this.current = null;
    this.lastShell = 0;
    this.fx = { glitch: 0, alert: 0, lastInput: performance.now(), userZoomAt: -1e9 };
    this.chord = null;

    this.root = document.getElementById('app');
    this.nav = new Nav(this);
    this.topbar = new TopBar(this);
    this.main = h('main.main');
    this.root.append(this.nav.el, this.topbar.el, this.main);
    this.labels = new GlobeLabels(document.getElementById('labels'), this);
    this.drawer = new Drawer(this);
    this.palette = new Palette((q) => this.paletteSource(q));
    installTooltips();

    for (const [name, V] of Object.entries(this.views)) {
      const v = new V(this);
      this.viewMap.set(name, v);
      this.main.appendChild(v.el);
    }
    this.router = new Router([...this.viewMap.keys()], 'overview');
    this.router.on('route', (r) => this.go(r));

    this.controls = new Controls(null, this.camera, {
      onInteract: () => this.noteInput(true),
      onHover: (x, y) => this.hover(x, y),
      onClick: (x, y) => this.click(x, y),
    });

    this.wirePrefs();
    this.wireStore();
    this.wireKeys();
    this.applyTheme(this.theme.mode);
  }

  // ── navigation ──────────────────────────────────────────────────────────
  navigate(name, params = {}) {
    this.router.go(name, params);
  }

  start() {
    this.go(this.router.current, true);
  }

  go(route, first = false) {
    const next = this.viewMap.get(route.name);
    if (!next) return;
    next.ensure();
    const cur = this.current;
    const now = performance.now();
    if (cur !== next) {
      if (cur) {
        cur.hide();
        const el = cur.el;
        const a = animate(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(0.995)' }], { duration: motion.dur.fast, easing: motion.ease.in });
        const done = () => { if (this.current !== cur) el.hidden = true; el.getAnimations().forEach((x) => x.cancel()); };
        if (a) a.finished.then(done).catch(done); else done();
      }
      next.el.hidden = false;
      next.el.style.opacity = '';
      if (!first) animate(next.el, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: motion.dur.slower, easing: motion.ease.out, delay: cur ? 70 : 0 });
      this.current = next;
      document.documentElement.dataset.route = route.name;
      this.nav.setActive(route.name);
      this.topbar.setTitle(next.title);
      document.title = `${next.title} · Telluric`;
      const slot = next.slot();
      this.slotMgr.setTarget(slot);
      this.controls.attach(slot);
      clearFocus(this.world.focus);
      this.focusDrawer(this.drawer.ref);
      if (slot) this.refitCamera();
    }
    next.show(route.params || {});
    next.refresh(now);
    next.lastRefresh = now;
  }

  /** Zoom so the globe fits the new slot, unless the user just zoomed. */
  refitCamera(force = false) {
    const el = this.current && this.current.slot();
    if (!el) return;
    if (!force && performance.now() - this.fx.userZoomAt < 20000) return;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    this.camera.targetDist = this.fitDistance(r.width, r.height, this.current.name === 'map' ? 0.4 : 0.44);
  }

  fitDistance(w, hgt, frac = 0.44) {
    const want = Math.min(w, hgt) * frac;
    const k = (hgt / 2) / (Math.tan(this.camera.fov / 2) * Math.max(want, 40));
    return clamp(Math.sqrt(1 + k * k), 1.9, 7);
  }

  // ── entities ────────────────────────────────────────────────────────────
  openEntity(ref, opts = {}) {
    if (!ref || ref.id == null) return;
    this.drawer.open(ref, opts);
    this.focusDrawer(ref);
    const p = { ...this.router.current.params, sel: `${ref.type}:${ref.id}` };
    this.router.replaceParams(p);
  }

  /** Globe highlight for the drawer's entity: a host is marked; a process
   *  dims everything except the hosts it talks to. */
  focusDrawer(ref) {
    const f = this.world.focus;
    f.ep = ref && ref.type === 'ep' ? ref.id : ref && ref.type === 'alert' ? this.store.alerts.get(ref.id)?.ep || 0 : 0;
    f.proc = ref && ref.type === 'proc' ? ref.id : 0;
    f.procEps = f.proc ? this.procEps(f.proc) : null;
    f.active = !!(f.proc || f.trace);
  }

  procEps(id) {
    const out = new Set();
    for (const fl of this.store.flows.values()) if (fl.proc === id) out.add(fl.ep);
    return out;
  }

  onDrawer(ref) {
    document.documentElement.classList.toggle('has-drawer', !!ref);
    if (!ref) {
      this.focusDrawer(null);
      const p = { ...this.router.current.params };
      delete p.sel;
      this.router.replaceParams(p);
    }
    this.current?.onDrawer?.(ref);
  }

  showOnMap(ep) {
    this.navigate('map');
    this.world.focus.ep = ep.id;
    setTimeout(() => this.flyToEndpoint(ep), 120);
  }

  flyToEndpoint(ep) {
    const pl = this.world.placement;
    if (!pl.hasHome || Placement.orbits(ep)) {
      const [lat, lon] = pl.homeLL;
      this.camera.flyTo(lat, lon, 2.1, 1.4);
      return;
    }
    const a = pl.home, b = latLonToVec3(ep.lat, ep.lon);
    const mid = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const theta = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
    const [lat, lon] = Math.hypot(...mid) < 1e-3 ? [ep.lat, ep.lon] : vec3ToLatLon(mid);
    this.camera.flyTo(lat - 6, lon, clamp(2.0 + theta * 1.2, 2.0, 5.0), 1.6);
  }

  alertCommand(a, action) {
    const optimistic = {
      ack: { state: 'acknowledged' }, resolve: { state: 'resolved' }, reopen: { state: 'open' }, mute: { muted: true }, unmute: { muted: false },
    }[action];
    const ok = this.conn.command({ t: `alert.${action}`, id: a.id });
    if (!ok) {
      this.toast({ kind: 'warning', title: 'Not connected', desc: 'The engine is unreachable; try again when it reconnects.' });
      return;
    }
    const before = { state: a.state, muted: a.muted };
    this.store.patchAlert(a.id, { ...optimistic, stateTs: this.store.now() });
    const verb = { ack: 'Acknowledged', resolve: 'Resolved', reopen: 'Reopened', mute: 'Muted', unmute: 'Unmuted' }[action];
    this.toast({
      kind: 'success', title: `${verb} alert`, desc: esc(a.title), duration: 4000, key: `cmd-${a.id}`,
      actions: action === 'unmute' ? [] : [{ label: 'Undo', onClick: () => {
        const back = action === 'mute' ? 'unmute' : before.state === 'open' ? 'reopen' : before.state === 'acknowledged' ? 'ack' : null;
        if (back) {
          this.conn.command({ t: `alert.${back}`, id: a.id });
          this.store.patchAlert(a.id, before);
        }
      } }],
    });
  }

  toast(opts) {
    return this.toaster.show(opts);
  }

  setPaused(on) {
    if (this.paused === on) return;
    this.paused = on;
    this.pausedAt = this.store.now();
    if (!on) {
      if (this.buffered) this.toast({ kind: 'info', title: 'Live updates resumed', desc: `Applied ${this.buffered.toLocaleString()} buffered updates.`, duration: 2800 });
      this.buffered = 0;
      for (const v of this.viewMap.values()) v.lastRefresh = 0;
    }
    this.topbar.setLive(this.paused, this.buffered);
  }

  markNotificationsRead() {
    this.notifSeenAt = performance.now();
    this.topbar.setUnread(0);
  }

  unreadCount() {
    let n = 0;
    for (const a of this.store.alerts.values()) if (!a.muted && a._born > this.notifSeenAt) n++;
    return n;
  }

  // ── store events ────────────────────────────────────────────────────────
  wireStore() {
    const s = this.store;
    const bump = () => { if (this.paused) this.buffered++; };
    for (const ev of ['flow', 'ep', 'dns', 'alert', 'proc']) s.on(ev, bump);
    s.on('alert', (a, isNew) => {
      if (!isNew || a.muted || this.booting) return;
      const rank = (SEVERITY[a.sev] || SEVERITY.info).rank;
      const min = (SEVERITY[this.prefs.get('notify')] || SEVERITY.medium).rank;
      if (rank < min) return;
      if (this.store.now() - a.ts > 15000) return;
      this.toast({
        kind: rank >= 3 ? 'danger' : 'warning', title: a.title, desc: esc(a.detail || ''), duration: rank >= 4 ? 9000 : 6500, key: `alert-${a.id}`,
        actions: [
          { label: 'View', primary: true, onClick: () => this.openEntity({ type: 'alert', id: a.id }) },
          { label: 'Acknowledge', onClick: () => this.alertCommand(a, 'ack') },
        ],
      });
      this.audio.alarm(a.sev);
      if (this.prefs.get('cinema')) {
        const k = { critical: 1, high: 0.6, medium: 0.3 }[a.sev] || 0.2;
        this.fx.glitch = Math.max(this.fx.glitch, k);
        if (a.sev === 'critical') this.camera.shake(0.3);
      }
    });
    s.on('flow', (f, isNew) => { if (isNew) this.audio.blip(f.app); });
    s.on('trace', (t) => {
      if (!t.done || t._toasted || this.booting) return;
      t._toasted = true;
      const last = t.hops[t.hops.length - 1];
      this.toast({ kind: 'info', title: `Traceroute to ${t.name || t.dst}`, desc: `${last ? last.n : t.hops.length} hops${last && last.rtt != null ? ` · ${Math.round(last.rtt)} ms` : ''}`, duration: 5000,
        actions: [{ label: 'View path', primary: true, onClick: () => this.navigate('traces', { trace: t.id }) }] });
    });
    this.conn.on('status', ({ state, detail }) => {
      this.topbar.setStatus(state, detail);
      if (this.booting) return;
      if (state === 'reconnecting') this.toast({ kind: 'warning', title: 'Engine connection lost', desc: 'Keeping the last state on screen while reconnecting…', key: 'conn' });
      else if (state === 'live') this.toast({ kind: 'success', title: 'Connected to engine', desc: esc(detail || ''), key: 'conn', duration: 3000 });
    });
    s.on('status', () => this.topbar.setStatus(this.conn.state, ''));
    s.on('hello', (msg) => {
      const v = msg.mode === 'demo' ? 'demo' : (String(msg.server || '').split('/')[1] || '').slice(0, 9);
      this.nav.setVersion(v);
    });
    s.on('home', (hm) => {
      if (hm) this.world.placement.setHome(hm);
    });
  }

  // ── preferences ─────────────────────────────────────────────────────────
  wirePrefs() {
    const p = this.prefs;
    const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const applyMotion = () => {
      const m = p.get('motion');
      setReducedMotion(m === 'reduced' || (m === 'system' && mqReduce.matches));
    };
    mqReduce.addEventListener('change', applyMotion);
    applyMotion();
    const applyFormat = () => setFormatPrefs({ units: p.get('units'), clock: p.get('clock'), tz: p.get('tz') });
    applyFormat();
    const applyGlobe = () => {
      const g = p.get('globe');
      this.world.setLayers(g);
      this.labels.setEnabled(g.labels);
      this.camera.autoRotate = g.autoRotate;
    };
    applyGlobe();
    this.root.classList.toggle('nav-collapsed', p.get('navCollapsed'));
    this.theme.on('change', (mode) => this.applyTheme(mode));
    p.on('change', (key) => {
      if (key === 'motion') applyMotion();
      else if (key === 'units' || key === 'clock' || key === 'tz') {
        applyFormat();
        for (const v of this.viewMap.values()) v.lastRefresh = 0;
      } else if (key.startsWith('globe')) applyGlobe();
      else if (key === 'navCollapsed') {
        this.root.classList.toggle('nav-collapsed', p.get('navCollapsed'));
        setTimeout(() => this.nav.setActive(this.router.current.name), 360);
      } else if (key === 'range') {
        this.topbar.range.set(p.get('range'));
        for (const v of this.viewMap.values()) v.lastRefresh = 0;
      } else if (key === 'cinema') this.applyTheme(this.theme.mode);
      else if (key === 'sound') this.audio.setEnabled(p.get('sound'));
    });
    this.audio.setEnabled(p.get('sound'));
  }

  applyTheme(mode) {
    setVizTheme(mode);
    refreshChartTheme();
    this.renderer.setTheme(mode, this.prefs.get('cinema'));
    this.topbar.setTheme(mode);
    for (const v of this.viewMap.values()) {
      v.lastRefresh = 0;
      v.onTheme?.(mode);
    }
  }

  // ── keyboard ────────────────────────────────────────────────────────────
  wireKeys() {
    const routes = Object.fromEntries(NAV.filter((n) => n.route).map((n) => [n.key.split(' ')[1].toLowerCase(), n.route]));
    routes[','] = 'settings';
    window.addEventListener('keydown', (e) => {
      this.noteInput(false);
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.palette.isOpen ? this.palette.close() : this.palette.open();
        return;
      }
      if (this.palette.isOpen) return;
      if (e.key === 'Escape') {
        if (popoverOpen()) return;
        if (this.drawer.isOpen) this.drawer.close();
        else this.current?.escape?.();
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.chord && performance.now() - this.chord < 1200) {
        this.chord = null;
        const r = routes[e.key.toLowerCase()];
        if (r) {
          e.preventDefault();
          this.navigate(r);
        }
        return;
      }
      switch (e.key) {
        case 'g': case 'G': this.chord = performance.now(); break;
        case '/': e.preventDefault(); this.palette.open(); break;
        case '?': this.showShortcuts(); break;
        case '[': this.prefs.toggle('navCollapsed'); break;
        case 'l': case 'L': this.setPaused(!this.paused); break;
        case 'T': {
          const b = this.topbar.themeBtn.getBoundingClientRect();
          this.theme.toggle({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
          break;
        }
        default: this.current?.key?.(e);
      }
    });
  }

  showShortcuts() {
    const groups = [
      ['General', [['⌘ K', 'Command palette'], ['/', 'Search'], ['?', 'Keyboard shortcuts'], ['[', 'Collapse sidebar'], ['L', 'Pause / resume live'], ['⇧ T', 'Toggle theme'], ['Esc', 'Close panel']]],
      ['Navigate', NAV.filter((n) => n.route).map((n) => [n.key, n.label]).concat([['G ,', 'Settings']])],
      ['Tables', [['↑ ↓', 'Move selection'], ['↵', 'Open details'], ['→ ←', 'Expand / collapse']]],
      ['Map', [['A', 'Auto-rotate'], ['R', 'Reset view'], ['+ −', 'Zoom']]],
    ];
    const body = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px 28px', padding: '14px' } },
      groups.map(([title, rows]) => h('div', h('div.caps', { style: { marginBottom: '8px' } }, title),
        rows.map(([k, l]) => h('div.row', { style: { justifyContent: 'space-between', padding: '4px 0' } }, h('span.muted', l), h('span.kbds', k.split(' ').map((x) => h('kbd', x))))))));
    const anchor = this.topbar.el.querySelector('[data-tip="Keyboard shortcuts"]');
    openPopover(anchor, h('div', { style: { width: '560px' } }, h('div.row', { style: { padding: '10px 14px 0' } }, h('b', 'Keyboard shortcuts')), body));
  }

  // ── command palette ─────────────────────────────────────────────────────
  paletteSource(q) {
    const s = this.store;
    const nav = NAV.filter((n) => n.route).concat([{ route: 'settings', label: 'Settings', icon: 'settings', key: 'G ,' }])
      .map((n) => ({ title: `Go to ${n.label}`, icon: n.icon, end: n.key.split(' ').map((k) => `<kbd>${k}</kbd>`).join(''), run: () => this.navigate(n.route) }));
    const actions = [
      { title: `Switch to ${this.theme.mode === 'dark' ? 'light' : 'dark'} theme`, icon: this.theme.mode === 'dark' ? 'sun' : 'moon', run: () => this.theme.toggle(null), end: '<kbd>⇧</kbd><kbd>T</kbd>' },
      { title: this.paused ? 'Resume live updates' : 'Pause live updates', icon: this.paused ? 'play' : 'pause', run: () => this.setPaused(!this.paused), end: '<kbd>L</kbd>' },
      { title: `${this.prefs.get('navCollapsed') ? 'Expand' : 'Collapse'} sidebar`, icon: 'sidebar', run: () => this.prefs.toggle('navCollapsed'), end: '<kbd>[</kbd>' },
      { title: `${this.camera.autoRotate ? 'Stop' : 'Start'} globe auto-rotation`, icon: 'rotate', run: () => this.prefs.set('globe.autoRotate', !this.camera.autoRotate) },
      { title: `${this.prefs.get('cinema') ? 'Disable' : 'Enable'} cinema mode`, icon: 'sparkles', run: () => this.prefs.toggle('cinema') },
      { title: 'Show keyboard shortcuts', icon: 'keyboard', run: () => this.showShortcuts(), end: '<kbd>?</kbd>' },
      { title: 'Open system status', icon: 'database', run: () => this.navigate('settings', { section: 'system' }) },
    ];
    const hosts = [...s.endpoints.values()].sort((a, b) => (b.rateIn + b.rateOut) - (a.rateIn + a.rateOut)).map((e) => ({
      title: e.name || e.ip, sub: [e.ip !== (e.name || e.ip) ? e.ip : '', e.org, e.city].filter(Boolean).join(' · '), icon: 'globe',
      keywords: [e.ip, e.org, e.city, e.country, e.cc, ...(e.names || []), SERVICES[e.svc] || ''].join(' '),
      end: rate((e.rateIn || 0) + (e.rateOut || 0)), run: () => this.openEntity({ type: 'ep', id: e.id }),
    }));
    const procs = [...s.procs.values()].map((p) => ({ title: p.name, sub: `pid ${p.pid} · ${middleTruncate(p.cmd || p.exe || '', 60)}`, icon: 'cpu', keywords: `${p.pid} ${p.cmd} ${p.unit}`, end: rate((p.rateIn || 0) + (p.rateOut || 0)), run: () => this.openEntity({ type: 'proc', id: p.id }) }));
    const alerts = s.alertOrder.map((id) => s.alerts.get(id)).filter(Boolean).map((a) => ({
      title: a.title, sub: `${(SEVERITY[a.sev] || SEVERITY.info).label} · ${ALERT_KINDS[a.kind] || a.kind} · ${a.state || 'open'}`, icon: 'shield-alert', keywords: `${a.detail} ${a.kind}`,
      run: () => this.openEntity({ type: 'alert', id: a.id }),
    }));
    const countries = s.countries().map((c) => ({ title: c.country, sub: `${c.eps} hosts`, icon: 'flag', keywords: c.cc, end: rate(c.rate), run: () => this.navigate('hosts', { country: c.cc }) }));
    const traces = [...s.traces.values()].map((t) => ({ title: `Traceroute to ${t.name || t.dst}`, sub: `${t.hops.length} hops`, icon: 'route', run: () => this.navigate('traces', { trace: t.id }) }));
    return [
      { name: 'Navigation', items: nav, limit: 4, emptyLimit: 9 },
      { name: 'Actions', items: actions, limit: 4, emptyLimit: 4 },
      { name: 'Hosts', items: hosts, limit: 6, emptyLimit: 3 },
      { name: 'Processes', items: procs, limit: 4, emptyLimit: 0 },
      { name: 'Alerts', items: alerts, limit: 4, emptyLimit: 2 },
      { name: 'Countries', items: countries, limit: 3, emptyLimit: 0 },
      { name: 'Traceroutes', items: traces, limit: 3, emptyLimit: 0 },
    ];
  }

  // ── globe input ─────────────────────────────────────────────────────────
  noteInput(onGlobe) {
    this.fx.lastInput = performance.now();
    if (onGlobe) this.fx.userZoomAt = performance.now();
  }

  globeLatLon(x, y) {
    const sl = this.slot;
    if (!sl) return null;
    const [o, d] = screenRay(this.camera.invViewProj, this.camera.eye, x - sl.x, y - sl.y, sl.w, sl.h);
    const t = raySphere(o, d);
    if (t < 0) return null;
    return vec3ToLatLon([o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
  }

  hover(x, y) {
    const el = this.slotMgr.target;
    if (x == null) {
      showTip(0, 0, null);
      this.renderer.globe.hoverCountry = 0;
      el?.classList.remove('pointing');
      return;
    }
    const id = this.world.pick(x, y);
    el?.classList.toggle('pointing', id != null);
    if (id != null) {
      const ep = this.store.endpoints.get(id);
      if (ep) {
        const where = ep.scope === 'public' ? [ep.city, ep.cc].filter(Boolean).join(', ') || 'Unlocated' : 'Local network';
        showTip(x, y, `<div class="tt-title">${esc(middleTruncate(ep.name || ep.ip, 34))}</div>
          <div class="tt-row">${esc(ep.ip)}<b>${esc(where)}</b></div>
          ${ep.org ? `<div class="tt-row">Network<b>${esc(middleTruncate(ep.org, 28))}</b></div>` : ''}
          <div class="tt-row"><i style="background:${hex(family(ep._app))}"></i>${esc(appName(ep._app))}<b>${rate((ep.rateIn || 0) + (ep.rateOut || 0))}</b></div>`);
      }
      this.renderer.globe.hoverCountry = 0;
      return;
    }
    const ll = this.globeLatLon(x, y);
    const cid = ll ? this.geo.countryAt(ll[0], ll[1]) : 0;
    this.renderer.globe.hoverCountry = cid;
    const c = cid ? this.geo.byId.get(cid) : null;
    const agg = c ? this.store.countries().find((k) => k.cc === c.iso2) : null;
    showTip(x, y, c && agg ? `<div class="tt-title">${esc(c.name)}</div><div class="tt-row">Hosts<b>${agg.eps}</b></div><div class="tt-row">Throughput<b>${rate(agg.rate)}</b></div>` : null);
  }

  click(x, y) {
    showTip(0, 0, null);
    const id = this.world.pick(x, y, 16);
    if (id != null) {
      const ep = this.store.endpoints.get(id);
      const color = ep ? ((ep.threat || 0) >= 40 ? hex('threat') : hex(family(ep._app))) : null;
      this.openEntity({ type: 'ep', id }, { from: { x, y, color } });
      if (ep && this.current?.name === 'map') this.flyToEndpoint(ep);
      return;
    }
    const ll = this.globeLatLon(x, y);
    const cid = ll ? this.geo.countryAt(ll[0], ll[1]) : 0;
    const c = cid ? this.geo.byId.get(cid) : null;
    if (c && c.iso2 && this.store.countries().some((k) => k.cc === c.iso2)) {
      this.renderer.globe.selCountry = c.id;
      this.camera.flyTo(c.lat, c.lon, Math.max(2.3, Math.min(this.camera.targetDist, 3.2)), 1.4);
    } else {
      this.renderer.globe.selCountry = 0;
      this.drawer.close();
    }
  }

  // ── frame ───────────────────────────────────────────────────────────────
  frame(now, dt) {
    this.tweens.update(dt);
    const slot = this.slotMgr.update(dt);
    this.slot = slot && slot.alpha > 0.001 ? slot : null;
    const canvas = this.renderer.canvas;
    if (this.slot) {
      const cam = this.camera;
      cam.setViewport(slot.w, slot.h);
      cam.offset[0] = 0;
      cam.offset[1] = 0;
      cam.update(dt, this.controls.interacting);
      const [slat, slon] = subsolarPoint(new Date(this.store.now()));
      this.sun = latLonToVec3(slat, slon, 1, this.sun || new Float32Array(3));
      const defcon = this.store.stats ? this.store.stats.defcon || 5 : 5;
      const base = defcon <= 1 ? 0.5 : defcon === 2 ? 0.25 : 0;
      this.fx.glitch *= Math.exp(-dt * 2.2);
      this.fx.alert = Math.max(base * (0.75 + 0.25 * Math.sin(now / 300)), approach(this.fx.alert, 0, dt, 0.9));
      const f = {
        camera: cam, time: this.world.now(), sun: this.sun, alert: this.fx.alert, glitch: this.fx.glitch,
        pxScale: this.renderer.dpr * this.renderer.scale, slot,
        cssWidth: this.renderer.cssW, cssHeight: this.renderer.cssH,
        renderWidth: Math.max(1, Math.round(slot.w * this.renderer.dpr * this.renderer.scale)),
        renderHeight: Math.max(1, Math.round(slot.h * this.renderer.dpr * this.renderer.scale)),
      };
      this.world.visible = true;
      this.world.frame(f, dt);
      this.renderer.render(f);
      this.labels.update(f, dt, this.current?.obstacles() || []);
      canvas.classList.remove('off');
    } else {
      this.world.visible = false;
      this.renderer.clear();
      this.labels.update({ slot: null }, dt, []);
    }
    const v = this.current;
    if (v) {
      v.frame(now, dt);
      if (!this.paused && now - v.lastRefresh >= v.refreshEvery) {
        v.lastRefresh = now;
        v.refresh(now);
      }
    }
    this.drawer.update(now);
    this.history.tick(now);
    if (now - this.lastShell > 500) {
      this.lastShell = now;
      this.root.classList.toggle('nodata', !this.store.stats);
      const f = this.world.focus;
      if (f.proc) f.procEps = this.procEps(f.proc);
      this.topbar.setLive(this.paused, this.buffered);
      const c = this.store.alertCounts();
      this.nav.setBadge('security', c.critical + c.high + c.medium + c.low);
      this.topbar.setUnread(this.unreadCount());
      if (!this.nav._placed) {
        this.nav.setActive(this.router.current.name);
        this.nav._placed = true;
      }
    }
  }
}

export { icon };

import { middleTruncate, rate, esc } from '../util/format.js';
import { smoothstep } from '../util/math.js';
import { hex, family } from '../config.js';

const DNS_LIFE = 4.2;
const MAX_DNS = 7;
const SPAWN_GAP = 0.22;
const WAIT_FOR_EP = 1.6;
const BOX_H = 22;
const CANDIDATES = [[16, -36], [-16, -36], [16, 16], [-16, 16], [30, -62], [-30, -62], [30, 42], [-30, 42]];

function make(cls) {
  const el = document.createElement('div');
  el.className = `glabel ${cls} enter`;
  el.innerHTML = '<div class="lead"></div><div class="box"><i></i><span class="txt"></span><small></small></div>';
  el.style.opacity = '0';
  return { el, lead: el.firstChild, box: el.lastChild, sw: el.querySelector('i'), txt: el.querySelector('.txt'), small: el.querySelector('small'), cand: 0, opacity: 0, w: 120 };
}

/**
 * Labels anchored to the globe: DNS answers (shown where the answer lives,
 * waiting briefly for the connection to appear), traceroute hops, tags for
 * the busiest hosts, and home. Greedy placement avoids overlaps, overlays
 * registered by the current view, and the outside of the globe slot.
 */
export class GlobeLabels {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.store = app.store;
    this.world = app.world;
    this.waiting = [];
    this.dns = [];
    this.tags = new Map();
    this.pins = new Map();
    this.recent = new Map();
    this.lastSpawn = 0;
    this.enabled = true;
    this.home = make('home');
    root.appendChild(this.home.el);
    this.store.on('dns', (items) => {
      if (!this.enabled) return;
      const t = performance.now();
      for (const d of items) {
        if ((this.recent.get(d.q) || 0) > t - 20000) continue;
        this.recent.set(d.q, t);
        this.waiting.push({ d, at: t / 1000, nx: d.rcode && d.rcode !== 'NOERROR' });
      }
      if (this.waiting.length > 12) this.waiting.splice(0, this.waiting.length - 12);
      if (this.recent.size > 500) this.recent.clear();
    });
    this.store.on('reset', () => this.clear());
  }

  clear() {
    for (const l of [...this.dns, ...this.tags.values(), ...this.pins.values()]) l.el.remove();
    this.dns = [];
    this.tags.clear();
    this.pins.clear();
    this.waiting = [];
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      for (const l of [...this.dns, ...this.tags.values()]) l.el.remove();
      this.dns = [];
      this.tags.clear();
      this.waiting = [];
    }
  }

  hideAll() {
    this.root.style.visibility = 'hidden';
  }

  resolve(d) {
    for (const id of d.eps || []) if (this.world.screen.has(id)) return id;
    for (const ip of d.answers || []) {
      const ep = this.store.byIp.get(ip);
      if (ep && this.world.screen.has(ep.id)) return ep.id;
    }
    return null;
  }

  update(frame, dt, obstacles) {
    const slot = frame.slot;
    if (!slot || slot.alpha < 0.6) {
      this.root.style.visibility = 'hidden';
      return;
    }
    this.root.style.visibility = 'visible';
    this.root.style.opacity = String(Math.min(1, (slot.alpha - 0.6) / 0.4));
    this.slot = slot;
    const nowS = performance.now() / 1000;
    if (this.enabled && this.waiting.length && nowS - this.lastSpawn > SPAWN_GAP && this.dns.length < MAX_DNS) {
      for (let i = 0; i < this.waiting.length; i++) {
        const w = this.waiting[i];
        const ep = w.nx ? null : this.resolve(w.d);
        if (ep != null || nowS - w.at > WAIT_FOR_EP || w.nx) {
          this.waiting.splice(i, 1);
          if (nowS - w.at < 6) this.spawnDns(w, ep, nowS);
          this.lastSpawn = nowS;
          break;
        }
      }
    }
    const placed = obstacles.slice();
    const hs = this.world.homeScreen;
    const home = this.store.home;
    if (home && hs.visible) {
      const t = home.city ? `Home · ${home.city}` : 'Home';
      if (this.home.txt.textContent !== t) this.home.txt.textContent = t;
      this.home.w = t.length * 6.6 + 30;
      this.place(this.home, hs.x, hs.y, placed, 1, [[18, 14], [-18, 14], [18, -40]]);
    } else this.home.el.style.opacity = '0';

    // Traceroute hops first: routes beat DNS chatter.
    const keepPins = new Set();
    for (const pin of this.world.traces.labels()) {
      keepPins.add(pin.key);
      let l = this.pins.get(pin.key);
      if (!l) {
        l = make(`hop${pin.dest ? ' dest' : ''}`);
        l.scr = { x: 0, y: 0, visible: false, front: 0 };
        this.root.appendChild(l.el);
        this.pins.set(pin.key, l);
      }
      if (l.txt.textContent !== pin.text) l.txt.textContent = pin.text;
      if (l.small.textContent !== pin.sub) l.small.textContent = pin.sub;
      l.w = (pin.text.length + pin.sub.length) * 6.3 + 34;
      l.opacity = Math.min(1, l.opacity + dt * 3);
      const s = this.world.projectPoint(pin.pos, l.scr);
      this.place(l, s.x, s.y, placed, l.opacity * (s.visible ? smoothstep(0.02, 0.2, s.front) : 0));
    }
    for (const [k, l] of this.pins) {
      if (keepPins.has(k)) continue;
      l.opacity -= dt * 2.5;
      if (l.opacity <= 0) { l.el.remove(); this.pins.delete(k); } else l.el.style.opacity = String(l.opacity);
    }

    this.dns = this.dns.filter((l) => {
      const age = nowS - l.born;
      if (age > DNS_LIFE) { l.el.remove(); return false; }
      let x, y, vis = 1;
      const s = l.ep != null ? this.world.screen.get(l.ep) : null;
      if (s) {
        x = s.x; y = s.y;
        vis = s.visible ? smoothstep(0.02, 0.22, s.front) : 0;
      } else {
        x = hs.x + l.off[0];
        y = hs.y + l.off[1];
        vis = hs.visible ? 1 : 0;
      }
      const fade = Math.min(1, age / 0.2) * (1 - smoothstep(DNS_LIFE - 0.6, DNS_LIFE, age));
      this.place(l, x, y, placed, fade * vis);
      return true;
    });

    // Tags for the busiest visible hosts, threats, and the selection.
    const busy = [];
    if (this.enabled) {
      const sel = this.world.focus.ep;
      for (const [id, s] of this.world.screen) {
        if (!s.visible || s.front < 0.15) continue;
        const ep = this.store.endpoints.get(id);
        if (!ep || this.dns.some((l) => l.ep === id)) continue;
        const r = (ep.rateIn || 0) + (ep.rateOut || 0);
        const threat = (ep.threat || 0) >= 40;
        if (id === sel || threat || r > 4000) busy.push([id === sel ? Infinity : threat ? 1e12 : r, id, ep]);
      }
      busy.sort((a, b) => b[0] - a[0]);
    }
    const want = new Set(busy.slice(0, 5).map((b) => b[1]));
    for (const [, id, ep] of busy.slice(0, 5)) {
      let l = this.tags.get(id);
      if (!l) {
        l = make('tag');
        this.root.appendChild(l.el);
        this.tags.set(id, l);
      }
      const name = middleTruncate(ep.name || ep.ip, 26);
      const sub = rate((ep.rateIn || 0) + (ep.rateOut || 0));
      if (l.txt.textContent !== name) l.txt.textContent = name;
      if (l.small.textContent !== sub) l.small.textContent = sub;
      const threat = (ep.threat || 0) >= 40;
      const sw = threat ? hex('threat') : hex(family(ep._app));
      if (l._sw !== sw) { l._sw = sw; l.sw.style.background = sw; }
      l.el.classList.toggle('threat', threat);
      l.w = (name.length + sub.length) * 6.3 + 36;
      const s = this.world.screen.get(id);
      l.opacity += (1 - l.opacity) * Math.min(1, dt * 4);
      this.place(l, s.x, s.y, placed, l.opacity * smoothstep(0.15, 0.3, s.front));
    }
    for (const [id, l] of this.tags) {
      if (want.has(id)) continue;
      l.opacity -= dt * 3;
      if (l.opacity <= 0) { l.el.remove(); this.tags.delete(id); } else l.el.style.opacity = String(l.opacity);
    }
  }

  spawnDns(w, ep, nowS) {
    const l = make(w.nx ? 'nx' : 'dns');
    const d = w.d;
    const text = middleTruncate(d.q, 38);
    const sub = w.nx ? d.rcode : (d.answers && d.answers[0]) || '';
    l.txt.textContent = text;
    l.small.textContent = sub;
    l.ep = ep;
    l.born = nowS;
    l.off = ep == null ? [(Math.random() - 0.5) * 60, (Math.random() - 0.5) * 30] : null;
    l.w = (text.length + sub.length) * 6.3 + 36;
    this.root.appendChild(l.el);
    this.dns.push(l);
  }

  place(l, x, y, placed, opacity, cands = CANDIDATES) {
    const sl = this.slot;
    if (opacity <= 0.01 || !Number.isFinite(x) || x < sl.x || y < sl.y || x > sl.x + sl.w || y > sl.y + sl.h) {
      l.el.style.opacity = '0';
      return;
    }
    const w = l.w;
    const rectFor = (c) => {
      const [dx, dy] = cands[c % cands.length];
      return [x + (dx >= 0 ? dx : dx - w), y + dy, w, BOX_H, dx];
    };
    const pad = 6;
    const hits = (r) => r[0] < sl.x + pad || r[1] < sl.y + pad || r[0] + r[2] > sl.x + sl.w - pad || r[1] + r[3] > sl.y + sl.h - pad ||
      placed.some((p) => r[0] < p[0] + p[2] + 4 && r[0] + r[2] + 4 > p[0] && r[1] < p[1] + p[3] + 3 && r[1] + r[3] + 3 > p[1]);
    let r = rectFor(l.cand);
    if (hits(r)) {
      let found = null;
      for (let c = 0; c < cands.length; c++) {
        const rc = rectFor(c);
        if (!hits(rc)) { l.cand = c; found = rc; break; }
      }
      if (!found) { l.el.style.opacity = '0'; return; }
      r = found;
    }
    placed.push(r);
    const bx = r[0] - x, by = r[1] - y;
    l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    l.el.style.opacity = String(Math.min(1, opacity));
    l.box.style.transform = `translate(${bx.toFixed(1)}px, ${by.toFixed(1)}px)`;
    const ex = r[4] >= 0 ? bx : bx + w, ey = by + BOX_H / 2;
    l.lead.style.width = `${Math.hypot(ex, ey).toFixed(1)}px`;
    l.lead.style.transform = `rotate(${Math.atan2(ey, ex)}rad)`;
  }
}

export const esc_ = esc;

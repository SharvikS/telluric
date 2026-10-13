import { esc, middleTruncate, rate } from '../util/format.js';
import { smoothstep } from '../util/math.js';

const DNS_LIFE = 4.6;
const MAX_DNS = 9;
const SPAWN_GAP = 0.16;
const WAIT_FOR_EP = 1.6;
const CHAR_W = 6.5;
const BOX_H = 19;
const CANDIDATES = [[18, -38], [-18, -38], [18, 18], [-18, 18], [34, -64], [-34, -64], [34, 44], [-34, 44], [8, -88], [-8, -88]];

function makeLabel(cls) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`;
  el.innerHTML = '<div class="lead"></div><div class="box"><span class="txt"></span><span class="cur"></span><small></small></div>';
  el.style.opacity = '0';
  return { el, lead: el.firstChild, box: el.lastChild, txt: el.querySelector('.txt'), cur: el.querySelector('.cur'), small: el.querySelector('small'), cand: 0, opacity: 0 };
}

/**
 * Screen-space labels anchored to points on the globe: DNS lookups that type
 * themselves out where the answer lives, persistent tags for the busiest
 * endpoints, and the home beacon. Placement is greedy: older labels keep their
 * spot; newcomers try candidate offsets until they stop overlapping.
 */
export class Labels {
  constructor(el, store, world) {
    this.el = el;
    this.store = store;
    this.world = world;
    this.waiting = [];
    this.dns = [];
    this.tags = new Map();
    this.pins = new Map(); // traceroute hop labels
    this.lastSpawn = 0;
    this.home = makeLabel('home');
    this.home.cur.remove();
    el.appendChild(this.home.el);
    this.recent = new Map();
    store.on('dns', (items) => {
      for (const d of items) {
        const nx = d.rcode && d.rcode !== 'NOERROR';
        const key = d.q;
        const t = performance.now();
        if ((this.recent.get(key) || 0) > t - 15000) continue;
        this.recent.set(key, t);
        this.waiting.push({ d, at: t / 1000, nx });
      }
      if (this.waiting.length > 14) this.waiting.splice(0, this.waiting.length - 14);
      if (this.recent.size > 500) this.recent.clear();
    });
    store.on('reset', () => this.clear());
  }

  clear() {
    for (const l of this.dns) l.el.remove();
    for (const l of this.tags.values()) l.el.remove();
    for (const l of this.pins.values()) l.el.remove();
    this.dns = [];
    this.tags.clear();
    this.pins.clear();
    this.waiting = [];
  }

  resolveAnchor(d) {
    for (const id of d.eps || []) if (this.world.screen.has(id)) return id;
    for (const ip of d.answers || []) {
      const ep = this.store.byIp.get(ip);
      if (ep && this.world.screen.has(ep.id)) return ep.id;
    }
    return null;
  }

  spawn(w, ep, nowS) {
    const l = makeLabel(w.nx ? 'nx' : 'dns');
    const d = w.d;
    l.text = middleTruncate(d.q, 40);
    l.sub = w.nx ? d.rcode : (d.answers && d.answers[0]) || '';
    l.ep = ep;
    l.born = nowS;
    l.typed = 0;
    l.homeOffset = ep == null ? [(Math.random() - 0.5) * 60, (Math.random() - 0.5) * 30] : null;
    l.w = (l.text.length + l.sub.length + 2) * CHAR_W + 16;
    this.el.appendChild(l.el);
    this.dns.push(l);
  }

  update(frame, dt) {
    const nowS = performance.now() / 1000;
    const W = frame.cssWidth, H = frame.cssHeight;
    // Promote waiting DNS events whose endpoint has appeared.
    if (this.waiting.length && nowS - this.lastSpawn > SPAWN_GAP && this.dns.length < MAX_DNS) {
      for (let i = 0; i < this.waiting.length; i++) {
        const w = this.waiting[i];
        const ep = w.nx ? null : this.resolveAnchor(w.d);
        const expired = nowS - w.at > WAIT_FOR_EP;
        if (ep != null || expired || w.nx) {
          this.waiting.splice(i, 1);
          if (nowS - w.at < 6) this.spawn(w, ep, nowS);
          this.lastSpawn = nowS;
          break;
        }
      }
    }
    // Overlays labels must avoid. Rects are cached: measuring every frame would
    // force a synchronous layout per frame.
    if (!this.obstacles || nowS - this.obstaclesAt > 0.4) {
      this.obstaclesAt = nowS;
      this.obstacles = [];
      for (const id of ['banner', 'detail', 'filterchip']) {
        const el = document.getElementById(id);
        if (!el || !(el.classList.contains('show') || el.classList.contains('open'))) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0) this.obstacles.push([r.left, r.top, r.width, r.height]);
      }
      // HUD panels, unless the HUD is hidden or dimmed for cinematic mode.
      const hud = document.getElementById('hud');
      if (!hud.classList.contains('hidden') && !hud.classList.contains('cinematic')) {
        for (const el of hud.querySelectorAll('.col > .panel, .center-bottom > .panel')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) this.obstacles.push([r.left, r.top, r.width, r.height]);
        }
      }
    }
    const placed = this.obstacles.slice();
    const hs = this.world.homeScreen;

    // Home tag first: it has priority.
    const home = this.store.home;
    if (home && hs.visible) {
      const t = home.city ? `HOME · ${home.city.toUpperCase()}` : 'HOME';
      if (this.home.txt.textContent !== t) this.home.txt.textContent = t;
      this.place(this.home, hs.x, hs.y, (t.length) * 6.4 + 16, placed, W, H, 1, [[22, 14], [-22, 14], [22, -40]]);
    } else {
      this.home.el.style.opacity = '0';
    }

    // Traceroute hops: typed-out gold pins, placed before DNS labels.
    const pins = this.world.traces.labels();
    const keepPins = new Set();
    for (const pin of pins) {
      keepPins.add(pin.key);
      let l = this.pins.get(pin.key);
      if (!l) {
        l = makeLabel(pin.dest ? 'hop dest' : 'hop');
        l.typed = 0;
        l.opacity = 0;
        l.scr = { x: 0, y: 0, visible: false, front: 0 };
        this.el.appendChild(l.el);
        this.pins.set(pin.key, l);
      }
      l.typed = Math.min(pin.text.length, l.typed + dt * 55);
      const shown = pin.text.slice(0, Math.floor(l.typed));
      if (l.txt.textContent !== shown) l.txt.textContent = shown;
      const typedAll = l.typed >= pin.text.length;
      l.cur.style.display = typedAll ? 'none' : '';
      const sub = typedAll ? pin.sub : '';
      if (l.small.textContent !== sub) l.small.textContent = sub;
      l.w = (pin.text.length + pin.sub.length + 2) * 6.4 + 16;
      l.opacity = Math.min(1, l.opacity + dt * 3);
      const s = this.world.projectPoint(pin.pos, l.scr);
      const vis = s.visible ? smoothstep(0.02, 0.2, s.front) : 0;
      this.place(l, s.x, s.y, l.w, placed, W, H, l.opacity * vis);
    }
    for (const [key, l] of this.pins) {
      if (keepPins.has(key)) continue;
      l.opacity -= dt * 2;
      if (l.opacity <= 0) {
        l.el.remove();
        this.pins.delete(key);
      } else {
        l.el.style.opacity = String(l.opacity);
      }
    }

    // DNS labels.
    this.dns = this.dns.filter((l) => {
      const age = nowS - l.born;
      if (age > DNS_LIFE) {
        l.el.remove();
        return false;
      }
      let x, y, vis = 1;
      if (l.ep != null) {
        const s = this.world.screen.get(l.ep);
        if (!s) { l.ep = null; l.homeOffset = [0, 0]; }
        else {
          x = s.x; y = s.y;
          vis = s.visible ? smoothstep(0.02, 0.22, s.front) : 0;
        }
      }
      if (l.ep == null) {
        x = hs.x + l.homeOffset[0];
        y = hs.y + l.homeOffset[1];
        vis = hs.visible ? 1 : 0;
      }
      l.typed = Math.min(l.text.length, l.typed + dt * 70);
      const n = Math.floor(l.typed);
      const shown = l.text.slice(0, n);
      if (l.txt.textContent !== shown) l.txt.textContent = shown;
      const done = n >= l.text.length;
      l.cur.style.display = done && age > 1.6 ? 'none' : '';
      if (done && !l.small.textContent && l.sub) l.small.textContent = l.sub;
      const fade = Math.min(1, age / 0.15) * (1 - smoothstep(DNS_LIFE - 0.7, DNS_LIFE, age));
      this.place(l, x, y, l.w, placed, W, H, fade * vis);
      return true;
    });

    // Tags for the busiest visible endpoints (plus the selected one).
    const busy = [];
    const sel = this.world.focus.ep;
    for (const [id, s] of this.world.screen) {
      if (!s.visible || s.front < 0.15) continue;
      const ep = this.store.endpoints.get(id);
      if (!ep || this.dns.some((l) => l.ep === id)) continue;
      const r = (ep.rateIn || 0) + (ep.rateOut || 0);
      if (id === sel || ((ep.threat || 0) >= 40) || r > 2000) busy.push([id === sel ? Infinity : (ep.threat || 0) >= 40 ? 1e12 : r, id, ep]);
    }
    busy.sort((a, b) => b[0] - a[0]);
    const want = new Set(busy.slice(0, 6).map((b) => b[1]));
    for (const [, id, ep] of busy.slice(0, 6)) {
      let l = this.tags.get(id);
      if (!l) {
        l = makeLabel('tag');
        l.cur.remove();
        this.el.appendChild(l.el);
        this.tags.set(id, l);
      }
      const name = middleTruncate(ep.name || ep.ip, 26);
      const sub = rate((ep.rateIn || 0) + (ep.rateOut || 0));
      if (l.txt.textContent !== name) l.txt.textContent = name;
      if (l.small.textContent !== sub) l.small.textContent = sub;
      l.w = (name.length + sub.length + 2) * 6.2 + 16;
      const s = this.world.screen.get(id);
      l.opacity += (1 - l.opacity) * Math.min(1, dt * 4);
      this.place(l, s.x, s.y, l.w, placed, W, H, l.opacity * smoothstep(0.15, 0.3, s.front));
    }
    for (const [id, l] of this.tags) {
      if (want.has(id)) continue;
      l.opacity -= dt * 3;
      if (l.opacity <= 0) {
        l.el.remove();
        this.tags.delete(id);
      } else {
        l.el.style.opacity = String(l.opacity);
      }
    }
  }

  /** Position a label near (x, y), avoiding rectangles already placed. */
  place(l, x, y, w, placed, W, H, opacity, cands = CANDIDATES) {
    if (opacity <= 0.01 || !Number.isFinite(x)) {
      l.el.style.opacity = '0';
      return;
    }
    const rectFor = (c) => {
      const [dx, dy] = cands[c % cands.length];
      const bx = dx >= 0 ? dx : dx - w;
      return [x + bx, y + dy, w, BOX_H, dx];
    };
    const hits = (r) => r[0] < 4 || r[1] < 52 || r[0] + r[2] > W - 4 || r[1] + r[3] > H - 4 ||
      placed.some((p) => r[0] < p[0] + p[2] + 4 && r[0] + r[2] + 4 > p[0] && r[1] < p[1] + p[3] + 3 && r[1] + r[3] + 3 > p[1]);
    let r = rectFor(l.cand);
    if (hits(r)) {
      let found = null;
      for (let c = 0; c < cands.length; c++) {
        const rc = rectFor(c);
        if (!hits(rc)) { l.cand = c; found = rc; break; }
      }
      if (!found) {
        // Nowhere free: hide rather than overlap; it returns when space frees up.
        l.el.style.opacity = '0';
        return;
      }
      r = found;
    }
    placed.push(r);
    const bx = r[0] - x, by = r[1] - y;
    l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    l.el.style.opacity = String(Math.min(1, opacity));
    l.box.style.transform = `translate(${bx.toFixed(1)}px, ${by.toFixed(1)}px)`;
    // Leader from the anchor to the near edge of the box.
    const ex = r[4] >= 0 ? bx : bx + w, ey = by + BOX_H / 2;
    const len = Math.hypot(ex, ey);
    l.lead.style.width = `${len.toFixed(1)}px`;
    l.lead.style.transform = `rotate(${Math.atan2(ey, ex)}rad)`;
  }
}

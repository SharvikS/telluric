import { Placement } from './placement.js';
import { Arcs } from './arcs.js';
import { Comets } from './comets.js';
import { Markers, MK } from './markers.js';
import { Traces } from './traces.js';
import { appColor, THREAT_COLOR } from '../config.js';
import { arcLift, clamp, dot3, len3, project, DEG } from '../util/math.js';

const HOME_COLOR = [0.55, 0.95, 1.0];
const SEV_RING = { info: [0.37, 0.95, 1.0], low: [0.6, 0.9, 0.4], medium: [1.0, 0.82, 0.25], high: [1.0, 0.55, 0.26], critical: [1.0, 0.16, 0.26] };
const MAX_SPAWN_PER_FRAME = 700;
// Per endpoint and direction, comets are rate-limited by a token bucket; bytes
// from throttled shots are carried into the next comet, so a 50 MB/s download
// reads as a stream of fat, bright comets instead of a solid white bar.
const COMET_RATE = 14; // comets per second per endpoint and direction (long arcs)
const COMET_BURST = 5;
// Hard cap on comets in flight per endpoint and direction: a 20 MB/s download
// must read as "busy", never as a solid laser beam.
const MAX_INFLIGHT = 7;
const STRESS = new URLSearchParams(location.search).has('stress');

/**
 * Binds the store to the GPU layers: arcs per endpoint, comets per packet
 * shot, markers, ripples and alert shockwaves, plus the country heat map.
 * Also maintains per-frame screen positions for labels and picking.
 */
export class World {
  constructor(renderer, store, world) {
    this.renderer = renderer;
    this.store = store;
    this.geo = world;
    this.placement = new Placement();
    this.arcs = renderer.addLayer(new Arcs(renderer.gl));
    this.markers = renderer.addLayer(new Markers(renderer.gl));
    this.comets = renderer.addLayer(new Comets(renderer.gl));
    this.traces = new Traces(renderer, this);
    this.lastFrame = null;
    this.time = 0;
    this.t0 = performance.now();
    this.pending = [];
    this.screen = new Map(); // ep id → { x, y, visible, pos }
    this.homeScreen = { x: 0, y: 0, visible: false };
    this.heatAt = 0;
    this.speed = 1;
    this.focus = { active: false, ep: 0, proc: 0, cc: null, procEps: null };
    this.spawnedThisFrame = 0;
    this.droppedShots = 0;
    this.buckets = new Map(); // ep id * 2 + dir → { tokens, at, bytes, pkts }

    store.on('reset', () => this.reset());
    store.on('home', (h) => this.placement.setHome(h));
    store.on('ep', (ep, isNew) => {
      this.arcs.add(ep, this.now());
      if (isNew && performance.now() - this.t0 > 1500) {
        const p = this.placement.position(ep, this.now());
        this.markers.pulse(p, MK.RIPPLE, appColor(ep._app), 0.05, this.now(), 1.6, 1.2);
      }
    });
    store.on('ep-gone', (ep) => this.arcs.remove(ep.id, this.now()));
    store.on('flow', (flow, isNew) => {
      if (!isNew) return;
      const ep = store.endpoints.get(flow.ep);
      if (!ep) return;
      const p = this.placement.position(ep, this.now());
      this.markers.pulse(p, MK.RIPPLE, appColor(flow.app), 0.028, this.now(), 1.1, 0.8);
    });
    store.on('alert', (a, isNew) => {
      if (!isNew) return;
      const ep = a.ep ? store.endpoints.get(a.ep) : null;
      const p = ep ? this.placement.position(ep, this.now()) : this.placement.home;
      const col = SEV_RING[a.sev] || SEV_RING.medium;
      const big = a.sev === 'critical' || a.sev === 'high';
      this.markers.pulse(p, MK.ALERT, col, big ? 0.16 : 0.09, this.now(), big ? 3.2 : 2.2, big ? 1.6 : 1.0);
      if (big) this.markers.pulse(p, MK.ALERT, col, 0.26, this.now() + 0.35, 3.4, 1.0);
    });
    store.on('pkts', (batch) => this.onPackets(batch));
    store.on('trace', (tr, isNew) => this.traces.onTrace(tr, isNew, this.now()));
    store.on('trace-gone', (tr) => this.traces.onGone(tr, this.now()));
  }

  now() {
    return (performance.now() - this.t0) / 1000;
  }

  reset() {
    for (const id of [...this.arcs.items.keys()]) this.arcs.items.delete(id);
    this.pending.length = 0;
    this.buckets.clear();
    this.traces.clear();
    this.screen.clear();
  }

  onPackets(batch) {
    const t = this.now();
    for (let i = 0; i < batch.count; i++) {
      if (!this.spawnShot(batch.flow[i], batch.bytes[i], batch.pkts[i], batch.flags[i], t + batch.dt[i] / 1000)) {
        if (this.pending.length < 4000) this.pending.push([batch.flow[i], batch.bytes[i], batch.pkts[i], batch.flags[i], t + batch.dt[i] / 1000, t]);
      }
    }
  }

  /** Returns false if the flow or endpoint is not known yet. */
  spawnShot(flowId, bytes, pkts, flags, birth) {
    const flow = this.store.flows.get(flowId);
    if (!flow) return false;
    const ep = this.store.endpoints.get(flow.ep);
    if (!ep) return false;
    if (!this.placement.hasHome) return true;
    const inbound = (flags & 1) === 1;
    const item = this.arcs.items.get(ep.id) || this.arcs.add(ep, this.now());
    const b = this.placement.position(ep, birth, item.pos);
    const a = this.placement.home;
    const geo = !Placement.orbits(ep);
    const theta = Math.acos(clamp(dot3(a, b) / (len3(b) || 1), -1, 1));
    const key = ep.id * 2 + (inbound ? 1 : 0);
    let bk = this.buckets.get(key);
    if (!bk) this.buckets.set(key, (bk = { tokens: COMET_BURST, at: birth, bytes: 0, pkts: 0, inflight: [] }));
    // Short arcs get proportionally fewer comets, so they stay discrete.
    const rate = STRESS ? 60 : geo ? clamp(3 + COMET_RATE * (theta / 0.7), 3, COMET_RATE) : 4;
    bk.tokens = Math.min(COMET_BURST, bk.tokens + Math.max(0, birth - bk.at) * rate);
    bk.at = Math.max(bk.at, birth);
    bk.bytes += bytes;
    bk.pkts += pkts;
    while (bk.inflight.length && bk.inflight[0] <= birth) bk.inflight.shift();
    const full = !STRESS && bk.inflight.length >= MAX_INFLIGHT;
    if (bk.tokens < 1 || full || this.spawnedThisFrame >= MAX_SPAWN_PER_FRAME) {
      if (this.spawnedThisFrame >= MAX_SPAWN_PER_FRAME) this.droppedShots++;
      return true;
    }
    bk.tokens -= 1;
    bytes = bk.bytes;
    pkts = bk.pkts;
    bk.bytes = 0;
    bk.pkts = 0;
    this.spawnedThisFrame++;
    const lift = geo ? arcLift(theta) : 0.012;
    const lb = Math.log2(Math.max(bytes, 1));
    const sizeK = clamp(lb - 6, 0, 11);
    const px = this.renderer.dpr * this.renderer.scale;
    // Size and brightness grow with log(bytes) but have ceilings.
    const size = Math.min(0.8 + 0.22 * sizeK, 3.0) * px;
    const bright = Math.min(0.30 + 0.05 * sizeK, 0.82);
    const threat = (flow.threat || 0) > 0 || (ep.threat || 0) >= 40;
    const color = threat ? THREAT_COLOR : appColor(flow.app);
    const dimmed = this.focus.active && !this.matchesFocus(ep);
    const duration = geo ? (0.55 + 1.55 * (theta / Math.PI)) / this.speed : 0.6 / this.speed;
    const tail = geo ? clamp(0.18 / Math.max(theta, 0.05), 0.06, 0.26) : 0.3;
    if (!STRESS) bk.inflight.push(birth + duration * (1 + tail));
    this.comets.spawn(a, b, lift, color, size, dimmed ? bright * 0.12 : bright, birth, duration, inbound, tail);
    this.arcs.flash(ep.id, 0.02 + 0.006 * sizeK);
    return true;
  }

  frame(frame, dt) {
    this.time = frame.time;
    this.spawnedThisFrame = 0;
    // Retry shots that arrived before their flow.
    if (this.pending.length) {
      const keep = [];
      for (const s of this.pending) {
        if (frame.time - s[5] > 1) continue;
        if (!this.spawnShot(s[0], s[1], s[2], s[3], Math.max(s[4], frame.time))) keep.push(s);
      }
      this.pending = keep;
    }
    frame.focus = this.focus;
    frame.hasHome = this.placement.hasHome;
    frame.home = this.placement.home;
    this.lastFrame = frame;
    this.arcs.update(frame, this.placement, this.store, dt);
    this.traces.frame(frame);
    this.buildMarkers(frame);
    this.updateScreen(frame);
    if (frame.time - this.heatAt > 0.5) {
      this.heatAt = frame.time;
      this.updateHeat();
    }
  }

  buildMarkers(frame) {
    const m = this.markers;
    const t = frame.time;
    const px = frame.pxScale;
    m.begin();
    let anyLocal = false, anyUnlocated = false;
    for (const [id, it] of this.arcs.items) {
      const ep = it.ep;
      if (it.death) continue;
      const kind = Placement.kind(ep);
      if (kind === 'local') anyLocal = true;
      else if (kind === 'unlocated') anyUnlocated = true;
      const rate = (ep.rateIn || 0) + (ep.rateOut || 0);
      const act = clamp((Math.log10(1 + rate) - 2) / 5, 0, 1);
      const threat = Math.max(ep.threat || 0, ep._flowThreat || 0) >= 40;
      const col = threat ? THREAT_COLOR : appColor(ep._app);
      const sel = this.focus.ep === id;
      const dim = this.focus.active && !this.matchesFocus(ep) ? 0.15 : 1;
      m.push(it.pos, MK.DOT, col, (0.55 + 0.9 * act + Math.min(0.8, it.flash)) * dim, (3.2 + 4.5 * act + (sel ? 4 : 0)) * px);
      if (act > 0.12 && kind === 'geo') m.push(it.pos, MK.BEAM, col, (0.35 + 0.6 * act) * dim, 1.25 * px, 0, 0, 0.015 + 0.11 * act);
      if (sel) m.push(it.pos, MK.RIPPLE, [0.8, 1.0, 1.0], 1.0, 0.035, t - (t % 1.4), 1.4);
      if (threat) m.push(it.pos, MK.RIPPLE, THREAT_COLOR, 0.9, 0.04, t - ((t + id * 0.37) % 1.8), 1.8);
    }
    if (this.placement.hasHome) {
      const h = this.placement.home;
      m.push(h, MK.HOME, HOME_COLOR, 1.0, 22 * px);
      m.push(h, MK.BEAM, HOME_COLOR, 0.9, 1.6 * px, 0, 0, 0.07);
      if (anyLocal) {
        const r = 2.75 * DEG, alt = 1.041;
        const c = [h[0] * Math.cos(r) * alt, h[1] * Math.cos(r) * alt, h[2] * Math.cos(r) * alt];
        m.push(c, MK.ORBIT, [0.45, 0.8, 1.0], 0.55, Math.sin(r) * alt, 0, 0, 1.2);
      }
      if (anyUnlocated) {
        const r = 5.4 * DEG, alt = 1.085;
        const c = [h[0] * Math.cos(r) * alt, h[1] * Math.cos(r) * alt, h[2] * Math.cos(r) * alt];
        m.push(c, MK.ORBIT, [0.7, 0.75, 0.9], 0.45, Math.sin(r) * alt, 0, 0, 0.8);
      }
    }
    this.traces.pushMarkers(m, t, px);
    m.end(t);
  }

  matchesFocus(ep) {
    const f = this.focus;
    return (f.ep && f.ep === ep.id) || (f.cc && ep.cc === f.cc) || (f.proc && f.procEps && f.procEps.has(ep.id));
  }

  /** Projects endpoints to CSS pixels and tests them against the globe's horizon. */
  updateScreen(frame) {
    const cam = frame.camera;
    const W = frame.cssWidth, H = frame.cssHeight;
    const eye = cam.eye;
    const seen = new Set();
    const tmp = [0, 0, 0, 0];
    for (const [id, it] of this.arcs.items) {
      seen.add(id);
      let s = this.screen.get(id);
      if (!s) this.screen.set(id, (s = { x: 0, y: 0, visible: false, front: 0 }));
      const p = it.pos;
      const r = project(cam.viewProj, p, W, H, tmp);
      if (!r) { s.visible = false; continue; }
      s.x = r[0];
      s.y = r[1];
      s.visible = !this.occluded(eye, p) && !it.death;
      // How squarely the point faces the camera (for label fading near the limb).
      const lp = len3(p) || 1;
      s.front = ((eye[0] - p[0]) * p[0] + (eye[1] - p[1]) * p[1] + (eye[2] - p[2]) * p[2]) / (lp * (Math.hypot(eye[0] - p[0], eye[1] - p[1], eye[2] - p[2]) || 1));
    }
    for (const id of this.screen.keys()) if (!seen.has(id)) this.screen.delete(id);
    if (this.placement.hasHome) {
      const r = project(cam.viewProj, this.placement.home, W, H, tmp);
      this.homeScreen.visible = !!r && !this.occluded(eye, this.placement.home);
      if (r) { this.homeScreen.x = r[0]; this.homeScreen.y = r[1]; }
    }
  }

  /** Screen position (CSS px) of an arbitrary world point, with horizon test. */
  projectPoint(p, out = { x: 0, y: 0, visible: false, front: 0 }) {
    const f = this.lastFrame;
    if (!f) { out.visible = false; return out; }
    const cam = f.camera;
    const r = project(cam.viewProj, p, f.cssWidth, f.cssHeight, this._tmp || (this._tmp = [0, 0, 0, 0]));
    if (!r) { out.visible = false; return out; }
    out.x = r[0];
    out.y = r[1];
    out.visible = !this.occluded(cam.eye, p);
    const eye = cam.eye, lp = len3(p) || 1;
    out.front = ((eye[0] - p[0]) * p[0] + (eye[1] - p[1]) * p[1] + (eye[2] - p[2]) * p[2]) / (lp * (Math.hypot(eye[0] - p[0], eye[1] - p[1], eye[2] - p[2]) || 1));
    return out;
  }

  occluded(eye, p) {
    const dx = p[0] - eye[0], dy = p[1] - eye[1], dz = p[2] - eye[2];
    const dist = Math.hypot(dx, dy, dz);
    const d0 = dx / dist, d1 = dy / dist, d2 = dz / dist;
    const b = eye[0] * d0 + eye[1] * d1 + eye[2] * d2;
    const c = eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2] - 1;
    const h = b * b - c;
    if (h < 0) return false;
    const t = -b - Math.sqrt(h);
    return t > 0 && t < dist - 2e-3;
  }

  updateHeat() {
    const rows = this.store.countries();
    const max = rows.length ? Math.max(...rows.map((c) => c.rate)) : 0;
    const heat = new Map();
    for (const c of rows) {
      const country = this.geo.byIso2.get(c.cc);
      if (!country) continue;
      const h = max > 0 ? Math.log10(1 + c.rate) / Math.log10(1 + max) : 0;
      heat.set(country.id, clamp(0.12 + 0.88 * h * h, 0, 1) * (c.rate > 50 ? 1 : 0.35));
    }
    this.renderer.globe.setHeat(heat);
  }

  /** Nearest visible endpoint within `radius` CSS px of (x, y). */
  pick(x, y, radius = 14) {
    let best = null, bestD = radius * radius;
    for (const [id, s] of this.screen) {
      if (!s.visible) continue;
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }
}

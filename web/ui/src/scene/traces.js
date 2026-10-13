import { Arcs } from './arcs.js';
import { MK } from './markers.js';
import { arcLift, latLonToVec3, clamp } from '../util/math.js';

// Traceroute paths ("hacker-movie moment"): when the machine runs mtr or
// traceroute, the engine reconstructs the route hop by hop. We draw it as a
// gold path through the located hops, segment by segment as hops answer,
// with hop beacons, a pulse train racing along it, and labels such as
// "6 · New York · 82 ms". LAN hops sit at home; hops that cannot be located
// are skipped (the path joins the hops either side of them).

const GOLD = [1.0, 0.78, 0.38];
const GOLD_HOT = [1.0, 0.9, 0.62];
const SEG_STAGGER = 0.32; // seconds between consecutive segment reveals
const PULSE_EVERY = 2.2;
const FADE = 1.4;

export class Traces {
  constructor(renderer, world) {
    this.renderer = renderer;
    this.world = world;
    this.ribbons = renderer.addLayer(new Arcs(renderer.gl));
    this.ribbons.width = 1.15;
    this.items = new Map(); // trace id → state
  }

  clear() {
    this.items.clear();
    this.ribbons.setInstances([]);
  }

  onTrace(tr, isNew, now) {
    let st = this.items.get(tr.id);
    if (!st) {
      st = { tr, born: now, death: 0, seen: new Map(), segBirth: new Map(), lastPulse: now + 0.6, path: [], doneAt: 0 };
      this.items.set(tr.id, st);
    }
    st.tr = tr;
    st.death = 0;
    if (tr.done && !st.doneAt) st.doneAt = now;
    this.rebuild(st, now);
  }

  onGone(tr, now) {
    const st = this.items.get(tr.id);
    if (st && !st.death) st.death = now;
  }

  /** Path points: home first, then located hops in TTL order, co-located hops merged. */
  rebuild(st, now) {
    const pl = this.world.placement;
    const home = pl.home;
    const pts = [{ key: 'home', pos: Float32Array.from(home), hops: [], n: 0 }];
    for (const h of st.tr.hops || []) {
      let pos = null;
      if (h.lat != null && h.lon != null) pos = latLonToVec3(h.lat, h.lon);
      else if (h.scope === 'lan' || h.scope === 'local') pos = home;
      if (!pos) continue;
      const last = pts[pts.length - 1];
      const d = Math.hypot(last.pos[0] - pos[0], last.pos[1] - pos[1], last.pos[2] - pos[2]);
      if (d < 2e-3) {
        last.hops.push(h);
        continue;
      }
      pts.push({ key: `n${h.n}`, pos: Float32Array.from(pos), hops: [h], n: h.n });
    }
    for (const p of pts) {
      if (p.key === 'home' || st.seen.has(p.key)) continue;
      st.seen.set(p.key, now);
      this.world.markers.pulse(p.pos, MK.RIPPLE, GOLD, 0.05, now, 1.5, 1.6);
    }
    // Segment births: each appears when its far hop answers, never sooner than
    // SEG_STAGGER after the previous one, so the route "draws itself".
    let prev = -1;
    for (let i = 1; i < pts.length; i++) {
      const key = `${pts[i - 1].key}>${pts[i].key}`;
      let b = st.segBirth.get(key);
      if (b == null) {
        b = Math.max(st.seen.get(pts[i].key) || now, prev + SEG_STAGGER);
        st.segBirth.set(key, b);
      }
      prev = b;
    }
    st.path = pts;
  }

  segments(st) {
    const out = [];
    const p = st.path;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1].pos, b = p[i].pos;
      const theta = Math.acos(clamp((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b)), -1, 1));
      out.push({ a, b, theta, lift: arcLift(theta) * 0.55, birth: st.segBirth.get(`${p[i - 1].key}>${p[i].key}`) });
    }
    return out;
  }

  frame(frame) {
    const t = frame.time;
    const list = [];
    for (const [id, st] of this.items) {
      if (st.death && t - st.death > FADE + 0.3) {
        this.items.delete(id);
        continue;
      }
      const segs = this.segments(st);
      for (const s of segs) {
        list.push({ a: s.a, b: s.b, lift: s.lift, color: GOLD, intensity: 1, birth: s.birth, death: st.death, dirBias: -1, highlight: 1, flash: 0.35, seed: id * 0.37 });
      }
      // Pulse train racing from home to the farthest answered hop.
      if (!st.death && segs.length && t - st.lastPulse > PULSE_EVERY) {
        st.lastPulse = t;
        let start = t;
        const px = frame.pxScale;
        for (const s of segs) {
          if (s.birth > t) break;
          const dur = 0.2 + 0.9 * (s.theta / Math.PI);
          this.world.comets.spawn(s.a, s.b, s.lift, GOLD_HOT, 3.4 * px, 1.25, start, dur, false, 0.35);
          start += dur * 0.94;
        }
      }
    }
    this.ribbons.setInstances(list);
  }

  /** Hop beacons, pushed into the shared marker batch each frame. */
  pushMarkers(m, t, px) {
    for (const st of this.items.values()) {
      const fade = st.death ? clamp(1 - (t - st.death) / FADE, 0, 1) : 1;
      if (fade <= 0) continue;
      const last = st.path.length - 1;
      st.path.forEach((p, i) => {
        if (i === 0) return;
        const seen = st.seen.get(p.key) || 0;
        if (t < seen) return;
        const dest = i === last && st.tr.done;
        m.push(p.pos, MK.DOT, dest ? GOLD_HOT : GOLD, (dest ? 1.5 : 1.05) * fade, (dest ? 7 : 4.6) * px);
        if (dest) m.push(p.pos, MK.RIPPLE, GOLD_HOT, 0.9 * fade, 0.05, t - (t % 1.6), 1.6);
      });
    }
  }

  /** Label pins for located hops: { key, pos, text, sub, dest }. */
  labels() {
    const out = [];
    for (const [id, st] of this.items) {
      if (st.death) continue;
      const last = st.path.length - 1;
      st.path.forEach((p, i) => {
        if (i === 0) return;
        const h = p.hops[p.hops.length - 1];
        if (!h || h.scope !== 'public') return;
        const dest = i === last && st.tr.done;
        const place = h.city || h.org || h.ip;
        const rtt = h.rtt != null ? `${h.rtt < 10 ? h.rtt.toFixed(1) : Math.round(h.rtt)} ms` : '';
        out.push({
          key: `t${id}-${p.key}`,
          pos: p.pos,
          born: st.seen.get(p.key) || 0,
          text: dest ? `${h.n} · ${st.tr.name || h.name || h.ip}` : `${h.n} · ${place}`,
          sub: dest ? [h.city, rtt].filter(Boolean).join(' · ') : rtt,
          dest,
        });
      });
    }
    return out;
  }

  /** Bounding geometry of a trace for framing the camera: [midpoint dir, angular span]. */
  frameOf(id) {
    const st = this.items.get(id);
    if (!st || st.path.length < 2) return null;
    const s = [0, 0, 0];
    for (const p of st.path) { s[0] += p.pos[0]; s[1] += p.pos[1]; s[2] += p.pos[2]; }
    const l = Math.hypot(...s) || 1;
    const c = [s[0] / l, s[1] / l, s[2] / l];
    let span = 0;
    for (const p of st.path) span = Math.max(span, Math.acos(clamp(c[0] * p.pos[0] + c[1] * p.pos[1] + c[2] * p.pos[2], -1, 1)));
    return [c, span];
  }
}

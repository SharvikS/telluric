import { fitCanvas } from './charts.js';
import { appColor, cssColor, THREAT_COLOR } from '../config.js';
import { Placement } from '../scene/placement.js';
import { DEG, latLonToVec3, vec3ToLatLon, clamp } from '../util/math.js';

/**
 * Flat equirectangular overview: land as a dot matrix, great-circle arcs from
 * home, endpoints, and the camera's visible-hemisphere footprint. Click to fly.
 */
export class Minimap {
  constructor(cv, geo, store, world, camera, { onPick }) {
    this.cv = cv;
    this.geo = geo;
    this.store = store;
    this.world = world;
    this.camera = camera;
    this.land = null;
    this.size = [0, 0];
    this.last = 0;
    this.countEl = document.getElementById('c-world');
    this.paths = new Map(); // ep id → Float32Array of [lon, lat] samples (cached: geo is static)
    this.pathHome = '';
    cv.addEventListener('click', (e) => {
      const r = cv.getBoundingClientRect();
      const { x0, y0, mw, mh } = this.box(r.width, r.height);
      const lon = ((e.clientX - r.left - x0) / mw) * 360 - 180;
      const lat = 90 - ((e.clientY - r.top - y0) / mh) * 180;
      if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) onPick(lat, lon);
    });
  }

  /** Map rectangle inside the canvas (2:1, centred), in the given units. */
  box(w, h) {
    let mw = w, mh = w / 2;
    if (mh > h) { mh = h; mw = h * 2; }
    return { x0: (w - mw) / 2, y0: (h - mh) / 2, mw, mh };
  }

  buildLand(w, h, dpr) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const { data, width: lw, height: lh } = this.geo.landMask;
    const { x0, y0, mw, mh } = this.box(w, h);
    const step = Math.max(2.5 * dpr, mw / 150);
    const r = Math.max(0.6, step * 0.28);
    ctx.fillStyle = 'rgba(70, 200, 230, 0.42)';
    for (let y = y0 + step / 2; y < y0 + mh; y += step) {
      for (let x = x0 + step / 2; x < x0 + mw; x += step) {
        const u = Math.floor(((x - x0) / mw) * lw), v = Math.floor(((y - y0) / mh) * lh);
        if (data[v * lw + u]) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.strokeStyle = 'rgba(94, 242, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, mw - 1, mh - 1);
    ctx.beginPath();
    ctx.moveTo(x0, y0 + mh / 2);
    ctx.lineTo(x0 + mw, y0 + mh / 2);
    ctx.stroke();
    this.land = c;
  }

  update(now) {
    if (now - this.last < 100) return;
    this.last = now;
    const [w, h, dpr] = fitCanvas(this.cv);
    if (!this.land || this.size[0] !== w || this.size[1] !== h) {
      this.size = [w, h];
      this.buildLand(w, h, dpr);
    }
    const ctx = this.cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.land, 0, 0);
    const { x0, y0, mw, mh } = this.box(w, h);
    const X = (lon) => x0 + ((lon + 180) / 360) * mw;
    const Y = (lat) => y0 + ((90 - lat) / 180) * mh;
    const pl = this.world.placement;
    const t = this.world.time;

    // Camera footprint: the small circle of the visible cap.
    const cam = this.camera;
    const capR = Math.acos(clamp(1 / cam.dist, -1, 1));
    ctx.strokeStyle = 'rgba(94, 242, 255, 0.35)';
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.lineWidth = dpr;
    this.circle(ctx, cam.lat, cam.lon, capR, X, Y, mw);
    ctx.setLineDash([]);

    let n = 0;
    if (pl.hasHome) {
      const [hl, hn] = pl.homeLL;
      const homeKey = `${hl},${hn}`;
      if (homeKey !== this.pathHome) {
        this.paths.clear();
        this.pathHome = homeKey;
      }
      const a = latLonToVec3(hl, hn);
      const b = new Float32Array(3);
      ctx.lineWidth = Math.max(1, 1.1 * dpr);
      const located = [];
      for (const [, it] of this.world.arcs.items) {
        if (it.death || Placement.orbits(it.ep)) continue;
        const ep = it.ep;
        located.push([(ep.rateIn || 0) + (ep.rateOut || 0) + ((ep.threat || 0) >= 40 ? 1e12 : 0), ep]);
      }
      n = located.length;
      // Draw the busiest 300 arcs; everything else is just a dot.
      if (located.length > 300) located.sort((x, y) => y[0] - x[0]);
      located.forEach(([, ep], i) => {
        const rate = (ep.rateIn || 0) + (ep.rateOut || 0);
        const k = clamp((Math.log10(1 + rate) - 2) / 5, 0, 1);
        const threat = (ep.threat || 0) >= 40;
        const rgb = threat ? THREAT_COLOR : appColor(ep._app);
        if (i < 300) {
          let pts = this.paths.get(ep.id);
          if (!pts) {
            latLonToVec3(ep.lat, ep.lon, 1, b);
            pts = this.samplePath(a, b);
            this.paths.set(ep.id, pts);
          }
          ctx.strokeStyle = cssColor(rgb, 0.18 + 0.7 * k);
          this.strokePath(ctx, pts, X, Y, mw);
        }
        ctx.fillStyle = cssColor(rgb, 0.6 + 0.4 * k);
        ctx.fillRect(X(ep.lon) - (1 + k) * dpr, Y(ep.lat) - (1 + k) * dpr, (2 + 2 * k) * dpr, (2 + 2 * k) * dpr);
      });
      if (this.paths.size > 4 * Math.max(300, located.length)) this.paths.clear();
      const pulse = (t % 1.6) / 1.6;
      ctx.strokeStyle = `rgba(160, 250, 255, ${1 - pulse})`;
      ctx.beginPath();
      ctx.arc(X(hn), Y(hl), (2 + 9 * pulse) * dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#e8fdff';
      ctx.beginPath();
      ctx.arc(X(hn), Y(hl), 2.4 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    // Camera centre crosshair.
    const cx = X(cam.lon), cy = Y(cam.lat);
    ctx.strokeStyle = 'rgba(94, 242, 255, 0.7)';
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(cx - 5 * dpr, cy); ctx.lineTo(cx + 5 * dpr, cy);
    ctx.moveTo(cx, cy - 5 * dpr); ctx.lineTo(cx, cy + 5 * dpr);
    ctx.stroke();
    if (this.countEl) this.countEl.textContent = n ? `${n} located` : '';
  }

  /** Great circle a→b sampled as [lon, lat] pairs. */
  samplePath(a, b) {
    const N = 28;
    const out = new Float32Array((N + 1) * 2);
    const th = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
    const s = Math.sin(th) || 1;
    for (let i = 0; i <= N; i++) {
      const tt = i / N;
      const wa = th < 1e-4 ? 1 - tt : Math.sin((1 - tt) * th) / s;
      const wb = th < 1e-4 ? tt : Math.sin(tt * th) / s;
      const [lat, lon] = vec3ToLatLon([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
      out[i * 2] = lon;
      out[i * 2 + 1] = lat;
    }
    return out;
  }

  /** Strokes a sampled path, breaking it where it crosses the antimeridian. */
  strokePath(ctx, pts, X, Y, mw) {
    let px = null;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      const x = X(pts[i]), y = Y(pts[i + 1]);
      if (px === null || Math.abs(x - px) > mw / 2) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      px = x;
    }
    ctx.stroke();
  }

  circle(ctx, lat, lon, r, X, Y, mw) {
    const c = latLonToVec3(lat, lon);
    const e = [Math.cos(lon * DEG), 0, -Math.sin(lon * DEG)];
    const n = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
    let px = null;
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a), cr = Math.cos(r), sr = Math.sin(r);
      const p = [c[0] * cr + (e[0] * ca + n[0] * sa) * sr, c[1] * cr + (e[1] * ca + n[1] * sa) * sr, c[2] * cr + (e[2] * ca + n[2] * sa) * sr];
      const [la, lo] = vec3ToLatLon(p);
      const x = X(lo), y = Y(la);
      if (px === null || Math.abs(x - px) > mw / 2) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      px = x;
    }
    ctx.stroke();
  }
}

import { DEG, latLonToVec3, normalize3, cross3, hash01 } from '../util/math.js';

/**
 * Where things are in 3D. Located public endpoints sit on the globe; LAN and
 * multicast endpoints orbit low above the home beacon ("local constellation");
 * public endpoints that could not be located orbit higher on the "UNLOCATED"
 * ring. Orbits make it obvious these points are not real places on the map.
 */
export class Placement {
  constructor() {
    this.hasHome = false;
    this.homeLL = [0, 0];
    this.home = new Float32Array([0, 0, 1]);
    this.east = new Float32Array([1, 0, 0]);
    this.north = new Float32Array([0, 1, 0]);
  }

  setHome(home) {
    this.hasHome = !!home;
    const lat = home ? home.lat : 0, lon = home ? home.lon : 0;
    this.homeLL = [lat, lon];
    latLonToVec3(lat, lon, 1, this.home);
    cross3([0, 1, 0], this.home, this.east);
    if (Math.hypot(this.east[0], this.east[1], this.east[2]) < 1e-6) this.east.set([1, 0, 0]);
    normalize3(this.east);
    cross3(this.home, this.east, this.north);
  }

  static kind(ep) {
    if (ep.scope === 'public' && ep.lat != null && ep.lon != null) return 'geo';
    if (ep.scope === 'public') return 'unlocated';
    return 'local';
  }

  static orbits(ep) {
    return Placement.kind(ep) !== 'geo';
  }

  /** Orbit parameters for non-geographic endpoints. */
  orbit(ep) {
    const h1 = hash01(ep.id * 7919 + 1), h2 = hash01(ep.id * 104729 + 7), h3 = hash01(ep.id * 1299709 + 3);
    if (Placement.kind(ep) === 'local') {
      return { radius: (2.2 + 1.1 * h2) * DEG, alt: 0.030 + 0.022 * h3, phase: h1 * Math.PI * 2, speed: 0.12 + 0.08 * h2 };
    }
    return { radius: 5.4 * DEG, alt: 0.085, phase: h1 * Math.PI * 2, speed: 0.035 };
  }

  /** Position of an endpoint at time t (seconds), written into `out`. */
  position(ep, t, out = new Float32Array(3)) {
    if (Placement.kind(ep) === 'geo') return latLonToVec3(ep.lat, ep.lon, 1, out);
    const o = this.orbit(ep);
    const a = o.phase + t * o.speed;
    return this.ringPoint(o.radius, a, 1 + o.alt, out);
  }

  /** A point on a circle of angular radius `r` around home, at azimuth `a`. */
  ringPoint(r, a, radius, out = new Float32Array(3)) {
    const cr = Math.cos(r), sr = Math.sin(r), ca = Math.cos(a), sa = Math.sin(a);
    const h = this.home, e = this.east, n = this.north;
    out[0] = (h[0] * cr + (e[0] * ca + n[0] * sa) * sr) * radius;
    out[1] = (h[1] * cr + (e[1] * ca + n[1] * sa) * sr) * radius;
    out[2] = (h[2] * cr + (e[2] * ca + n[2] * sa) * sr) * radius;
    return out;
  }
}

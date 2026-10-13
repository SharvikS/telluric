import {
  DEG, clamp, angleDelta, easeInOutCubic, latLonToVec3, mat4, perspective, lookAt, multiply, invert,
} from '../util/math.js';

const MIN_DIST = 1.32;
const MAX_DIST = 7.5;
const MAX_LAT = 80;

/**
 * Orbit camera around the globe. State is the geographic point under the
 * view centre (lat, lon) and the distance from the globe centre in globe
 * radii. Everything is smoothed: user input moves targets, update() eases.
 */
export class Camera {
  constructor() {
    this.fov = 34 * DEG;
    this.lat = 20;
    this.lon = 10;
    this.dist = 3.6;
    this.targetDist = this.dist;
    this.vLat = 0; // inertia, degrees per second
    this.vLon = 0;
    this.autoRotate = true;
    this.autoSpeed = 2.4; // degrees per second
    this.idleTime = 10;
    this.fly = null;
    this.shakeAmp = 0;
    this.offset = [0, 0]; // NDC lens shift for HUD-aware composition
    this.width = 1;
    this.height = 1;

    this.eye = new Float32Array(3);
    this.view = mat4();
    this.proj = mat4();
    this.viewProj = mat4();
    this.invViewProj = mat4();
  }

  setViewport(w, h) {
    this.width = w;
    this.height = h;
  }

  /** Globe radius on screen in CSS pixels at the current distance. */
  globeRadiusPx() {
    const d = Math.max(this.dist, 1.0001);
    return (this.height / 2) / Math.tan(this.fov / 2) / Math.sqrt(d * d - 1);
  }

  /** Drag by a pixel delta; the surface under the cursor follows it. */
  dragBy(dx, dy, dt) {
    const r = this.globeRadiusPx();
    const dLon = -(dx / r) / DEG / Math.max(Math.cos(this.lat * DEG), 0.25);
    const dLat = (dy / r) / DEG;
    this.lon += dLon;
    this.lat = clamp(this.lat + dLat, -MAX_LAT, MAX_LAT);
    if (dt > 0) {
      const k = 0.35;
      this.vLon = this.vLon * (1 - k) + (dLon / dt) * k;
      this.vLat = this.vLat * (1 - k) + (dLat / dt) * k;
    }
    this.fly = null;
    this.idleTime = 0;
  }

  zoomBy(factor) {
    this.targetDist = clamp(this.targetDist * factor, MIN_DIST, MAX_DIST);
    this.idleTime = 0;
    if (this.fly) this.fly.toDist = this.targetDist;
  }

  stopInertia() {
    this.vLat = 0;
    this.vLon = 0;
  }

  /** Smoothly move so that (lat, lon) is centred at distance `dist`. */
  flyTo(lat, lon, dist = this.targetDist, duration = 1.6) {
    this.fly = {
      t: 0,
      duration,
      fromLat: this.lat,
      fromLon: this.lon,
      fromDist: this.dist,
      toLat: clamp(lat, -MAX_LAT, MAX_LAT),
      dLon: angleDelta(this.lon, lon),
      toDist: clamp(dist, MIN_DIST, MAX_DIST),
    };
    this.targetDist = this.fly.toDist;
    this.stopInertia();
  }

  shake(amount) {
    this.shakeAmp = Math.max(this.shakeAmp, amount);
  }

  update(dt, interacting) {
    if (!interacting) this.idleTime += dt;
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.duration);
      const e = easeInOutCubic(f.t);
      this.lat = f.fromLat + (f.toLat - f.fromLat) * e;
      this.lon = f.fromLon + f.dLon * e;
      // Pull back a little mid-flight for a sense of travel.
      const hop = Math.sin(Math.PI * e) * Math.min(1.2, Math.abs(f.dLon) / 90 + Math.abs(f.toLat - f.fromLat) / 120);
      this.dist = f.fromDist + (f.toDist - f.fromDist) * e + hop;
      if (f.t >= 1) {
        this.fly = null;
        this.dist = f.toDist;
      }
    } else {
      if (!interacting) {
        const decay = Math.exp(-dt * 3.2);
        this.vLat *= decay;
        this.vLon *= decay;
        this.lon += this.vLon * dt;
        this.lat = clamp(this.lat + this.vLat * dt, -MAX_LAT, MAX_LAT);
        if (this.autoRotate && this.idleTime > 2.5) {
          const ramp = clamp((this.idleTime - 2.5) / 2, 0, 1);
          this.lon -= this.autoSpeed * ramp * dt;
        }
      }
      this.dist += (this.targetDist - this.dist) * (1 - Math.exp(-dt * 7));
    }
    this.lon = ((this.lon + 540) % 360) - 180;
    this.shakeAmp *= Math.exp(-dt * 5);
    this.computeMatrices();
  }

  computeMatrices() {
    let lat = this.lat, lon = this.lon;
    if (this.shakeAmp > 1e-3) {
      const t = performance.now() / 1000;
      lat += Math.sin(t * 61.0) * this.shakeAmp;
      lon += Math.cos(t * 47.0) * this.shakeAmp;
    }
    latLonToVec3(lat, lon, this.dist, this.eye);
    lookAt(this.view, this.eye, [0, 0, 0], [0, 1, 0]);
    const aspect = this.width / Math.max(this.height, 1);
    perspective(this.proj, this.fov, aspect, 0.02, 60);
    this.proj[8] = -this.offset[0];
    this.proj[9] = -this.offset[1];
    multiply(this.viewProj, this.proj, this.view);
    invert(this.invViewProj, this.viewProj);
  }
}

/**
 * Pointer/wheel/touch controls for the camera. Distinguishes clicks from
 * drags, and reports hover positions for picking.
 */
export class Controls {
  constructor(el, camera, { onClick, onHover, onInteract } = {}) {
    this.el = el;
    this.cam = camera;
    this.onClick = onClick || (() => {});
    this.onHover = onHover || (() => {});
    this.onInteract = onInteract || (() => {});
    this.pointers = new Map();
    this.dragging = false;
    this.downAt = null;
    this.lastMove = 0;
    this.pinchDist = 0;

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('pointerleave', () => this.onHover(null, null));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.cam.zoomBy(Math.exp(delta * 0.0012));
      this.onInteract();
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get interacting() {
    return this.pointers.size > 0;
  }

  down(e) {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.dragging = false;
      this.cam.stopInertia();
      this.lastMove = performance.now();
    } else if (this.pointers.size === 2) {
      this.pinchDist = this.currentPinch();
      this.dragging = true;
    }
    this.onInteract();
  }

  currentPinch() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      this.onHover(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const now = performance.now();
    const dt = Math.max((now - this.lastMove) / 1000, 1 / 240);
    this.lastMove = now;
    if (this.pointers.size === 2) {
      const d = this.currentPinch();
      if (this.pinchDist > 0 && d > 0) this.cam.zoomBy(this.pinchDist / d);
      this.pinchDist = d;
      return;
    }
    if (!this.dragging && this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 4) {
      this.dragging = true;
      this.el.classList.add('grabbing');
    }
    if (this.dragging) {
      this.cam.dragBy(dx, dy, dt);
      this.onInteract();
    }
  }

  up(e) {
    const wasDragging = this.dragging;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      this.el.classList.remove('grabbing');
      if (!wasDragging && this.downAt && e.type === 'pointerup') this.onClick(e.clientX, e.clientY);
      // Release without recent motion should not fling.
      if (performance.now() - this.lastMove > 80) this.cam.stopInertia();
      this.dragging = false;
      this.downAt = null;
    }
  }
}

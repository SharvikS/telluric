// Minimal linear algebra for the renderer. Matrices are column-major
// Float32Arrays, as WebGL expects. The globe is the unit sphere centred on the
// origin with +Y through the north pole and (lat 0, lon 0) on +Z, so east is
// +X when the camera looks at the prime meridian.

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Shortest signed difference between two angles in degrees, in (-180, 180]. */
export function angleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function latLonToVec3(lat, lon, r = 1, out = new Float32Array(3)) {
  const la = lat * DEG;
  const lo = lon * DEG;
  const c = Math.cos(la);
  out[0] = r * c * Math.sin(lo);
  out[1] = r * Math.sin(la);
  out[2] = r * c * Math.cos(lo);
  return out;
}

export function vec3ToLatLon(v) {
  const r = Math.hypot(v[0], v[1], v[2]) || 1;
  return [Math.asin(clamp(v[1] / r, -1, 1)) / DEG, Math.atan2(v[0], v[2]) / DEG];
}

/** Great-circle angle between two lat/lon points, in radians. */
export function angularDistance(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG;
  const dp = p2 - p1, dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
export function normalize3(a, out = a) {
  const l = len3(a) || 1;
  out[0] = a[0] / l; out[1] = a[1] / l; out[2] = a[2] / l;
  return out;
}
export function cross3(a, b, out = new Float32Array(3)) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/**
 * Point on the arc between a and b at parameter t. Mirrors arcPoint() in the
 * GLSL of scene/arcs.js and scene/comets.js exactly, so CPU picking matches
 * what the GPU draws. a, b may sit above the surface (|a|, |b| ≥ 1); the
 * direction is interpolated on the sphere and the radius linearly, plus a
 * sine-shaped lift of height `lift`.
 */
export function arcPoint(a, b, lift, t, out = new Float32Array(3)) {
  const ra = len3(a), rb = len3(b);
  const ax = a[0] / ra, ay = a[1] / ra, az = a[2] / ra;
  const bx = b[0] / rb, by = b[1] / rb, bz = b[2] / rb;
  const cosT = clamp(ax * bx + ay * by + az * bz, -1, 1);
  const theta = Math.acos(cosT);
  let x, y, z;
  if (theta < 1e-3) {
    x = ax + (bx - ax) * t; y = ay + (by - ay) * t; z = az + (bz - az) * t;
  } else {
    const s = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / s;
    const wb = Math.sin(t * theta) / s;
    x = ax * wa + bx * wb; y = ay * wa + by * wb; z = az * wa + bz * wb;
  }
  const l = Math.hypot(x, y, z) || 1;
  const r = ra + (rb - ra) * t + lift * Math.sin(Math.PI * t);
  out[0] = (x / l) * r; out[1] = (y / l) * r; out[2] = (z / l) * r;
  return out;
}

/** Arc apex height for two surface points `theta` radians apart. */
export const arcLift = (theta) => 0.025 + 0.42 * Math.pow(theta / Math.PI, 0.85);

// ── mat4 ────────────────────────────────────────────────────────────────────

export const mat4 = () => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

export function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function lookAt(out, eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export function multiply(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

export function invert(out, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/**
 * Project a world point to CSS pixels. Returns null when behind the camera.
 * `out` receives [x, y, depth(ndc z), w].
 */
export function project(viewProj, p, width, height, out = [0, 0, 0, 0]) {
  const x = viewProj[0] * p[0] + viewProj[4] * p[1] + viewProj[8] * p[2] + viewProj[12];
  const y = viewProj[1] * p[0] + viewProj[5] * p[1] + viewProj[9] * p[2] + viewProj[13];
  const z = viewProj[2] * p[0] + viewProj[6] * p[1] + viewProj[10] * p[2] + viewProj[14];
  const w = viewProj[3] * p[0] + viewProj[7] * p[1] + viewProj[11] * p[2] + viewProj[15];
  if (w <= 1e-6) return null;
  out[0] = (x / w * 0.5 + 0.5) * width;
  out[1] = (1 - (y / w * 0.5 + 0.5)) * height;
  out[2] = z / w;
  out[3] = w;
  return out;
}

/** Ray from the camera through a CSS pixel, as [origin, direction]. */
export function screenRay(invViewProj, eye, px, py, width, height) {
  const nx = (px / width) * 2 - 1;
  const ny = 1 - (py / height) * 2;
  const m = invViewProj;
  const x = m[0] * nx + m[4] * ny + m[8] + m[12];
  const y = m[1] * nx + m[5] * ny + m[9] + m[13];
  const z = m[2] * nx + m[6] * ny + m[10] + m[14];
  const w = m[3] * nx + m[7] * ny + m[11] + m[15];
  const dir = new Float32Array([x / w - eye[0], y / w - eye[1], z / w - eye[2]]);
  normalize3(dir);
  return [eye, dir];
}

/** Ray/unit-sphere intersection distance, or -1. */
export function raySphere(origin, dir, radius = 1) {
  const b = dot3(origin, dir);
  const c = dot3(origin, origin) - radius * radius;
  const h = b * b - c;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t > 0 ? t : -1;
}

/** Deterministic 32-bit hash → [0, 1). */
export function hash01(n) {
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}

/**
 * Sub-solar point for a given time: where the sun is directly overhead.
 * Uses the solar declination and the equation of time; accurate to well under
 * a degree, which is plenty for a day/night terminator.
 */
export function subsolarPoint(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - start) / 86400000;
  const decl = -23.44 * Math.cos((TAU / 365) * (dayOfYear + 10));
  const B = (TAU * (dayOfYear - 81)) / 364;
  const eotMin = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let lon = -15 * (utcHours - 12 + eotMin / 60);
  lon = ((lon + 540) % 360) - 180;
  return [decl, lon];
}

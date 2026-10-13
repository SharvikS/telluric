import { createProgram, FULLSCREEN_VS, GLSL_COMMON, drawFullscreen } from '../gl/gl.js';

// One full-screen pass draws everything behind the globe: a procedural
// starfield (hashed cells on the view sphere, so stars are stable as the
// camera moves), a faint Milky Way band with fbm nebulosity, and an analytic
// atmosphere halo whose brightness depends on the closest-approach altitude
// of each view ray and whose tint follows the real sun.
const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform mat4 uInvViewProj;
uniform vec3 uEye;
uniform vec3 uSun;
uniform float uTime;
uniform float uPixelAngle;
uniform float uAlert;
${GLSL_COMMON}

float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0));
  float c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1));
  float h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

vec3 starLayer(vec3 d, float scale, float density, float seed) {
  vec3 q = d * scale;
  vec3 cell = floor(q);
  vec3 h = hash33(cell + seed);
  if (h.x > density) return vec3(0.0);
  vec3 sp = normalize(cell + 0.25 + 0.5 * hash33(cell + seed + 7.1));
  float r = uPixelAngle * (0.55 + 0.9 * h.z);
  float dist = length(d - sp);
  float mag = pow(h.y, 7.0) * 1.6 + 0.05;
  float tw = 0.78 + 0.22 * sin(uTime * (0.6 + 2.5 * h.z) + h.y * 40.0);
  vec3 tint = mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.86, 0.70), h.z);
  float dq = dist / r;
  return tint * mag * tw * exp(-dq * dq);
}

void main() {
  vec4 p = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(p.xyz / p.w - uEye);

  // Milky Way: a tilted band with fbm structure and a denser star population.
  vec3 gN = normalize(vec3(0.42, 0.82, -0.38));
  float bq = dot(d, gN) / 0.23;
  float band = exp(-bq * bq);
  float neb = fbm(d * 3.2 + vec3(4.0, 1.0, 9.0));
  float neb2 = fbm(d * 7.0 - 3.0);
  vec3 col = vec3(0.0015, 0.002, 0.005);
  col += vec3(0.16, 0.10, 0.30) * band * pow(neb, 2.2) * 0.12;
  col += vec3(0.05, 0.12, 0.22) * band * pow(neb2, 3.0) * 0.10;
  col += vec3(0.06, 0.02, 0.10) * pow(fbm(d * 1.4 + 20.0), 3.0) * 0.06;

  col += starLayer(d, 70.0, 0.030, 0.0);
  col += starLayer(d, 160.0, 0.022 + 0.05 * band, 31.0);
  col += starLayer(d, 330.0, 0.012 + 0.07 * band, 67.0) * 0.6;

  // Atmosphere halo for rays that pass beside the planet.
  float tc = -dot(uEye, d);
  if (tc > 0.0) {
    vec3 cp = uEye + d * tc;
    float h = length(cp) - 1.0;
    if (h > -0.02) {
      h = max(h, 0.0);
      float glow = 0.62 * exp(-h / 0.016) + 0.15 * exp(-h / 0.065) + 0.03 * exp(-h / 0.30);
      vec3 pn = normalize(cp);
      float s = dot(pn, uSun);
      vec3 c = mix(vec3(0.03, 0.08, 0.22), vec3(0.18, 0.55, 1.0), smoothstep(-0.35, 0.5, s));
      float sq = s / 0.16;
      c += vec3(0.95, 0.38, 0.16) * exp(-sq * sq) * 0.28;
      c = mix(c, vec3(1.0, 0.08, 0.14), uAlert * 0.55);
      col += c * glow;
    }
  }
  outColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor(gl) {
    this.gl = gl;
    this.prog = createProgram(gl, 'sky', FULLSCREEN_VS, FS);
    this.vao = gl.createVertexArray();
  }

  draw(frame) {
    const gl = this.gl;
    const { prog, u } = this.prog;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(u.uInvViewProj, false, frame.camera.invViewProj);
    gl.uniform3fv(u.uEye, frame.camera.eye);
    gl.uniform3fv(u.uSun, frame.sun);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform1f(u.uPixelAngle, frame.camera.fov / frame.pixelHeight);
    gl.uniform1f(u.uAlert, frame.alert);
    drawFullscreen(gl, this.vao);
  }
}

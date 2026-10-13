import { createProgram, FULLSCREEN_VS, GLSL_COMMON, drawFullscreen } from '../gl/gl.js';

// Everything behind the globe, in one full-viewport pass: a soft radial
// background, an optional starfield and Milky Way, and an analytic
// atmosphere (closest-approach altitude of each view ray). The light theme
// swaps the glow for a soft contact shadow, which reads better on paper.
const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform mat4 uInvViewProj;
uniform vec3 uEye;
uniform vec3 uSun;
uniform float uTime;
uniform float uPixelAngle;
uniform float uAspect;
uniform float uAlert;
uniform vec3 uBgCenter, uBgEdge, uHaloNight, uHaloDay, uShadow, uAlertCol;
uniform float uStars, uNebula, uHaloK, uShadowK;
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
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}

vec3 starLayer(vec3 d, float scale, float density, float seed) {
  vec3 q = d * scale;
  vec3 cell = floor(q);
  vec3 h = hash33(cell + seed);
  if (h.x > density) return vec3(0.0);
  vec3 sp = normalize(cell + 0.25 + 0.5 * hash33(cell + seed + 7.1));
  float r = uPixelAngle * (0.55 + 0.7 * h.z);
  float dq = length(d - sp) / r;
  float mag = pow(h.y, 8.0) * 1.1 + 0.035;
  float tw = 0.82 + 0.18 * sin(uTime * (0.5 + 2.0 * h.z) + h.y * 40.0);
  vec3 tint = mix(vec3(0.70, 0.76, 1.0), vec3(1.0, 0.90, 0.78), h.z);
  return tint * mag * tw * exp(-dq * dq);
}

void main() {
  vec4 p = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(p.xyz / p.w - uEye);

  vec2 q = vUv - 0.5;
  q.x *= uAspect;
  vec3 col = mix(uBgCenter, uBgEdge, smoothstep(0.05, 0.85, length(q)));

  if (uNebula > 0.0) {
    vec3 gN = normalize(vec3(0.42, 0.82, -0.38));
    float bq = dot(d, gN) / 0.23;
    float band = exp(-bq * bq);
    col += vec3(0.10, 0.08, 0.22) * band * pow(fbm(d * 3.2 + 4.0), 2.2) * 0.10 * uNebula;
  }
  if (uStars > 0.0) {
    col += starLayer(d, 70.0, 0.026, 0.0) * uStars;
    col += starLayer(d, 160.0, 0.018, 31.0) * uStars * 0.8;
  }

  // Light theme: a soft drop shadow from a sphere nudged down the screen.
  if (uShadowK > 0.0) {
    vec3 f = normalize(-uEye);
    vec3 up = normalize(vec3(0.0, 1.0, 0.0) - f * f.y);
    vec3 c2 = -up * 0.06;
    float t2 = dot(c2 - uEye, d);
    if (t2 > 0.0) {
      float h2 = max(length(uEye + d * t2 - c2) - 1.0, 0.0);
      col = mix(col, uShadow, uShadowK * (0.45 * exp(-h2 / 0.022) + 0.55 * exp(-h2 / 0.1)));
    }
  }

  // Atmosphere for rays that pass beside the planet.
  float tc = -dot(uEye, d);
  if (tc > 0.0) {
    vec3 cp = uEye + d * tc;
    float h = length(cp) - 1.0;
    if (h > -0.02) {
      h = max(h, 0.0);
      vec3 pn = normalize(cp);
      float s = dot(pn, uSun);
      vec3 c = mix(uHaloNight, uHaloDay, smoothstep(-0.35, 0.5, s));
      c = mix(c, uAlertCol, uAlert * 0.5);
      float glow = 0.55 * exp(-h / 0.014) + 0.16 * exp(-h / 0.06) + 0.04 * exp(-h / 0.25);
      col += c * glow * uHaloK;
    }
  }
  outColor = vec4(col, 1.0);
}`;

function lin(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
}

const THEMES = {
  dark: { bgCenter: '#0f1220', bgEdge: '#0a0b10', haloNight: '#1a2050', haloDay: '#5566d8', shadow: '#000000', alertCol: '#f2555a', stars: 0.7, nebula: 0.4, haloK: 0.9, shadowK: 0 },
  light: { bgCenter: '#fbfcfe', bgEdge: '#eef1f6', haloNight: '#dfe5f0', haloDay: '#ffffff', shadow: '#b4bdcd', alertCol: '#d93a3f', stars: 0, nebula: 0, haloK: 0.3, shadowK: 0.5 },
};

export class Sky {
  constructor(gl) {
    this.gl = gl;
    this.prog = createProgram(gl, 'sky', FULLSCREEN_VS, FS);
    this.vao = gl.createVertexArray();
    this.setTheme('dark', false);
  }

  setTheme(mode, cinema) {
    const t = THEMES[mode] || THEMES.dark;
    this.t = {
      ...t,
      bgCenter: lin(t.bgCenter), bgEdge: lin(t.bgEdge), haloNight: lin(t.haloNight), haloDay: lin(t.haloDay),
      shadow: lin(t.shadow), alertCol: lin(t.alertCol),
      stars: t.stars * (cinema ? 1.6 : 1), nebula: t.nebula * (cinema ? 2.5 : 1), haloK: t.haloK * (cinema ? 1.25 : 1),
    };
  }

  draw(frame) {
    const gl = this.gl;
    const { prog, u } = this.prog;
    const t = this.t;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(u.uInvViewProj, false, frame.camera.invViewProj);
    gl.uniform3fv(u.uEye, frame.camera.eye);
    gl.uniform3fv(u.uSun, frame.sun);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform1f(u.uPixelAngle, frame.camera.fov / frame.pixelHeight);
    gl.uniform1f(u.uAspect, frame.renderWidth / Math.max(1, frame.renderHeight));
    gl.uniform1f(u.uAlert, frame.alert);
    gl.uniform3fv(u.uBgCenter, t.bgCenter);
    gl.uniform3fv(u.uBgEdge, t.bgEdge);
    gl.uniform3fv(u.uHaloNight, t.haloNight);
    gl.uniform3fv(u.uHaloDay, t.haloDay);
    gl.uniform3fv(u.uShadow, t.shadow);
    gl.uniform3fv(u.uAlertCol, t.alertCol);
    gl.uniform1f(u.uStars, t.stars);
    gl.uniform1f(u.uNebula, t.nebula);
    gl.uniform1f(u.uHaloK, t.haloK);
    gl.uniform1f(u.uShadowK, t.shadowK);
    drawFullscreen(gl, this.vao);
  }
}

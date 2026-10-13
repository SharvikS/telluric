import { createProgram, FULLSCREEN_VS, Target, drawFullscreen } from './gl.js';

// Physically-motivated bloom in the style of Jimenez (Call of Duty: Advanced
// Warfare, SIGGRAPH 2014): a 13-tap downsample chain with a Karis average on
// the first level to kill fireflies, then a 3×3 tent upsample accumulated
// additively back up the chain. The composite pass tone-maps (ACES fit),
// adds grain and vignette, and implements the alert glitch and CRT mode.

const DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uFirst;
uniform float uThreshold;
uniform float uKnee;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 S(vec2 o) {
  vec3 c = texture(uSrc, vUv + o * uTexel).rgb;
  // Never let a stray NaN/Inf from any pass poison the whole bloom chain.
  if (any(isnan(c)) || any(isinf(c))) return vec3(0.0);
  return min(c, vec3(64.0));
}

void main() {
  vec3 a = S(vec2(-2, 2)), b = S(vec2(0, 2)), c = S(vec2(2, 2));
  vec3 d = S(vec2(-2, 0)), e = S(vec2(0, 0)), f = S(vec2(2, 0));
  vec3 g = S(vec2(-2, -2)), h = S(vec2(0, -2)), i = S(vec2(2, -2));
  vec3 j = S(vec2(-1, 1)), k = S(vec2(1, 1)), l = S(vec2(-1, -1)), m = S(vec2(1, -1));
  vec3 col;
  if (uFirst > 0.5) {
    // Karis average: weight each 2×2 group by 1 / (1 + luma) and renormalise,
    // so a single sub-pixel-bright sample cannot flicker the whole bloom.
    vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25;
    vec3 g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
    float w0 = 0.5 / (1.0 + luma(g0)), w1 = 0.125 / (1.0 + luma(g1)), w2 = 0.125 / (1.0 + luma(g2));
    float w3 = 0.125 / (1.0 + luma(g3)), w4 = 0.125 / (1.0 + luma(g4));
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    // Soft-knee threshold so only genuinely bright light blooms.
    float br = max(col.r, max(col.g, col.b));
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-5);
    float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
    col *= contrib;
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  outColor = vec4(col, 1.0);
}`;

const UP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 d = uTexel * uRadius;
  vec3 s = texture(uSrc, vUv + vec2(-d.x, d.y)).rgb + texture(uSrc, vUv + vec2(d.x, d.y)).rgb
         + texture(uSrc, vUv + vec2(-d.x, -d.y)).rgb + texture(uSrc, vUv + vec2(d.x, -d.y)).rgb;
  s += 2.0 * (texture(uSrc, vUv + vec2(0.0, d.y)).rgb + texture(uSrc, vUv + vec2(0.0, -d.y)).rgb
            + texture(uSrc, vUv + vec2(-d.x, 0.0)).rgb + texture(uSrc, vUv + vec2(d.x, 0.0)).rgb);
  s += 4.0 * texture(uSrc, vUv).rgb;
  outColor = vec4(s / 16.0, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uTime;
uniform float uGlitch;
uniform float uCrt;
uniform vec2 uResolution;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 sampleHDR(vec2 uv) {
  vec3 c = texture(uScene, uv).rgb + texture(uBloom, uv).rgb * uBloomStrength;
  return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : c;
}

void main() {
  vec2 uv = vUv;
  if (uCrt > 0.5) {
    vec2 c = uv * 2.0 - 1.0;
    c *= 1.0 + 0.06 * dot(c, c);
    uv = c * 0.5 + 0.5;
  }
  // Glitch: horizontal slice displacement and RGB split, driven by alerts.
  float g = uGlitch;
  if (g > 0.001) {
    float band = floor(uv.y * 48.0 + floor(uTime * 24.0) * 7.0);
    float r = hash(vec2(band, floor(uTime * 30.0)));
    if (r < g * 0.35) uv.x += (hash(vec2(band, 3.1)) - 0.5) * 0.06 * g;
  }
  vec2 ca = (uv - 0.5) * (0.0012 + 0.010 * g);
  vec3 col;
  col.r = sampleHDR(uv + ca).r;
  col.g = sampleHDR(uv).g;
  col.b = sampleHDR(uv - ca).b;

  col = aces(col * uExposure);
  col = pow(col, vec3(1.0 / 2.2));

  // Vignette and grain (in display space).
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.55 * pow(dot(q, q) * 1.6, 1.4);
  col += (hash(vUv * uResolution + fract(uTime * 7.13) * 100.0) - 0.5) * 0.028;

  if (uCrt > 0.5) {
    float scan = 0.68 + 0.32 * pow(abs(sin(vUv.y * uResolution.y * 1.5708)), 0.6);
    vec3 mask = vec3(1.0);
    float mx = mod(gl_FragCoord.x, 3.0);
    mask = mx < 1.0 ? vec3(1.08, 0.94, 0.94) : mx < 2.0 ? vec3(0.94, 1.08, 0.94) : vec3(0.94, 0.94, 1.08);
    col *= scan * mask;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
  }
  col += vec3(0.25, 0.0, 0.03) * g * 0.25;
  outColor = vec4(col, 1.0);
}`;

const LEVELS = 6;

export class Post {
  constructor(gl, caps) {
    this.gl = gl;
    this.caps = caps;
    this.down = createProgram(gl, 'bloom-down', FULLSCREEN_VS, DOWN_FS);
    this.up = createProgram(gl, 'bloom-up', FULLSCREEN_VS, UP_FS);
    this.comp = createProgram(gl, 'composite', FULLSCREEN_VS, COMPOSITE_FS);
    this.vao = gl.createVertexArray();
    this.mips = [];
    for (let i = 0; i < LEVELS; i++) this.mips.push(new Target(gl, caps));
    this.bloomStrength = 0.75;
    this.exposure = 1.0;
    this.threshold = 0.62;
    this.knee = 0.3;
    this.crt = false;
  }

  resize(w, h) {
    let mw = w, mh = h;
    for (const m of this.mips) {
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      m.resize(mw, mh);
    }
  }

  bloom(sceneTex, sceneW, sceneH) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    let src = sceneTex, sw = sceneW, sh = sceneH;
    gl.useProgram(this.down.prog);
    const du = this.down.u;
    gl.uniform1i(du.uSrc, 0);
    gl.uniform1f(du.uThreshold, this.threshold);
    gl.uniform1f(du.uKnee, this.knee);
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 0; i < LEVELS; i++) {
      const m = this.mips[i];
      m.bind();
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform2f(du.uTexel, 1 / sw, 1 / sh);
      gl.uniform1f(du.uFirst, i === 0 ? 1 : 0);
      drawFullscreen(gl, this.vao);
      src = m.tex; sw = m.width; sh = m.height;
    }
    gl.useProgram(this.up.prog);
    const uu = this.up.u;
    gl.uniform1i(uu.uSrc, 0);
    gl.uniform1f(uu.uRadius, 1.0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = LEVELS - 1; i > 0; i--) {
      const from = this.mips[i], to = this.mips[i - 1];
      to.bind();
      gl.bindTexture(gl.TEXTURE_2D, from.tex);
      gl.uniform2f(uu.uTexel, 1 / from.width, 1 / from.height);
      drawFullscreen(gl, this.vao);
    }
    gl.disable(gl.BLEND);
    return this.mips[0].tex;
  }

  composite(sceneTex, bloomTex, frame, outW, outH) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const { prog, u } = this.comp;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomTex);
    gl.uniform1i(u.uBloom, 1);
    gl.uniform1f(u.uBloomStrength, this.bloomStrength);
    gl.uniform1f(u.uExposure, this.exposure);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform1f(u.uGlitch, frame.glitch);
    gl.uniform1f(u.uCrt, this.crt ? 1 : 0);
    gl.uniform2f(u.uResolution, outW, outH);
    drawFullscreen(gl, this.vao);
  }
}

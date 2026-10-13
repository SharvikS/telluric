import { createProgram, GLSL_COMMON } from '../gl/gl.js';
import { appColor, THREAT_COLOR } from '../config.js';
import { arcLift, dot3, len3, clamp } from '../util/math.js';
import { Placement } from './placement.js';

// Every endpoint gets one great-circle arc from home. Arcs are instanced
// triangle strips: the vertex shader evaluates the curve, expands it to a
// constant pixel width in screen space, and animates growth, fades and
// flowing dashes, so the CPU only uploads 20 floats per arc.

const SEG = 72;
const STRIDE = 20; // floats per instance

const VS = `#version 300 es
precision highp float;
in vec2 aCorner;            // x: segment index 0..SEG, y: side ±1
in vec4 iA;                 // a.xyz, lift
in vec4 iB;                 // b.xyz, seed
in vec4 iC;                 // rgb, intensity
in vec4 iD;                 // birth, death, threat, direction bias
in vec4 iE;                 // highlight (−1 dim, 0, 1 focus), flash
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uTime;
uniform float uWidth;
out vec2 vUv;
out vec4 vColor;
out vec4 vParams;
out float vFlash;
const float SEG = ${SEG}.0;
${GLSL_COMMON}

void main() {
  float t = aCorner.x / SEG;
  float grow = clamp((uTime - iD.x) / 0.9, 0.0, 1.0);
  grow = 1.0 - pow(1.0 - grow, 3.0);
  float fade = iD.y > 0.0 ? clamp(1.0 - (uTime - iD.y) / 1.2, 0.0, 1.0) : 1.0;
  float tc = min(t, grow);
  vec3 p = arcPoint(iA.xyz, iB.xyz, iA.w, tc) * 1.0012;
  const float e = 0.004;
  vec4 c = uViewProj * vec4(p, 1.0);
  vec4 c0 = uViewProj * vec4(arcPoint(iA.xyz, iB.xyz, iA.w, max(tc - e, 0.0)), 1.0);
  vec4 c1 = uViewProj * vec4(arcPoint(iA.xyz, iB.xyz, iA.w, min(tc + e, 1.0)), 1.0);
  vec2 d = (c1.xy / c1.w - c0.xy / c0.w) * uViewport;
  float dl = length(d);
  d = dl > 1e-6 ? d / dl : vec2(1.0, 0.0);
  vec2 nrm = vec2(-d.y, d.x);
  float hl = iE.x;
  float w = uWidth * (0.75 + 1.1 * iC.w + 0.8 * iE.y) * (hl > 0.5 ? 1.7 : 1.0) * (1.0 + iD.z * 0.8);
  c.xy += nrm * aCorner.y * (w * 2.0 / uViewport) * c.w;
  gl_Position = c;
  vUv = vec2(tc, aCorner.y);
  float dim = hl < -0.5 ? 0.12 : 1.0;
  vec3 col = mix(iC.rgb, vec3(${THREAT_COLOR.join(', ')}), step(0.005, iD.z));
  vColor = vec4(col, (0.24 + 0.76 * iC.w) * fade * dim * (hl > 0.5 ? 1.6 : 1.0));
  float theta = acos(clamp(dot(normalize(iA.xyz), normalize(iB.xyz)), -1.0, 1.0));
  vParams = vec4(iD.w, iB.w, iD.z, theta);
  vFlash = iE.y * fade * dim;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in vec4 vParams;
in float vFlash;
uniform float uTime;
out vec4 outColor;
void main() {
  float edge = clamp(1.0 - abs(vUv.y), 0.0, 1.0);
  float soft = smoothstep(0.0, 0.9, edge);
  float e2 = edge * edge;
  float core = e2 * e2 * edge;
  // Dashes flow towards home when the endpoint mostly sends, away when it receives.
  float len = max(vParams.w, 0.03);
  float dir = vParams.x > 0.0 ? 1.0 : -1.0;
  float ph = fract(vUv.x * len * 22.0 + dir * uTime * 0.55 + vParams.y);
  float dash = smoothstep(0.0, 0.18, ph) * smoothstep(0.62, 0.32, ph);
  float ends = smoothstep(0.0, 0.035, vUv.x) * mix(0.55, 1.0, smoothstep(1.0, 0.9, vUv.x));
  float pulse = vParams.z > 0.0 ? 0.65 + 0.35 * sin(uTime * 7.0) : 1.0;
  float a = vColor.a;
  float body = soft * 0.32 + core * 0.95;
  vec3 col = vColor.rgb * a * body * mix(0.55, 1.25, dash) * ends * pulse * 0.56;
  col += vColor.rgb * vFlash * core * 0.5 * ends;
  outColor = vec4(col, 1.0);
}`;

export class Arcs {
  constructor(gl) {
    this.gl = gl;
    this.prog = createProgram(gl, 'arcs', VS, FS);
    this.items = new Map(); // ep id → { ep, born, death, flash, pos }
    this.capacity = 0;
    this.count = 0;
    this.data = null;
    this.width = 0.9;

    const corners = new Float32Array((SEG + 1) * 4);
    for (let i = 0; i <= SEG; i++) corners.set([i, -1, i, 1], i * 4);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const cb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog.prog, 'aCorner');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.ibuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    this.attrs = ['iA', 'iB', 'iC', 'iD', 'iE'].map((n) => gl.getAttribLocation(this.prog.prog, n));
    this.attrs.forEach((l, k) => {
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, 4, gl.FLOAT, false, STRIDE * 4, k * 16);
      gl.vertexAttribDivisor(l, 1);
    });
    gl.bindVertexArray(null);
    this.ensure(256);
  }

  ensure(n) {
    if (n <= this.capacity) return;
    this.capacity = Math.max(n, this.capacity * 2);
    this.data = new Float32Array(this.capacity * STRIDE);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
  }

  add(ep, time) {
    const it = this.items.get(ep.id);
    if (it) {
      it.ep = ep;
      it.death = 0;
      return it;
    }
    const item = { ep, born: time, death: 0, flash: 0, pos: new Float32Array(3), seed: (ep.id * 0.6180339) % 1 };
    this.items.set(ep.id, item);
    return item;
  }

  remove(id, time) {
    const it = this.items.get(id);
    if (it && !it.death) it.death = time;
  }

  flash(id, amount) {
    const it = this.items.get(id);
    if (it) it.flash = Math.min(1.2, it.flash + amount);
  }

  /** Rebuild instance data. `focus` = { ep, proc, cc, active } for highlighting. */
  update(frame, placement, store, dt) {
    const time = frame.time;
    const home = placement.home;
    this.ensure(this.items.size);
    const d = this.data;
    let n = 0;
    const decay = Math.exp(-dt * 2.5);
    for (const [id, it] of this.items) {
      if (it.death && time - it.death > 1.3) {
        this.items.delete(id);
        continue;
      }
      const ep = it.ep;
      placement.position(ep, time, it.pos);
      const b = it.pos;
      const geo = !Placement.orbits(ep);
      const cosT = clamp(dot3(home, b) / (len3(b) || 1), -1, 1);
      const lift = geo ? arcLift(Math.acos(cosT)) : 0.012;
      const rate = (ep.rateIn || 0) + (ep.rateOut || 0);
      const intensity = clamp((Math.log10(1 + rate) - 2.2) / 4.6, 0, 1);
      it.flash *= decay;
      const color = appColor(ep._app);
      const threat = Math.max(ep.threat || 0, ep._flowThreat || 0) / 100;
      let hl = 0;
      const f = frame.focus;
      if (f && f.active) {
        const match = (f.ep && f.ep === id) || (f.cc && ep.cc === f.cc) || (f.proc && f.procEps && f.procEps.has(id));
        hl = match ? 1 : -1;
      } else if (f && f.ep === id) {
        hl = 1;
      }
      const o = n * STRIDE;
      d[o] = home[0]; d[o + 1] = home[1]; d[o + 2] = home[2]; d[o + 3] = lift;
      d[o + 4] = b[0]; d[o + 5] = b[1]; d[o + 6] = b[2]; d[o + 7] = it.seed;
      d[o + 8] = color[0]; d[o + 9] = color[1]; d[o + 10] = color[2]; d[o + 11] = intensity;
      d[o + 12] = it.born; d[o + 13] = it.death; d[o + 14] = threat; d[o + 15] = ep._dirBias || 0;
      d[o + 16] = hl; d[o + 17] = Math.min(1, it.flash); d[o + 18] = 0; d[o + 19] = 0;
      n++;
    }
    this.count = n;
    if (!n) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * STRIDE);
  }

  draw(frame) {
    if (!this.count || !frame.hasHome) return;
    const gl = this.gl;
    const { prog, u } = this.prog;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(u.uViewProj, false, frame.camera.viewProj);
    gl.uniform2f(u.uViewport, frame.renderWidth, frame.renderHeight);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform1f(u.uWidth, this.width * frame.pxScale);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (SEG + 1) * 2, this.count);
    gl.bindVertexArray(null);
  }
}

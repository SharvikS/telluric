import { createProgram, GLSL_COMMON } from '../gl/gl.js';

// Packet comets. Each PKTS record becomes one instance in a GPU ring buffer:
// 16 floats describing the arc, colour, size, birth time and travel
// duration. All motion happens in the vertex shader, so a comet costs the CPU
// one 64-byte write when it is born and nothing afterwards. Only the slots
// written since the last frame are uploaded, and only the live window of the
// ring is drawn (WebGL2 has no base-instance, so we re-point the instanced
// attributes at the window's offset).
//
// Two programs share the buffer: a tapered ribbon for the trail and a
// billboard for the glowing head.

const SEG = 12;
const STRIDE = 16;

const COMMON_VS = `
in vec4 iA;   // a.xyz, lift
in vec4 iB;   // b.xyz, size px
in vec4 iC;   // rgb, brightness
in vec4 iD;   // birth, duration, inbound (0/1), tail length (arc param units)
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uTime;
uniform float uDim;
${GLSL_COMMON}
`;

const TRAIL_VS = `#version 300 es
precision highp float;
in vec2 aCorner;
${COMMON_VS}
out float vK;
out float vSide;
out vec4 vColor;
const float SEG = ${SEG}.0;
void main() {
  float u = (uTime - iD.x) / iD.y;
  float tail = iD.w;
  if (u < 0.0 || u > 1.0 + tail) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = aCorner.x / SEG;
  float head = min(u, 1.0);
  float tl = clamp(u - tail, 0.0, 1.0);
  float tp = mix(tl, head, k);
  float pa = iD.z > 0.5 ? 1.0 - tp : tp;
  vec3 p = arcPoint(iA.xyz, iB.xyz, iA.w, pa) * 1.0025;
  float e = 0.003;
  vec4 c = uViewProj * vec4(p, 1.0);
  vec4 c0 = uViewProj * vec4(arcPoint(iA.xyz, iB.xyz, iA.w, clamp(pa - e, 0.0, 1.0)), 1.0);
  vec4 c1 = uViewProj * vec4(arcPoint(iA.xyz, iB.xyz, iA.w, clamp(pa + e, 0.0, 1.0)), 1.0);
  vec2 d = (c1.xy / c1.w - c0.xy / c0.w) * uViewport;
  float dl = length(d);
  d = dl > 1e-6 ? d / dl : vec2(1.0, 0.0);
  vec2 nrm = vec2(-d.y, d.x);
  float w = iB.w * (0.18 + 0.82 * k * k);
  c.xy += nrm * aCorner.y * (w * 2.0 / uViewport) * c.w;
  gl_Position = c;
  vK = k;
  vSide = aCorner.y;
  float fadeIn = smoothstep(0.0, 0.05, u);
  float land = 1.0 - smoothstep(1.0, 1.0 + tail, u);
  vColor = vec4(iC.rgb, iC.w * fadeIn * mix(1.0, land, 1.0 - k * 0.3) * uDim);
}`;

const TRAIL_FS = `#version 300 es
precision highp float;
in float vK;
in float vSide;
in vec4 vColor;
out vec4 outColor;
void main() {
  float edge = clamp(1.0 - abs(vSide), 0.0, 1.0);
  float k = clamp(vK, 0.0, 1.0);
  float body = smoothstep(0.0, 1.0, edge);
  float fall = pow(k, 2.2);
  float e3 = edge * edge * edge;
  float k4 = k * k * k * k;
  vec3 col = vColor.rgb * vColor.a * body * fall * 1.3;
  col += mix(vColor.rgb, vec3(1.0), 0.3) * vColor.a * e3 * e3 * k4 * k4 * 0.45;
  outColor = vec4(col, 1.0);
}`;

const HEAD_VS = `#version 300 es
precision highp float;
in vec2 aQuad;
${COMMON_VS}
out vec2 vQ;
out vec4 vColor;
void main() {
  float u = (uTime - iD.x) / iD.y;
  if (u < 0.0 || u > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float pa = iD.z > 0.5 ? 1.0 - u : u;
  vec3 p = arcPoint(iA.xyz, iB.xyz, iA.w, pa) * 1.0025;
  vec4 c = uViewProj * vec4(p, 1.0);
  float s = iB.w * 2.6;
  c.xy += aQuad * (s * 2.0 / uViewport) * c.w;
  gl_Position = c;
  vQ = aQuad;
  float fadeIn = smoothstep(0.0, 0.06, u);
  float arrive = 1.0 - smoothstep(0.9, 1.0, u);
  vColor = vec4(iC.rgb, iC.w * fadeIn * arrive * uDim);
}`;

const HEAD_FS = `#version 300 es
precision highp float;
in vec2 vQ;
in vec4 vColor;
out vec4 outColor;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  float glow = exp(-r2 * 5.0);
  float core = exp(-r2 * 28.0);
  vec3 col = vColor.rgb * glow * 0.75 + mix(vColor.rgb, vec3(1.0), 0.35) * core * 1.25;
  outColor = vec4(col * vColor.a, 1.0);
}`;

export class Comets {
  constructor(gl, capacity = 32768) {
    this.gl = gl;
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.deathAt = new Float32Array(capacity); // CPU copy of birth + duration × (1 + tail)
    this.head = 0; // next slot to write
    this.dirtyFrom = -1; // first slot written since last upload (in write order)
    this.dirtyCount = 0;
    this.alive = 0;
    this.spawned = 0;
    this.dim = 1;

    this.trail = createProgram(gl, 'comet-trail', TRAIL_VS, TRAIL_FS);
    this.headProg = createProgram(gl, 'comet-head', HEAD_VS, HEAD_FS);
    this.ibuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);

    const corners = new Float32Array((SEG + 1) * 4);
    for (let i = 0; i <= SEG; i++) corners.set([i, -1, i, 1], i * 4);
    this.trailVao = this.makeVao(this.trail.prog, 'aCorner', corners);
    this.headVao = this.makeVao(this.headProg.prog, 'aQuad', new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.trailAttrs = ['iA', 'iB', 'iC', 'iD'].map((n) => gl.getAttribLocation(this.trail.prog, n));
    this.headAttrs = ['iA', 'iB', 'iC', 'iD'].map((n) => gl.getAttribLocation(this.headProg.prog, n));
  }

  makeVao(prog, name, verts) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    for (const n of ['iA', 'iB', 'iC', 'iD']) {
      const l = gl.getAttribLocation(prog, n);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribDivisor(l, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  /**
   * Queue one comet. a, b: arc endpoints (home and remote), lift: arc height,
   * inbound: travels b → a.
   */
  spawn(a, b, lift, color, size, brightness, birth, duration, inbound, tail) {
    const i = this.head;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = a[0]; d[o + 1] = a[1]; d[o + 2] = a[2]; d[o + 3] = lift;
    d[o + 4] = b[0]; d[o + 5] = b[1]; d[o + 6] = b[2]; d[o + 7] = size;
    d[o + 8] = color[0]; d[o + 9] = color[1]; d[o + 10] = color[2]; d[o + 11] = brightness;
    d[o + 12] = birth; d[o + 13] = duration; d[o + 14] = inbound ? 1 : 0; d[o + 15] = tail;
    this.deathAt[i] = birth + duration * (1 + tail);
    if (this.dirtyCount === 0) this.dirtyFrom = i;
    this.dirtyCount = Math.min(this.capacity, this.dirtyCount + 1);
    this.head = (i + 1) % this.capacity;
    this.alive = Math.min(this.capacity, this.alive + 1);
    this.spawned++;
  }

  upload() {
    if (!this.dirtyCount) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    const first = this.dirtyFrom;
    const n = this.dirtyCount;
    const tail = Math.min(n, this.capacity - first);
    gl.bufferSubData(gl.ARRAY_BUFFER, first * STRIDE * 4, this.data, first * STRIDE, tail * STRIDE);
    if (n > tail) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, (n - tail) * STRIDE);
    this.dirtyCount = 0;
  }

  /** Advance the live window: drop comets whose time is up. */
  retire(time) {
    let start = (this.head - this.alive + this.capacity) % this.capacity;
    while (this.alive > 0 && this.deathAt[start] < time) {
      start = (start + 1) % this.capacity;
      this.alive--;
    }
  }

  drawPass(prog, vao, attrs, vertsPerInstance, frame) {
    const gl = this.gl;
    const { u } = prog;
    gl.useProgram(prog.prog);
    gl.uniformMatrix4fv(u.uViewProj, false, frame.camera.viewProj);
    gl.uniform2f(u.uViewport, frame.renderWidth, frame.renderHeight);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform1f(u.uDim, this.dim);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    const start = (this.head - this.alive + this.capacity) % this.capacity;
    const first = Math.min(this.alive, this.capacity - start);
    const ranges = [[start, first]];
    if (this.alive > first) ranges.push([0, this.alive - first]);
    for (const [base, count] of ranges) {
      if (!count) continue;
      attrs.forEach((l, k) => gl.vertexAttribPointer(l, 4, gl.FLOAT, false, STRIDE * 4, base * STRIDE * 4 + k * 16));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, vertsPerInstance, count);
    }
    gl.bindVertexArray(null);
  }

  draw(frame) {
    this.retire(frame.time);
    this.upload();
    if (!this.alive) return;
    this.drawPass(this.trail, this.trailVao, this.trailAttrs, (SEG + 1) * 2, frame);
    this.drawPass(this.headProg, this.headVao, this.headAttrs, 4, frame);
  }
}

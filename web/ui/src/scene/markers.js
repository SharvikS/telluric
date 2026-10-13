import { createProgram, GLSL_PREMUL, layerTheme, setPremulUniforms } from '../gl/gl.js';

// All point-like decorations in one instanced program, switched by type:
//   0 endpoint glow   billboard
//   1 activity beam   camera-facing ribbon along the surface normal
//   2 ripple ring     quad on the tangent plane, expanding over its life
//   3 home beacon     billboard with pulsing rings
//   4 alert shockwave tangent-plane quad, several red rings
//   5 orbit ring      tangent-plane quad drawn as a thin dashed circle

export const MK = { DOT: 0, BEAM: 1, RIPPLE: 2, HOME: 3, ALERT: 4, ORBIT: 5 };
const STRIDE = 12;

const VS = `#version 300 es
precision highp float;
in vec2 aQuad;
in vec4 iP;   // pos.xyz, type
in vec4 iC;   // rgb, intensity
in vec4 iS;   // size (px or radius), birth, life, param
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uTime;
uniform vec3 uEye;
out vec2 vQ;
out vec4 vColor;
out float vAge;
out float vType;
out float vParam;
void main() {
  int type = int(iP.w + 0.5);
  vec3 pos = iP.xyz;
  vec3 n = normalize(pos);
  vType = iP.w;
  vColor = iC;
  vParam = iS.w;
  vQ = aQuad;
  vAge = iS.z > 0.0 ? (uTime - iS.y) / iS.z : 0.0;
  if (type == 0 || type == 3) {
    vec4 c = uViewProj * vec4(pos * 1.002, 1.0);
    c.xy += aQuad * (iS.x * 2.0 / uViewport) * c.w;
    gl_Position = c;
  } else if (type == 1) {
    float along = aQuad.y * 0.5 + 0.5;
    vec3 base = pos * 1.001, tip = pos * (1.0 + iS.w);
    vec4 cb = uViewProj * vec4(base, 1.0), ct = uViewProj * vec4(tip, 1.0);
    vec2 d = (ct.xy / ct.w - cb.xy / cb.w) * uViewport;
    float dl = length(d);
    d = dl > 1e-5 ? d / dl : vec2(0.0, 1.0);
    vec2 nrm = vec2(-d.y, d.x);
    vec4 c = uViewProj * vec4(mix(base, tip, along), 1.0);
    c.xy += nrm * aQuad.x * (iS.x * 2.0 / uViewport) * c.w;
    gl_Position = c;
    vQ = vec2(aQuad.x, along);
  } else {
    vec3 e = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-5, 0.0, 0.0));
    vec3 nn = cross(n, e);
    float R = iS.x;
    if (type == 2 || type == 4) {
      float a = clamp(vAge, 0.0, 1.0);
      R *= 0.12 + 0.88 * (1.0 - pow(1.0 - a, 3.0));
    }
    float lift = type == 5 ? length(pos) : 1.0016;
    vec3 p = n * lift + (e * aQuad.x + nn * aQuad.y) * R;
    gl_Position = uViewProj * vec4(p, 1.0);
  }
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vQ;
in vec4 vColor;
in float vAge;
in float vType;
in float vParam;
uniform float uTime;
out vec4 outColor;
${GLSL_PREMUL}
void main() {
  int type = int(vType + 0.5);
  float r = length(vQ);
  float k = 0.0;
  float I = vColor.a;
  if (type == 0) {
    if (r > 1.0) discard;
    float core = exp(-r * r * 30.0);
    float halo = exp(-r * r * 5.0) * 0.35;
    float ring = smoothstep(0.62, 0.55, r) * smoothstep(0.42, 0.5, r) * 0.55;
    k = (core * 2.2 + halo + ring) * I;
  } else if (type == 1) {
    float x = clamp(1.0 - abs(vQ.x), 0.0, 1.0);
    float fadeUp = pow(clamp(1.0 - vQ.y, 0.0, 1.0), 1.4);
    k = x * x * sqrt(x) * fadeUp * I * 1.4;
  } else if (type == 2) {
    if (vAge < 0.0 || vAge > 1.0) discard;
    float rq = (r - 0.92) / 0.06;
    float ring = exp(-rq * rq);
    k = ring * (1.0 - vAge) * I * 1.2;
  } else if (type == 3) {
    if (r > 1.0) discard;
    float core = exp(-r * r * 40.0) * 3.0;
    float halo = exp(-r * r * 6.0) * 0.6;
    float pulse = fract(uTime * 0.5);
    float q1 = (r - pulse) / 0.035, p2 = fract(pulse + 0.5), q2 = (r - p2) / 0.035;
    float ring = exp(-q1 * q1) * (1.0 - pulse) * 1.6;
    float ring2 = exp(-q2 * q2) * (1.0 - p2) * 1.6;
    float cross = (smoothstep(0.03, 0.0, abs(vQ.x)) + smoothstep(0.03, 0.0, abs(vQ.y))) * smoothstep(1.0, 0.55, r) * step(0.32, r) * 0.6;
    k = (core + halo + ring + ring2 + cross) * I;
  } else if (type == 4) {
    if (vAge < 0.0 || vAge > 1.0) discard;
    float kk = 1.0 - vAge;
    float rings = 0.0;
    for (int i = 0; i < 3; i++) {
      float rr = fract(r * 1.0 - vAge * 1.5 + float(i) / 3.0);
      float q = (rr - 0.5) / 0.05;
      rings += exp(-q * q);
    }
    float qe = (r - 0.95) / 0.05;
    float edge = exp(-qe * qe) * 1.6;
    k = (rings * 0.5 * smoothstep(1.0, 0.2, r) + edge) * kk * kk * I;
  } else {
    float w = 0.012 * vParam;
    float qr = (r - 0.985) / max(w, 0.004);
    float ring = exp(-qr * qr);
    float ang = atan(vQ.y, vQ.x);
    float dash = step(0.5, fract(ang * 18.0 / 6.2831853 - uTime * 0.04));
    k = ring * mix(0.35, 1.0, dash) * I;
  }
  outColor = premul(vColor.rgb, k);
}`;

export class Markers {
  constructor(gl) {
    this.gl = gl;
    this.prog = createProgram(gl, 'markers', VS, FS);
    this.capacity = 0;
    this.data = null;
    this.count = 0;
    this.transient = []; // { pos, type, color, size, birth, life, intensity }
    layerTheme(this, 'dark', false, { alphaK: 1.1 });

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const ql = gl.getAttribLocation(this.prog.prog, 'aQuad');
    gl.enableVertexAttribArray(ql);
    gl.vertexAttribPointer(ql, 2, gl.FLOAT, false, 0, 0);
    this.ibuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    ['iP', 'iC', 'iS'].forEach((name, k) => {
      const l = gl.getAttribLocation(this.prog.prog, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, 4, gl.FLOAT, false, STRIDE * 4, k * 16);
      gl.vertexAttribDivisor(l, 1);
    });
    gl.bindVertexArray(null);
    this.ensure(1024);
  }

  setTheme(mode, cinema) {
    layerTheme(this, mode, cinema, { alphaK: 1.1 });
  }

  ensure(n) {
    if (n <= this.capacity) return;
    this.capacity = Math.max(n, this.capacity * 2);
    this.data = new Float32Array(this.capacity * STRIDE);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
  }

  /** A short-lived effect (ripple, alert shockwave). `pos` is copied. */
  pulse(pos, type, color, size, birth, life, intensity = 1) {
    this.transient.push({ pos: Float32Array.from(pos), type, color, size, birth, life, intensity });
  }

  begin() {
    this.count = 0;
  }

  push(pos, type, color, intensity, size, birth = 0, life = 0, param = 0) {
    if (this.count >= this.capacity) {
      const old = this.data;
      this.ensure(this.count + 1);
      this.data.set(old);
    }
    const o = this.count * STRIDE;
    const d = this.data;
    d[o] = pos[0]; d[o + 1] = pos[1]; d[o + 2] = pos[2]; d[o + 3] = type;
    d[o + 4] = color[0]; d[o + 5] = color[1]; d[o + 6] = color[2]; d[o + 7] = intensity;
    d[o + 8] = size; d[o + 9] = birth; d[o + 10] = life; d[o + 11] = param;
    this.count++;
  }

  end(time) {
    // Append live transients, dropping finished ones.
    let k = 0;
    for (const t of this.transient) {
      if (time - t.birth > t.life) continue;
      this.transient[k++] = t;
      this.push(t.pos, t.type, t.color, t.intensity, t.size, t.birth, t.life, 0);
    }
    this.transient.length = k;
    if (!this.count) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * STRIDE);
  }

  draw(frame) {
    if (!this.count) return;
    const gl = this.gl;
    const { prog, u } = this.prog;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(u.uViewProj, false, frame.camera.viewProj);
    gl.uniform2f(u.uViewport, frame.renderWidth, frame.renderHeight);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform3fv(u.uEye, frame.camera.eye);
    setPremulUniforms(gl, u, this);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }
}

// Thin WebGL2 helpers: context creation, shader programs with uniform
// discovery, textures and render targets. Deliberately small — the renderer
// owns its passes; this file only removes boilerplate.

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false, // we resolve our own MSAA target
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  const caps = {
    floatRT: !!gl.getExtension('EXT_color_buffer_float'),
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    anisotropy: gl.getExtension('EXT_texture_filter_anisotropic'),
    maxSamples: gl.getParameter(gl.MAX_SAMPLES) | 0,
  };
  caps.hdrFormat = caps.floatRT ? gl.RGBA16F : gl.RGBA8;
  caps.hdrType = caps.floatRT ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  if (caps.floatRT) {
    const s = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES);
    caps.msaa = s && s.length ? Math.min(4, s[0]) : 0;
  } else {
    caps.msaa = Math.min(4, caps.maxSamples);
  }
  return { gl, caps };
}

function compile(gl, type, source, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    const lines = source.split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
    gl.deleteShader(sh);
    throw new Error(`[${name}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader:\n${log}\n${lines}`);
  }
  return sh;
}

/**
 * Compiles and links a program and returns { prog, u } where `u` maps every
 * active uniform name (arrays without the "[0]" suffix) to its location.
 */
export function createProgram(gl, name, vsSource, fsSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource, name);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource, name);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`[${name}] link: ${gl.getProgramInfoLog(prog)}`);
  }
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    const key = info.name.replace(/\[0\]$/, '');
    u[key] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u, name };
}

export function createTexture(gl, {
  width, height, internalFormat = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE,
  data = null, minFilter = gl.LINEAR, magFilter = gl.LINEAR,
  wrapS = gl.CLAMP_TO_EDGE, wrapT = gl.CLAMP_TO_EDGE,
}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
  return tex;
}

/**
 * Uploads a decoded image as a single-channel R8 texture. Colour-space
 * conversion is disabled: these images are data (distance fields, ids), not
 * pictures.
 */
export function textureFromImage(gl, caps, img, { mipmaps = true, nearest = false, wrapS = gl.REPEAT } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, img);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (nearest) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    if (caps.anisotropy) {
      const max = gl.getParameter(caps.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, caps.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
    }
  }
  return tex;
}

/** A color texture with an FBO, optionally with a depth renderbuffer. */
export class Target {
  constructor(gl, caps, { depth = false, linear = true } = {}) {
    this.gl = gl;
    this.caps = caps;
    this.depth = depth;
    this.linear = linear;
    this.width = 0;
    this.height = 0;
    this.fbo = gl.createFramebuffer();
    this.tex = null;
    this.rbDepth = null;
  }

  resize(w, h) {
    w = Math.max(1, w | 0);
    h = Math.max(1, h | 0);
    if (w === this.width && h === this.height) return;
    const { gl, caps } = this;
    this.width = w;
    this.height = h;
    if (this.tex) gl.deleteTexture(this.tex);
    const f = this.linear ? gl.LINEAR : gl.NEAREST;
    this.tex = createTexture(gl, {
      width: w, height: h, internalFormat: caps.hdrFormat, format: gl.RGBA, type: caps.hdrType,
      minFilter: f, magFilter: f,
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (this.depth) {
      if (this.rbDepth) gl.deleteRenderbuffer(this.rbDepth);
      this.rbDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rbDepth);
    }
    checkFramebuffer(gl, 'Target');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind() {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }
}

/**
 * Multisampled HDR scene target (color + depth renderbuffers) that resolves
 * into a plain texture via blitFramebuffer. Falls back to a single-sample
 * Target when MSAA is unavailable.
 */
export class MSAATarget {
  constructor(gl, caps, samples) {
    this.gl = gl;
    this.caps = caps;
    this.samples = samples;
    this.width = 0;
    this.height = 0;
    this.fbo = gl.createFramebuffer();
    this.resolve = new Target(gl, caps, { depth: samples === 0 });
    this.rbColor = null;
    this.rbDepth = null;
  }

  get tex() { return this.resolve.tex; }

  resize(w, h) {
    w = Math.max(1, w | 0);
    h = Math.max(1, h | 0);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.resolve.resize(w, h);
    if (!this.samples) return;
    const { gl, caps } = this;
    if (this.rbColor) gl.deleteRenderbuffer(this.rbColor);
    if (this.rbDepth) gl.deleteRenderbuffer(this.rbDepth);
    this.rbColor = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, caps.hdrFormat, w, h);
    this.rbDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.rbColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rbDepth);
    checkFramebuffer(gl, 'MSAATarget');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind() {
    if (!this.samples) return this.resolve.bind();
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  /** Resolves the multisampled color into `this.tex`. */
  finish() {
    if (!this.samples) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolve.fbo);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
}

function checkFramebuffer(gl, what) {
  const s = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (s !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`${what}: framebuffer incomplete (0x${s.toString(16)})`);
}

/** Vertex shader for full-screen passes: one oversized triangle, no buffers. */
export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export function drawFullscreen(gl, emptyVao) {
  gl.bindVertexArray(emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Shared GLSL helpers, spliced into shaders that need them. */
export const GLSL_COMMON = `
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
// Mirrors arcPoint() in util/math.js.
vec3 arcPoint(vec3 a, vec3 b, float lift, float t) {
  float ra = length(a), rb = length(b);
  vec3 na = a / ra, nb = b / rb;
  float cosT = clamp(dot(na, nb), -1.0, 1.0);
  float theta = acos(cosT);
  vec3 d;
  if (theta < 1e-3) {
    d = mix(na, nb, t);
  } else {
    float s = sin(theta);
    d = na * (sin((1.0 - t) * theta) / s) + nb * (sin(t * theta) / s);
  }
  float r = mix(ra, rb, t) + lift * sin(PI * t);
  return normalize(d) * r;
}
`;

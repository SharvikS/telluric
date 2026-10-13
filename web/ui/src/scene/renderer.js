import { createContext, MSAATarget } from '../gl/gl.js';
import { Post } from '../gl/post.js';
import { Sky } from './sky.js';
import { Globe } from './globe.js';

/**
 * Owns the GL context and runs the frame:
 *
 *   scene target (HDR, 4× MSAA)
 *     1. sky        full-screen: stars, Milky Way, atmosphere halo
 *     2. globe      opaque, writes depth
 *     3. layers     additive, depth-tested, no depth writes (arcs, markers,
 *                   comets, orbits…) — each layer is { draw(frame) }
 *   resolve MSAA → bloom chain → composite (tone map, grain, glitch) → canvas
 *
 * Render resolution adapts to frame time; the composite always runs at full
 * canvas resolution so the HUD-adjacent edges stay crisp.
 */
export class Renderer {
  constructor(canvas, world) {
    const { gl, caps } = createContext(canvas);
    this.gl = gl;
    this.caps = caps;
    this.canvas = canvas;
    this.scene = new MSAATarget(gl, caps, caps.msaa);
    this.post = new Post(gl, caps);
    this.sky = new Sky(gl);
    this.globe = new Globe(gl, caps, world);
    this.layers = [];
    this.scale = 1;
    this.maxScale = 1;
    this.cssW = 1;
    this.cssH = 1;
    this.dpr = 1;
    this.frameTimes = [];
    this.lastAdapt = 0;
  }

  addLayer(layer) {
    this.layers.push(layer);
    return layer;
  }

  resize(cssW, cssH, dpr) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.applyScale();
  }

  applyScale() {
    const w = Math.max(1, Math.round(this.canvas.width * this.scale));
    const h = Math.max(1, Math.round(this.canvas.height * this.scale));
    this.scene.resize(w, h);
    this.post.resize(w, h);
  }

  /** Adaptive resolution: keep the frame under ~18 ms. */
  adapt(frameMs, now) {
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    if (now - this.lastAdapt < 1500 || this.frameTimes.length < 60) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    let next = this.scale;
    if (p75 > 19 && this.scale > 0.5) next = Math.max(0.5, this.scale - 0.1);
    else if (p75 < 12 && this.scale < this.maxScale) next = Math.min(this.maxScale, this.scale + 0.05);
    if (next !== this.scale) {
      this.scale = next;
      this.applyScale();
      this.frameTimes.length = 0;
    }
    this.lastAdapt = now;
  }

  render(frame) {
    const gl = this.gl;
    frame.pixelHeight = this.scene.height;
    frame.renderWidth = this.scene.width;
    frame.renderHeight = this.scene.height;
    frame.cssWidth = this.cssW;
    frame.cssHeight = this.cssH;

    this.scene.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    this.sky.draw(frame);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    this.globe.draw(frame);
    gl.disable(gl.CULL_FACE);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    for (const layer of this.layers) layer.draw(frame);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    this.scene.finish();
    const bloom = this.post.bloom(this.scene.tex, this.scene.width, this.scene.height);
    this.post.composite(this.scene.tex, bloom, frame, this.canvas.width, this.canvas.height);
  }
}

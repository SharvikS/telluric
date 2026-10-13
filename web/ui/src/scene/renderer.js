import { createContext, MSAATarget } from '../gl/gl.js';
import { Post } from '../gl/post.js';
import { Sky } from './sky.js';
import { Globe } from './globe.js';

/**
 * Owns the GL context and runs the frame. The canvas covers the window but
 * the globe is drawn only inside a "slot" — a rounded rectangle that follows
 * whichever card or panel hosts it — and the composite writes premultiplied
 * alpha, so the page shows through everywhere else.
 *
 *   scene target (HDR, 4× MSAA), viewport + scissor = slot
 *     1. sky        background, stars, atmosphere / contact shadow
 *     2. globe      opaque, writes depth
 *     3. layers     depth-tested, no depth writes (arcs, markers, comets…)
 *                   dark: additive light · light: premultiplied "over"
 *   resolve MSAA → bloom chain → composite (tone curve, sRGB, slot mask) → canvas
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
    this.light = false;
    this.cleared = false;
  }

  addLayer(layer) {
    this.layers.push(layer);
    return layer;
  }

  setTheme(mode, cinema = false) {
    this.light = mode === 'light';
    this.cinema = !!cinema;
    this.sky.setTheme(mode, cinema);
    this.globe.setTheme(mode);
    this.post.setTheme(mode, cinema);
    for (const l of this.layers) l.setTheme?.(mode, cinema);
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

  /** Slot rectangle in scene-target pixels (origin bottom-left). */
  targetRect(slot) {
    const k = this.dpr * this.scale;
    const x = Math.max(0, Math.floor(slot.x * k));
    const w = Math.max(1, Math.min(this.scene.width - x, Math.ceil(slot.w * k)));
    const yTop = Math.max(0, Math.floor(slot.y * k));
    const h = Math.max(1, Math.min(this.scene.height - yTop, Math.ceil(slot.h * k)));
    return [x, this.scene.height - yTop - h, w, h];
  }

  /** Nothing to show: clear the canvas once and stop. */
  clear() {
    if (this.cleared) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.cleared = true;
  }

  render(frame) {
    const gl = this.gl;
    const slot = frame.slot;
    if (!slot || slot.alpha <= 0.001 || slot.w < 2 || slot.h < 2) {
      this.clear();
      return;
    }
    this.cleared = false;
    const [vx, vy, vw, vh] = this.targetRect(slot);
    frame.pixelHeight = vh;
    frame.renderWidth = vw;
    frame.renderHeight = vh;

    this.scene.bind();
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.viewport(vx, vy, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vx, vy, vw, vh);

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
    if (this.light) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    for (const layer of this.layers) if (layer.visible !== false) layer.draw(frame);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);

    this.scene.finish();
    const bloom = this.post.bloom(this.scene.tex, this.scene.width, this.scene.height);
    const k = this.dpr;
    const cx = slot.x * k, cw = slot.w * k, ch = slot.h * k;
    const cy = this.canvas.height - (slot.y * k + ch);
    this.post.composite(this.scene.tex, bloom, frame, this.canvas.width, this.canvas.height, [cx, cy, cw, ch], (slot.r || 0) * k, slot.alpha);
  }
}

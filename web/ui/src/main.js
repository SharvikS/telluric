import { loadWorld } from './assets.js';
import { Renderer } from './scene/renderer.js';
import { Camera, Controls } from './scene/camera.js';
import { World } from './scene/world.js';
import { Store } from './state/store.js';
import { Connection } from './net/connection.js';
import { latLonToVec3, subsolarPoint } from './util/math.js';

const canvas = document.getElementById('gl');
const params = new URLSearchParams(location.search);

const geo = await loadWorld();
const renderer = new Renderer(canvas, geo);
const camera = new Camera();
const store = new Store();
const world = new World(renderer, store, geo);
const conn = new Connection(store, { params });
const controls = new Controls(canvas, camera, {});
// Debug: ?off=arcs,markers,comets disables layers.
for (const name of (params.get('off') || '').split(',').filter(Boolean)) {
  const layer = { arcs: world.arcs, markers: world.markers, comets: world.comets }[name];
  if (layer) renderer.layers = renderer.layers.filter((l) => l !== layer);
}

store.on('home', (h) => {
  if (h) camera.flyTo(h.lat - 12, h.lon + 18, 3.9, 2.2);
});

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(window.innerWidth, window.innerHeight, dpr);
  camera.setViewport(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

const sun = new Float32Array(3);
const stats = { frames: 0, frameMs: 0, fps: 0, comets: 0, arcs: 0, scale: 1 };
window.__telluric = stats;
let last = performance.now();
let fpsAcc = 0, fpsN = 0;

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  camera.update(dt, controls.interacting);
  const [slat, slon] = subsolarPoint(new Date(store.now()));
  latLonToVec3(slat, slon, 1, sun);
  const f = {
    camera, time: world.now(), sun, alert: 0, glitch: 0,
    pxScale: renderer.dpr * renderer.scale,
    cssWidth: renderer.cssW, cssHeight: renderer.cssH,
    renderWidth: renderer.scene.width, renderHeight: renderer.scene.height,
  };
  world.frame(f, dt);
  renderer.render(f);
  const ms = performance.now() - now;
  renderer.adapt(ms, now);
  stats.frames++;
  stats.frameMs = stats.frameMs * 0.95 + ms * 0.05;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { stats.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  stats.comets = world.comets.alive;
  stats.spawned = world.comets.spawned;
  stats.arcs = world.arcs.count;
  stats.scale = renderer.scale;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
conn.start();

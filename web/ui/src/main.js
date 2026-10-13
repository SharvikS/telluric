import { loadWorld } from './assets.js';
import { Renderer } from './scene/renderer.js';
import { Camera, Controls } from './scene/camera.js';
import { World } from './scene/world.js';
import { Placement } from './scene/placement.js';
import { Store } from './state/store.js';
import { Connection } from './net/connection.js';
import { Hud } from './hud/hud.js';
import { Audio } from './audio/audio.js';
import { latLonToVec3, vec3ToLatLon, subsolarPoint, screenRay, raySphere, clamp } from './util/math.js';
import { esc, rate } from './util/format.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('gl');
const loading = document.getElementById('loading');

function fail(err) {
  console.error(err);
  loading.innerHTML = `<div class="err">TELLURIC could not start.<br><br>${esc(err.message || err)}<br><br>A browser with WebGL2 is required.</div>`;
}

let geo, renderer;
try {
  geo = await loadWorld();
  renderer = new Renderer(canvas, geo);
} catch (e) {
  fail(e);
  throw e;
}

const camera = new Camera();
const store = new Store();
const world = new World(renderer, store, geo);
const conn = new Connection(store, { params });
const audio = new Audio();

// Debug: ?off=arcs,markers,comets disables layers.
for (const name of (params.get('off') || '').split(',').filter(Boolean)) {
  const layer = { arcs: world.arcs, markers: world.markers, comets: world.comets }[name];
  if (layer) renderer.layers = renderer.layers.filter((l) => l !== layer);
}

// ── effects state ───────────────────────────────────────────────────────────
const fx = { glitch: 0, alert: 0, lastInput: performance.now(), cinematic: false, cineAuto: false, cineAt: 0, cineTarget: 0 };

// ── actions (shared by HUD, keyboard and pointer) ───────────────────────────
const actions = {
  select(id, { fly = true } = {}) {
    const ep = store.endpoints.get(id);
    if (!ep) return;
    world.focus.ep = id;
    hud.detail.open(id);
    if (fly) flyToEndpoint(ep);
    renderer.globe.selCountry = ep.lat != null ? geo.countryAt(ep.lat, ep.lon) : 0;
  },
  clearSelection() {
    world.focus.ep = 0;
    if (!world.focus.cc) renderer.globe.selCountry = 0;
  },
  focusProc(id) {
    const p = store.procs.get(id);
    world.focus.active = true;
    world.focus.proc = id || -1;
    world.focus.cc = null;
    refreshProcFocus();
    hud.setFilter(`PROCESS · ${p ? p.name : 'unattributed'}`);
    hud.procs.selected = String(id);
  },
  focusCountry(cc) {
    const c = geo.byIso2.get(cc);
    world.focus.active = true;
    world.focus.cc = cc;
    world.focus.proc = 0;
    world.focus.procEps = null;
    renderer.globe.selCountry = c ? c.id : 0;
    hud.setFilter(`COUNTRY · ${c ? c.name : cc}`);
    if (c) camera.flyTo(c.lat, c.lon, Math.max(2.4, Math.min(camera.targetDist, 3.2)), 1.6);
    hud.countries.selected = cc;
  },
  clearFocus() {
    Object.assign(world.focus, { active: false, proc: 0, cc: null, procEps: null });
    hud.setFilter('');
    hud.procs.selected = null;
    hud.countries.selected = null;
    if (!world.focus.ep) renderer.globe.selCountry = 0;
  },
  selectAlert(a) {
    if (a.ep && store.endpoints.has(a.ep)) actions.select(a.ep);
    else if (store.home) camera.flyTo(store.home.lat, store.home.lon, 2.6, 1.4);
  },
  pick(r) {
    if (r.type === 'host') actions.select(r.id);
    else if (r.type === 'proc') actions.focusProc(r.id);
    else if (r.type === 'country') actions.focusCountry(r.id);
    else if (r.type === 'alert') {
      const a = store.alerts.get(r.id);
      if (a) actions.selectAlert(a);
    }
  },
  alertShown(a) {
    const k = { critical: 1, high: 0.6, medium: 0.3 }[a.sev] || 0.2;
    fx.glitch = Math.max(fx.glitch, k);
    fx.alert = Math.max(fx.alert, k);
    if (a.sev === 'critical') camera.shake(0.35);
    audio.alarm(a.sev);
    if (fx.cinematic && a.ep && store.endpoints.has(a.ep)) {
      fx.cineAt = performance.now();
      flyToEndpoint(store.endpoints.get(a.ep));
    }
  },
  toggleSound() {
    hud.setSound(audio.toggle());
  },
};

function refreshProcFocus() {
  if (!world.focus.active || !world.focus.proc) return;
  const set = new Set();
  const want = world.focus.proc === -1 ? 0 : world.focus.proc;
  for (const f of store.flows.values()) if ((f.proc || 0) === want) set.add(f.ep);
  world.focus.procEps = set;
}

/** Frame the arc home → endpoint: look at its midpoint from a fitting distance. */
function flyToEndpoint(ep) {
  const pl = world.placement;
  if (!pl.hasHome || Placement.orbits(ep)) {
    const [lat, lon] = pl.homeLL;
    camera.flyTo(lat, lon, 2.1, 1.5);
    return;
  }
  const a = pl.home, b = latLonToVec3(ep.lat, ep.lon);
  const mid = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const len = Math.hypot(mid[0], mid[1], mid[2]);
  const theta = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
  const [lat, lon] = len < 1e-3 ? [ep.lat, ep.lon] : vec3ToLatLon(mid);
  camera.flyTo(lat - 6, lon, clamp(2.0 + theta * 1.25, 2.0, 5.2), 1.7);
}

const hud = new Hud({ store, conn, world, camera, geo, actions });

store.on('flow', (f, isNew) => {
  if (isNew) {
    audio.blip(f.app);
    if (world.focus.proc) refreshProcFocus();
  }
});
store.on('reset', () => {
  actions.clearFocus();
  hud.detail.close();
});

// ── camera framing ──────────────────────────────────────────────────────────
function fitDistance() {
  const r = hud.globeRect();
  const want = Math.min(r.width, r.height) * 0.43;
  const k = (window.innerHeight / 2) / (Math.tan(camera.fov / 2) * Math.max(want, 60));
  return clamp(Math.sqrt(1 + k * k), 2.2, 6.5);
}

function layout() {
  const r = hud.globeRect();
  const W = window.innerWidth, H = window.innerHeight;
  camera.offset[0] = ((r.left + r.width / 2) / W) * 2 - 1;
  camera.offset[1] = 1 - ((r.top + r.height / 2) / H) * 2;
}

let homeFlown = false;
store.on('home', (h) => {
  if (!h || homeFlown) return;
  homeFlown = true;
  // Arrive from deep space and settle with home up-left of centre, leaving
  // room for the long arcs.
  camera.lat = h.lat - 25;
  camera.lon = h.lon + 70;
  camera.dist = camera.targetDist = 7;
  camera.flyTo(h.lat - 14, h.lon + 22, fitDistance(), 2.6);
});

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(window.innerWidth, window.innerHeight, dpr);
  camera.setViewport(window.innerWidth, window.innerHeight);
  layout();
}
window.addEventListener('resize', resize);
resize();

// ── pointer ─────────────────────────────────────────────────────────────────
function globeLatLon(x, y) {
  const [o, d] = screenRay(camera.invViewProj, camera.eye, x, y, window.innerWidth, window.innerHeight);
  const t = raySphere(o, d);
  if (t < 0) return null;
  return vec3ToLatLon([o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
}

const controls = new Controls(canvas, camera, {
  onInteract: () => noteInput(),
  onHover: (x, y) => {
    if (x == null) {
      hud.showTooltip(0, 0, null);
      renderer.globe.hoverCountry = 0;
      return;
    }
    const id = world.pick(x, y);
    canvas.classList.toggle('pointing', id != null);
    if (id != null) {
      const ep = store.endpoints.get(id);
      hud.showTooltip(x, y, ep ? hud.endpointTooltip(ep) : null);
      renderer.globe.hoverCountry = 0;
      return;
    }
    const ll = globeLatLon(x, y);
    const cid = ll ? geo.countryAt(ll[0], ll[1]) : 0;
    renderer.globe.hoverCountry = cid;
    const c = cid ? geo.byId.get(cid) : null;
    const agg = c ? store.countries().find((k) => k.cc === c.iso2) : null;
    hud.showTooltip(x, y, c && agg ? `<div class="h">${esc(c.name)}</div><div class="m">${agg.eps} host${agg.eps === 1 ? '' : 's'} · ${rate(agg.rate)}</div>` : null);
  },
  onClick: (x, y) => {
    noteInput();
    const id = world.pick(x, y, 16);
    if (id != null) {
      actions.select(id);
      return;
    }
    const ll = globeLatLon(x, y);
    const cid = ll ? geo.countryAt(ll[0], ll[1]) : 0;
    const c = cid ? geo.byId.get(cid) : null;
    if (c && c.iso2 && store.countries().some((k) => k.cc === c.iso2)) {
      actions.focusCountry(c.iso2);
    } else {
      hud.detail.close();
      actions.clearFocus();
    }
  },
});

// ── keyboard ────────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  noteInput();
  if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || e.key === '/') {
    e.preventDefault();
    hud.search.open();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      camera.autoRotate = !camera.autoRotate;
      hud.toast(`auto-rotate ${camera.autoRotate ? 'on' : 'off'}`, 1400);
      break;
    case 'h': case 'H':
      hud.root.classList.toggle('hidden');
      layout();
      break;
    case 'c': case 'C':
      setCinematic(!fx.cinematic, false);
      break;
    case 'r': case 'R':
      renderer.post.crt = !renderer.post.crt;
      hud.toast(`CRT mode ${renderer.post.crt ? 'on' : 'off'}`, 1400);
      break;
    case 'm': case 'M':
      actions.toggleSound();
      hud.toast(`sound ${audio.enabled ? 'on' : 'off'}`, 1400);
      break;
    case 'f': case 'F':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => {});
      break;
    case '?':
      hud.help.toggle();
      break;
    case 'Escape':
      if (hud.help.isOpen) hud.help.close();
      else if (hud.detail.isOpen) hud.detail.close();
      else if (world.focus.active) actions.clearFocus();
      else if (fx.cinematic) setCinematic(false);
      break;
    default:
      break;
  }
});

function noteInput() {
  fx.lastInput = performance.now();
  if (fx.cinematic && fx.cineAuto) setCinematic(false);
}

function setCinematic(on, auto = false) {
  fx.cinematic = on;
  fx.cineAuto = on && auto;
  fx.cineAt = 0;
  hud.root.classList.toggle('cinematic', on);
  if (!on) world.focus.ep = hud.detail.isOpen ? hud.detail.epId : 0;
  if (!auto) hud.toast(`cinematic mode ${on ? 'on' : 'off'}`, 1400);
}

/** Cinematic tour: fresh alerts first, then the busiest connections. */
function cinematicStep(now) {
  if (now - fx.cineAt < 7500) return;
  fx.cineAt = now;
  const eps = [...store.endpoints.values()].filter((e) => !Placement.orbits(e));
  if (!eps.length) return;
  const recent = store.alertOrder.map((id) => store.alerts.get(id))
    .find((a) => a && a.ep && store.now() - a.ts < 30000 && store.endpoints.has(a.ep));
  let target = recent ? store.endpoints.get(recent.ep) : null;
  if (!target || target.id === fx.cineTarget) {
    const ranked = eps.sort((a, b) => (b.rateIn + b.rateOut) - (a.rateIn + a.rateOut));
    const pool = ranked.slice(0, 6).filter((e) => e.id !== fx.cineTarget);
    target = pool[Math.floor(Math.random() * pool.length)] || ranked[0];
  }
  fx.cineTarget = target.id;
  world.focus.ep = target.id;
  flyToEndpoint(target);
}

// ── frame loop ──────────────────────────────────────────────────────────────
const sun = new Float32Array(3);
const stats = { frames: 0, frameMs: 0, fps: 0, comets: 0, arcs: 0, scale: 1, tWorld: 0, tRender: 0, tHud: 0 };
window.__telluric = stats;
let last = performance.now();
let fpsAcc = 0, fpsN = 0, first = true, layoutAt = 0;

function frame(now) {
  const cbStart = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (now - fx.lastInput > 90000 && !fx.cinematic && store.endpoints.size) setCinematic(true, true);
  if (fx.cinematic) cinematicStep(now);
  if (now - layoutAt > 500) {
    layoutAt = now;
    layout();
  }
  camera.update(dt, controls.interacting);

  const [slat, slon] = subsolarPoint(new Date(store.now()));
  latLonToVec3(slat, slon, 1, sun);
  const defcon = store.stats ? store.stats.defcon || 5 : 5;
  const base = defcon <= 1 ? 0.55 : defcon === 2 ? 0.28 : 0;
  fx.glitch *= Math.exp(-dt * 2.2);
  fx.alert = Math.max(base * (0.75 + 0.25 * Math.sin(now / 300)), fx.alert * Math.exp(-dt * 0.9));
  const f = {
    camera, time: world.now(), sun, alert: fx.alert, glitch: fx.glitch,
    pxScale: renderer.dpr * renderer.scale,
    cssWidth: renderer.cssW, cssHeight: renderer.cssH,
    renderWidth: renderer.scene.width, renderHeight: renderer.scene.height,
  };
  const t0 = performance.now();
  world.frame(f, dt);
  const t1 = performance.now();
  renderer.render(f);
  const t2 = performance.now();
  hud.update(f, now, dt);
  const t3 = performance.now();
  stats.tWorld = stats.tWorld * 0.95 + (t1 - t0) * 0.05 || 0;
  stats.tRender = stats.tRender * 0.95 + (t2 - t1) * 0.05 || 0;
  stats.tHud = stats.tHud * 0.95 + (t3 - t2) * 0.05 || 0;

  const ms = performance.now() - cbStart;
  renderer.adapt(ms, now);
  stats.frames++;
  stats.frameMs = stats.frameMs * 0.95 + ms * 0.05;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { stats.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  stats.comets = world.comets.alive;
  stats.spawned = world.comets.spawned;
  stats.arcs = world.arcs.count;
  stats.scale = renderer.scale;
  stats.eps = store.endpoints.size;
  stats.flows = store.flows.size;
  stats.alerts = store.alerts.size;
  stats.msgMsPerSec = conn.msgMs.rate;
  if (first) {
    first = false;
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 900);
  }
  requestAnimationFrame(frame);
}

// A small API for automation and the browser console.
window.telluric = { store, world, camera, renderer, actions, hud, conn };
requestAnimationFrame(frame);
conn.start();

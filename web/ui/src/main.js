import { loadWorld } from './assets.js';
import { Renderer } from './scene/renderer.js';
import { Camera } from './scene/camera.js';
import { World } from './scene/world.js';
import { Store } from './state/store.js';
import { Connection } from './net/connection.js';
import { Audio } from './audio/audio.js';
import { Prefs } from './app/prefs.js';
import { Theme } from './app/theme.js';
import { Boot } from './app/boot.js';
import { History } from './app/history.js';
import { App } from './app/app.js';
import { OverviewView } from './ui/views/overview.js';
import { MapView } from './ui/views/map.js';
import { ConnectionsView, HostsView, ProcessesView, DnsView } from './ui/views/tables.js';
import { SecurityView } from './ui/views/security.js';
import { TracesView } from './ui/views/traces.js';
import { SettingsView } from './ui/views/settings.js';
import { esc } from './util/format.js';
import { setVizTheme } from './config.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('gl');
const prefs = new Prefs();
const theme = new Theme(prefs);
setVizTheme(theme.mode);
const boot = new Boot();

boot.step('map', 'Loading map data');
let geo, renderer;
try {
  geo = await loadWorld();
  renderer = new Renderer(canvas, geo);
} catch (e) {
  console.error(e);
  boot.fail(`Telluric could not start.<br><br>${esc(e.message || e)}<br><br>A browser with WebGL2 is required.`);
  throw e;
}
boot.done('map');
boot.step('engine', 'Connecting to engine');

const camera = new Camera();
const store = new Store();
const world = new World(renderer, store, geo);
const conn = new Connection(store, { params });
const history = new History(store);
const audio = new Audio();

const app = new App({
  geo, renderer, store, conn, world, camera, prefs, theme, history, audio,
  views: {
    overview: OverviewView,
    map: MapView,
    connections: ConnectionsView,
    hosts: HostsView,
    processes: ProcessesView,
    dns: DnsView,
    traces: TracesView,
    security: SecurityView,
    settings: SettingsView,
  },
});
app.booting = true;

// Debug: ?off=arcs,markers,comets disables layers.
for (const name of (params.get('off') || '').split(',').filter(Boolean)) {
  const layer = { arcs: world.arcs, markers: world.markers, comets: world.comets }[name];
  if (layer) layer.visible = false;
}

let entered = false;
store.on('hello', (msg) => {
  boot.done('engine');
  boot.step('snapshot', msg.mode === 'demo' ? 'Receiving snapshot · demo data' : 'Receiving snapshot');
  if (msg.home && msg.home.lat != null) {
    // Start far out in space, home slightly up-left of centre.
    camera.lat = msg.home.lat - 22;
    camera.lon = msg.home.lon + 64;
    camera.dist = camera.targetDist = 11;
  }
});
store.on('snapshot', async () => {
  boot.done('snapshot');
  if (entered) return;
  entered = true;
  await boot.finish();
  app.booting = false;
  app.root.classList.remove('booting');
  app.start();
  const h = store.home;
  requestAnimationFrame(() => {
    const el = app.current && app.current.slot();
    const r = el ? el.getBoundingClientRect() : { width: innerWidth, height: innerHeight };
    const d = app.fitDistance(r.width, r.height, app.current && app.current.name === 'map' ? 0.4 : 0.44);
    if (h) camera.flyTo(h.lat - 14, h.lon + 24, d, 2.4);
    else camera.targetDist = d;
  });
});

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(innerWidth, innerHeight, dpr);
  app.refitCamera();
}
window.addEventListener('resize', resize);
resize();

const stats = { frames: 0, frameMs: 0, fps: 0 };
window.__telluric = stats;
window.telluric = { app, store, world, camera, renderer, conn, prefs, theme };
let last = performance.now();
let fpsAcc = 0, fpsN = 0;
function loop(now) {
  const t0 = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  app.frame(now, dt);
  const ms = performance.now() - t0;
  if (app.slot) renderer.adapt(ms, now);
  stats.frames++;
  stats.frameMs = stats.frameMs * 0.95 + ms * 0.05;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    stats.fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }
  stats.comets = world.comets.alive;
  stats.arcs = world.arcs.count;
  stats.eps = store.endpoints.size;
  stats.alerts = store.alerts.size;
  stats.scale = renderer.scale;
  stats.route = app.current ? app.current.name : '';
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
conn.start();

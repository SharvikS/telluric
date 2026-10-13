import { Emitter } from '../util/emitter.js';
import { PacketBatch, decodeBinary } from './protocol.js';
import { DemoSimulator } from '../demo/simulator.js';

const TOKEN_KEY = 'telluric.token';

function storage(fn, fallback = null) {
  try {
    return fn(window.sessionStorage);
  } catch {
    return fallback;
  }
}

/**
 * Connects the store to an engine over WebSocket, or to the built-in demo
 * simulator when there is no engine (GitHub Pages, ?demo, or repeated
 * failures). While in demo-by-fallback it keeps probing for an engine and
 * switches to live mode the moment one answers.
 *
 * Events: status ({ state, detail }) where state ∈ connecting | live | demo |
 * reconnecting | offline.
 */
export class Connection extends Emitter {
  constructor(store, { params = new URLSearchParams(location.search) } = {}) {
    super();
    this.store = store;
    this.params = params;
    this.batch = new PacketBatch(4096);
    this.ws = null;
    this.demo = null;
    this.attempts = 0;
    this.gotHello = false;
    this.state = 'connecting';
    this.probeTimer = null;
    this.pingTimer = null;
    this.msgMs = { acc: 0, at: performance.now(), rate: 0 }; // main-thread ms/s spent handling frames
    this.captureToken();
  }

  captureToken() {
    const tok = this.params.get('token');
    if (tok) {
      storage((s) => s.setItem(TOKEN_KEY, tok));
      const url = new URL(location.href);
      url.searchParams.delete('token');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    this.token = tok || storage((s) => s.getItem(TOKEN_KEY));
  }

  setState(state, detail = '') {
    this.state = state;
    this.emit('status', { state, detail });
  }

  start() {
    const forceDemo = this.params.has('demo') || location.hostname.endsWith('github.io') || location.protocol === 'file:';
    if (forceDemo) {
      this.startDemo('demo mode');
      return;
    }
    this.probe().then((ok) => {
      if (ok) this.connect();
      else this.fallbackDemo();
    });
  }

  /**
   * Is an engine serving this page? `GET healthz` answers "ok" on the engine
   * and 404s silently on a static host, whereas a failed WebSocket handshake
   * is logged as a console error, so we never open a socket blind.
   */
  async probe() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch(new URL('healthz', location.href), { cache: 'no-store', signal: ctl.signal });
      clearTimeout(timer);
      return r.ok && (await r.text()).trim() === 'ok';
    } catch {
      return false;
    }
  }

  fallbackDemo() {
    if (!this.demo) this.startDemo('no engine found — running the built-in demo');
    this.scheduleProbe();
  }

  wsUrl() {
    const url = new URL('ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.token) url.searchParams.set('token', this.token);
    return url.toString();
  }

  connect() {
    if (!this.demo) this.setState(this.attempts ? 'reconnecting' : 'connecting');
    let ws;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch {
      this.onFail();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.gotHello = false;
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      if (this.gotHello) {
        // We had a session: keep the world on screen, wait for the engine.
        this.setState('reconnecting', 'engine connection lost');
        this.awaitEngine(800);
      } else {
        this.onFail();
      }
    };
  }

  /** Poll healthz (silently) until the engine is back, then reconnect. */
  awaitEngine(delay) {
    setTimeout(async () => {
      if (this.ws) return;
      if (await this.probe()) this.connect();
      else this.awaitEngine(Math.min(5000, delay * 1.6));
    }, delay);
  }

  onFail() {
    this.attempts++;
    if (this.demo) return; // already in fallback; scheduleProbe keeps looking
    if (this.attempts >= 2) {
      this.fallbackDemo();
      return;
    }
    this.awaitEngine(Math.min(10000, 400 * 2 ** this.attempts));
  }

  onMessage(data) {
    const t0 = performance.now();
    try {
      this.dispatch(data);
    } finally {
      const m = this.msgMs;
      m.acc += performance.now() - t0;
      if (t0 - m.at > 1000) {
        m.rate = (m.acc * 1000) / (t0 - m.at);
        m.acc = 0;
        m.at = t0;
      }
    }
  }

  dispatch(data) {
    if (typeof data === 'string') {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        console.warn('telluric: bad JSON frame');
        return;
      }
      if (msg.t === 'hello') {
        this.gotHello = true;
        this.attempts = 0;
        if (this.demo) this.stopDemo();
        this.store.reset();
        this.setState(msg.mode === 'replay' ? 'replay' : msg.mode === 'demo' ? 'demo' : 'live', msg.server || '');
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ t: 'ping' }), 20000);
      }
      this.store.handle(msg);
    } else if (data instanceof ArrayBuffer) {
      try {
        if (decodeBinary(data, this.batch)) this.store.emit('pkts', this.batch);
      } catch (e) {
        console.warn('telluric: bad binary frame', e);
      }
    }
  }

  /** Client → engine command (alert workflow). Demo mode handles it locally. */
  command(cmd) {
    if (this.demo) {
      this.demo.command(cmd);
      return true;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
      return true;
    }
    return false;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  startDemo(detail) {
    this.store.reset();
    const home = this.demoHome();
    this.demo = new DemoSimulator({
      home,
      onMessage: (m) => this.store.handle(m),
      onBinary: (buf) => this.onMessage(buf),
      seed: Number(this.params.get('seed')) || 1337,
      stress: Math.min(4000, Number(this.params.get('stress')) || 0),
    });
    this.setState('demo', detail);
    this.demo.start();
  }

  stopDemo() {
    if (this.demo) this.demo.stop();
    this.demo = null;
    clearInterval(this.probeTimer);
  }

  demoHome() {
    const h = this.params.get('home');
    if (h) {
      const [lat, lon] = h.split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, city: 'Custom', cc: '' };
    }
    return { lat: 50.1109, lon: 8.6821, city: 'Frankfurt am Main', cc: 'DE' };
  }

  /** In fallback demo mode, look for an engine every 10 s (silently). */
  scheduleProbe() {
    if (this.params.has('demo')) return;
    clearInterval(this.probeTimer);
    this.probeTimer = setInterval(async () => {
      if (!this.demo || this.ws) return;
      if (await this.probe()) this.connect();
    }, 10000);
  }
}

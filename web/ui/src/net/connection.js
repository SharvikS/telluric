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
    this.connect();
  }

  wsUrl() {
    const url = new URL('ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.token) url.searchParams.set('token', this.token);
    return url.toString();
  }

  connect() {
    this.setState(this.attempts ? 'reconnecting' : 'connecting');
    let ws;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch (e) {
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
        // We had a session: keep the world on screen and reconnect.
        this.attempts = 1;
        this.setState('reconnecting', 'engine connection lost');
        setTimeout(() => this.connect(), 800);
      } else {
        this.onFail();
      }
    };
  }

  onFail() {
    this.attempts++;
    if (this.attempts >= 2 && !this.demo) {
      this.startDemo('no engine found — running the built-in demo');
      this.scheduleProbe();
      return;
    }
    const delay = Math.min(10000, 400 * 2 ** this.attempts);
    setTimeout(() => this.connect(), delay);
  }

  onMessage(data) {
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
        this.setState(msg.mode === 'replay' ? 'replay' : 'live', msg.server || '');
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

  /** In fallback demo mode, look for an engine every 10 s. */
  scheduleProbe() {
    if (this.params.has('demo')) return;
    clearInterval(this.probeTimer);
    this.probeTimer = setInterval(() => {
      if (!this.demo || this.ws) return;
      const ws = new WebSocket(this.wsUrl());
      ws.binaryType = 'arraybuffer';
      const kill = setTimeout(() => ws.close(), 4000);
      ws.onmessage = (ev) => {
        clearTimeout(kill);
        if (typeof ev.data === 'string' && ev.data.includes('"hello"')) {
          this.ws = ws;
          ws.onmessage = (e2) => this.onMessage(e2.data);
          ws.onclose = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.setState('reconnecting', 'engine connection lost');
            setTimeout(() => this.connect(), 800);
          };
          this.onMessage(ev.data);
        }
      };
      ws.onerror = () => clearTimeout(kill);
    }, 10000);
  }
}

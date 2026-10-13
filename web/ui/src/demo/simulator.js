import { encodePkts } from '../net/protocol.js';
import { angularDistance } from '../util/math.js';
import { ENDPOINTS, LAN, PROCS, JA4, BROWSING } from './catalog.js';

// A synthetic engine. It keeps the same entities the Go engine keeps and
// emits exactly the wire protocol (JSON objects plus binary PKTS frames), so
// the UI cannot tell it apart from a live capture. Traffic follows shaped
// rate profiles; a scripted timeline loops through showcase scenes and every
// alert kind.

const TICK_MS = 50;
const LOOP_S = 216;
const ALPHA = 1 - Math.exp(-TICK_MS / 1000 / 2); // EWMA, τ = 2 s
const SEV_WEIGHT = { info: 1, low: 3, medium: 8, high: 20, critical: 45 };

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DemoSimulator {
  constructor({ home, onMessage, onBinary, seed = 1337 }) {
    this.home = home;
    this.onMessage = onMessage;
    this.onBinary = onBinary;
    this.rand = mulberry32(seed);
    this.catalog = new Map([...ENDPOINTS, ...LAN].map((e) => [e.key, e]));
    this.eps = new Map(); // catalog key → Endpoint
    this.epById = new Map();
    this.epActivity = new Map(); // ep id → last activity ms
    this.flows = new Map(); // id → { f, s }
    this.procs = new Map(); // key → Proc
    this.alerts = [];
    this.ids = { ep: 1, flow: 1, proc: 1, alert: 1 };
    this.dnsCache = new Map();
    this.totals = { rx: 0, tx: 0, pkts: 0 };
    this.timers = [];
    this.elapsed = 0; // seconds since start
    this.loopAt = 0;
    this.nextBrowse = 2.5;
    this.nextPrefetch = 4;
    this.silent = false;
    this.tickN = 0;
    this.history = [];
    this.timeline = this.buildTimeline();
    this.cursor = 0;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  start() {
    const now = Date.now();
    this.emit({
      t: 'hello', v: 1, server: 'telluric-demo/1.0', mode: 'demo', host: 'demo-box', now,
      home: { ...this.home, src: 'flag' },
      ifaces: ['wlan0'],
      features: { procs: true, geo: true, intel: true },
      credits: [
        'IP geolocation by DB-IP (https://db-ip.com)',
        'Map data from Natural Earth (public domain)',
        'Simulated traffic — no real capture in demo mode',
      ],
    });
    // Build the baseline silently, warm it up, then send it as the snapshot.
    this.silent = true;
    this.baseline();
    for (let i = 0; i < 60; i++) this.step(false);
    this.silent = false;
    this.emit({
      t: 'snapshot',
      endpoints: [...this.epById.values()],
      flows: [...this.flows.values()].map((x) => x.f),
      procs: [...this.procs.values()],
      alerts: [],
      dns: [],
      stats: this.stats(),
      history: this.history.slice(),
    });
    this.timer = setInterval(() => this.step(true), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  emit(msg) {
    if (!this.silent) this.onMessage(msg);
  }

  // ── entities ──────────────────────────────────────────────────────────────

  now() {
    return Date.now();
  }

  proc(key) {
    let p = this.procs.get(key);
    if (p) return p;
    const d = PROCS[key];
    p = { id: this.ids.proc++, ...d, container: null, bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0, flows: 0 };
    this.procs.set(key, p);
    this.emit({ t: 'proc', items: [p] });
    return p;
  }

  endpoint(key) {
    let e = this.eps.get(key);
    if (e) return e;
    const c = this.catalog.get(key);
    const now = this.now();
    e = {
      id: this.ids.ep++,
      ip: c.ip,
      name: c.name || null,
      names: [c.name, ...(c.cname || [])].filter(Boolean),
      scope: c.scope || 'public',
      lat: c.lat ?? null, lon: c.lon ?? null,
      city: c.city || null, region: c.region || null, cc: c.cc || null, country: c.country || null,
      asn: c.asn || null, org: c.org || null, svc: c.svc || null,
      threat: 0, tags: [...(c.tags || [])],
      first: now, last: now, bytesIn: 0, bytesOut: 0, rateIn: 0, rateOut: 0, flows: 0,
    };
    this.eps.set(key, e);
    this.epById.set(e.id, e);
    this.epActivity.set(e.id, now);
    this.emit({ t: 'ep', items: [e] });
    return e;
  }

  rttTo(c) {
    if (c.lat == null) return 1.5 + this.rand() * 3;
    const km = angularDistance(this.home.lat, this.home.lon, c.lat, c.lon) * 6371;
    return Math.round((6 + (km / 100) * 1.35 + this.rand() * 8) * 10) / 10;
  }

  dns(name, ips, opts = {}) {
    if (!name) return;
    const now = this.now();
    if (!opts.force && (this.dnsCache.get(name) || 0) > now) return;
    this.dnsCache.set(name, now + 60000);
    const eps = [];
    for (const ip of ips) for (const e of this.epById.values()) if (e.ip === ip) eps.push(e.id);
    this.emit({
      t: 'dns',
      items: [{
        ts: now, q: name, qtype: opts.qtype || 'A', rcode: opts.rcode || 'NOERROR',
        answers: opts.rcode && opts.rcode !== 'NOERROR' ? [] : ips, cname: opts.cname || [], eps,
        server: opts.server || '127.0.0.53', ms: opts.ms ?? Math.round((1 + this.rand() * 30) * 10) / 10,
        proc: opts.proc || 0,
      }],
    });
  }

  /**
   * Opens a flow to catalog endpoint `key` from process `procKey`.
   * opts: rin/rout (B/s), shape, duration (s), dir, app, proto, rport, threat, dns (bool), delay (s)…
   */
  open(key, procKey, opts = {}) {
    const c = this.catalog.get(key);
    const p = procKey ? this.proc(procKey) : null;
    if (opts.dns !== false && c.name && c.scope !== 'lan' && c.scope !== 'multicast') {
      this.dns(c.name, [c.ip], { cname: c.cname, proc: p ? p.id : 0 });
    }
    const go = () => this.openNow(key, p, c, opts);
    if (this.silent || opts.delay === 0) return go();
    this.after(opts.delay ?? 0.04 + this.rand() * 0.12, go);
    return null;
  }

  openNow(key, p, c, opts) {
    const e = this.endpoint(key);
    const now = this.now();
    const app = opts.app || c.app || 'tls';
    const proto = opts.proto || c.proto || (app === 'quic' ? 'udp' : 'tcp');
    const tls = app === 'tls' || app === 'quic' || app === 'doh';
    const ech = !!(opts.ech ?? c.ech);
    const f = {
      id: this.ids.flow++, ep: e.id, proc: p ? p.id : 0, proto, app,
      lport: opts.lport || (opts.dir === 'in' ? (opts.rlocal || 22) : 32768 + Math.floor(this.rand() * 28000)),
      rport: opts.rport ?? c.port ?? 443,
      dir: opts.dir || 'out',
      state: proto === 'tcp' ? 'syn' : 'active',
      sni: tls ? (ech ? 'cloudflare-ech.com' : opts.sni !== undefined ? opts.sni : c.name) : null,
      alpn: tls ? (opts.alpn || c.alpn || (app === 'quic' ? 'h3' : 'h2')) : null,
      tlsv: tls ? (opts.tlsv || '1.3') : null,
      ja4: tls ? (opts.ja4 || (app === 'quic' ? JA4.firefoxQuic : JA4.firefox)) : null,
      ech: tls ? ech : null,
      pq: tls ? (opts.tlsv || '1.3') === '1.3' && ![JA4.python, JA4.go, JA4.legacy, JA4.steam].includes(opts.ja4) : null,
      bytesIn: 0, bytesOut: 0, pktsIn: 0, pktsOut: 0, rateIn: 0, rateOut: 0,
      rtt: proto === 'tcp' ? this.rttTo(c) : null,
      start: now, last: now, threat: opts.threat || 0,
    };
    const s = {
      key, rin: opts.rin ?? 2000, rout: opts.rout ?? 400, pin: opts.pin ?? (proto === 'udp' ? 1250 : 1400),
      pout: opts.pout ?? (proto === 'udp' ? 300 : 90), shape: opts.shape || 'steady', born: this.elapsed,
      until: opts.duration != null ? this.elapsed + opts.duration : Infinity, n: 1, accIn: 0, accOut: 0,
      phase: this.rand() * 10, dirty: true, closedAt: 0, period: opts.period || 0,
    };
    this.flows.set(f.id, { f, s });
    if (f.proto === 'tcp' && !this.silent) {
      this.after(Math.max(0.03, (f.rtt || 30) / 1000), () => { f.state = 'est'; s.dirty = true; });
    } else if (f.proto === 'tcp') {
      f.state = 'est';
    }
    this.epActivity.set(e.id, now);
    if (!this.silent) this.emit({ t: 'flow', items: [f] });
    if (opts.onOpen) opts.onOpen(f, e);
    return f;
  }

  close(f, reset = false) {
    const x = this.flows.get(f.id);
    if (!x || x.s.closedAt) return;
    x.s.closedAt = this.elapsed;
    x.s.until = this.elapsed;
    if (f.proto === 'tcp') {
      f.state = reset ? 'rst' : 'fin';
      this.after(0.6, () => { f.state = 'closed'; x.s.dirty = true; });
    }
    x.s.dirty = true;
  }

  after(sec, fn) {
    this.timers.push({ at: this.elapsed + sec, fn });
  }

  raise(kind, sev, title, detail, { ep = 0, flow = 0, proc = 0, score = 50, evidence = {}, tag } = {}) {
    const a = { id: this.ids.alert++, ts: this.now(), sev, kind, title, detail, ep, flow, proc, score, evidence };
    this.alerts.push(a);
    if (this.alerts.length > 200) this.alerts.shift();
    this.emit({ t: 'alert', items: [a] });
    const e = this.epById.get(ep);
    if (e) {
      e.threat = Math.max(e.threat, score);
      if (tag && !e.tags.includes(tag)) e.tags.push(tag);
      this.emit({ t: 'ep', items: [e] });
    }
    const x = this.flows.get(flow);
    if (x) {
      x.f.threat = Math.max(x.f.threat, score);
      x.s.dirty = true;
    }
    return a;
  }

  // ── simulation step ───────────────────────────────────────────────────────

  shape(s, t) {
    const age = t - s.born;
    switch (s.shape) {
      case 'video': { // DASH-style: fetch a segment every ~4 s
        const ph = (t + s.phase) % 4.2;
        return ph < 1.5 ? 1 : 0.025;
      }
      case 'chunky': { // music: a burst per track chunk
        const ph = (t + s.phase) % 11;
        return ph < 1.8 ? 1 : 0.02;
      }
      case 'sse': { // LLM token streaming: request, then a long trickle
        const ph = (t + s.phase) % 9;
        return ph < 0.4 ? 1 : ph < 5 ? 0.35 : 0.01;
      }
      case 'interactive':
        return this.rand() < 0.12 ? 1 : 0.05;
      case 'ramp':
        return Math.min(1, age / 2.5) * (0.85 + 0.15 * Math.sin(t * 1.7 + s.phase));
      case 'decay':
        return Math.max(0.04, Math.exp(-age / 2.2));
      case 'burst':
        return age < 0.6 ? 1 : 0.02;
      case 'idle':
        return this.rand() < 0.02 ? 1 : 0.01;
      default:
        return 1;
    }
  }

  step(emitPackets) {
    const dt = TICK_MS / 1000;
    this.elapsed += dt;
    this.tickN++;
    const t = this.elapsed;
    const now = this.now();

    // Timers and the scripted timeline.
    if (this.timers.length) {
      const due = this.timers.filter((x) => x.at <= t);
      this.timers = this.timers.filter((x) => x.at > t);
      for (const x of due) x.fn();
    }
    if (!this.silent) {
      const lt = t - this.loopAt;
      while (this.cursor < this.timeline.length && this.timeline[this.cursor][0] <= lt) {
        this.timeline[this.cursor][1]();
        this.cursor++;
      }
      if (lt >= LOOP_S) {
        this.loopAt = t;
        this.cursor = 0;
      }
      if (t >= this.nextBrowse) {
        this.browse();
        this.nextBrowse = t + 0.9 + this.rand() * 2.6;
      }
      if (t >= this.nextPrefetch) {
        const [k] = BROWSING[Math.floor(this.rand() * BROWSING.length)];
        const c = this.catalog.get(k);
        this.dns(c.name, [c.ip], { cname: c.cname, proc: this.proc('firefox').id });
        this.nextPrefetch = t + 3 + this.rand() * 5;
      }
    }

    // Traffic.
    const records = [];
    let active = 0;
    for (const x of this.flows.values()) if (!x.s.closedAt) active++;
    const maxShots = Math.max(1, Math.min(8, Math.floor(1400 / Math.max(1, active) / 2)));
    for (const x of this.flows.values()) {
      const { f, s } = x;
      let instIn = 0, instOut = 0;
      if (!s.closedAt) {
        if (t >= s.until) {
          this.close(f);
        } else {
          s.n = s.n * 0.8 + (0.55 + this.rand() * 0.9) * 0.2;
          const m = this.shape(s, t) * s.n;
          const bIn = s.rin * m * dt, bOut = s.rout * m * dt;
          s.accIn += bIn / s.pin;
          s.accOut += bOut / s.pout;
          const nIn = Math.floor(s.accIn), nOut = Math.floor(s.accOut);
          s.accIn -= nIn;
          s.accOut -= nOut;
          if (nIn > 0) {
            const b = Math.round(nIn * s.pin * (0.86 + 0.14 * this.rand()));
            instIn = b / dt;
            f.bytesIn += b; f.pktsIn += nIn;
            this.totals.rx += b;
            if (emitPackets) this.shots(records, f.id, nIn, b, 1, maxShots);
          }
          if (nOut > 0) {
            const b = Math.round(nOut * s.pout * (0.8 + 0.2 * this.rand()));
            instOut = b / dt;
            f.bytesOut += b; f.pktsOut += nOut;
            this.totals.tx += b;
            if (emitPackets) this.shots(records, f.id, nOut, b, 0, maxShots);
          }
          this.totals.pkts += nIn + nOut;
          if (nIn + nOut > 0) {
            f.last = now;
            this.epActivity.set(f.ep, now);
          }
        }
      }
      f.rateIn += (instIn - f.rateIn) * ALPHA;
      f.rateOut += (instOut - f.rateOut) * ALPHA;
    }
    if (emitPackets && records.length) this.onBinary(encodePkts(now, records));

    // Periodic upserts.
    if (this.tickN % 5 === 0) {
      const s = this.stats();
      if (this.tickN % 20 === 0) {
        this.history.push(s);
        if (this.history.length > 300) this.history.shift();
      }
      this.emit({ t: 'stats', ...s });
    }
    if (this.tickN % 10 === 0) this.flushUpserts();
    if (this.tickN % 20 === 0) this.reap();
  }

  shots(out, flow, n, bytes, inbound, maxShots) {
    const k = n <= 3 ? n : Math.min(maxShots, 3 + Math.floor(Math.log2(n)));
    const shots = Math.max(1, Math.min(k, maxShots));
    for (let i = 0; i < shots; i++) {
      const p = Math.max(1, Math.round(n / shots));
      out.push([flow, bytes / shots, Math.floor(this.rand() * TICK_MS), Math.min(255, p), inbound ? 1 : 0]);
    }
  }

  flushUpserts() {
    if (this.silent) return;
    const flows = [];
    const touched = new Set();
    for (const { f, s } of this.flows.values()) {
      if (s.dirty || f.rateIn + f.rateOut > 1 || !s.closedAt) {
        flows.push(f);
        touched.add(f.ep);
        s.dirty = false;
      }
    }
    // Endpoint and process aggregates.
    const epAgg = new Map();
    const procAgg = new Map();
    for (const { f, s } of this.flows.values()) {
      const a = epAgg.get(f.ep) || { bi: 0, bo: 0, ri: 0, ro: 0, n: 0 };
      a.bi += f.bytesIn; a.bo += f.bytesOut; a.ri += f.rateIn; a.ro += f.rateOut;
      if (!s.closedAt) a.n++;
      epAgg.set(f.ep, a);
      if (f.proc) {
        const b = procAgg.get(f.proc) || { bi: 0, bo: 0, ri: 0, ro: 0, n: 0 };
        b.bi += f.bytesIn; b.bo += f.bytesOut; b.ri += f.rateIn; b.ro += f.rateOut;
        if (!s.closedAt) b.n++;
        procAgg.set(f.proc, b);
      }
    }
    const eps = [];
    for (const id of touched) {
      const e = this.epById.get(id);
      const a = epAgg.get(id);
      if (!e || !a) continue;
      e.bytesIn = Math.max(e.bytesIn, a.bi);
      e.bytesOut = Math.max(e.bytesOut, a.bo);
      e.rateIn = a.ri;
      e.rateOut = a.ro;
      e.flows = a.n;
      e.last = this.epActivity.get(id) || e.last;
      eps.push(e);
    }
    if (flows.length) this.emit({ t: 'flow', items: flows });
    if (eps.length) this.emit({ t: 'ep', items: eps });
    if (this.tickN % 20 === 0) {
      const procs = [];
      for (const p of this.procs.values()) {
        const b = procAgg.get(p.id);
        if (b) {
          p.bytesIn = Math.max(p.bytesIn, b.bi); p.bytesOut = Math.max(p.bytesOut, b.bo);
          p.rateIn = b.ri; p.rateOut = b.ro; p.flows = b.n;
        } else {
          p.rateIn = 0; p.rateOut = 0; p.flows = 0;
        }
        procs.push(p);
      }
      if (procs.length) this.emit({ t: 'proc', items: procs });
    }
  }

  /** Expire closed flows after 8 s and idle endpoints after 40 s. */
  reap() {
    const t = this.elapsed;
    const now = this.now();
    const gone = { flows: [], eps: [], procs: [] };
    for (const [id, { s }] of this.flows) {
      if (s.closedAt && t - s.closedAt > 8) {
        this.flows.delete(id);
        gone.flows.push(id);
      }
    }
    const live = new Set();
    for (const { f } of this.flows.values()) live.add(f.ep);
    for (const [key, e] of this.eps) {
      if (live.has(e.id)) continue;
      if (now - (this.epActivity.get(e.id) || 0) > 40000) {
        this.eps.delete(key);
        this.epById.delete(e.id);
        this.epActivity.delete(e.id);
        gone.eps.push(e.id);
      }
    }
    if (gone.flows.length || gone.eps.length) this.emit({ t: 'gone', ...gone });
  }

  stats() {
    let rx = 0, tx = 0, pps = 0, flows = 0;
    const apps = {};
    const cc = new Set();
    const procs = new Set();
    for (const { f, s } of this.flows.values()) {
      rx += f.rateIn;
      tx += f.rateOut;
      if (!s.closedAt) {
        flows++;
        pps += f.rateIn / s.pin + f.rateOut / s.pout;
        if (f.proc) procs.add(f.proc);
      }
      apps[f.app] = (apps[f.app] || 0) + f.rateIn + f.rateOut;
      const e = this.epById.get(f.ep);
      if (e && e.cc && e.scope === 'public' && !s.closedAt) cc.add(e.cc);
    }
    const now = this.now();
    let score = 0;
    for (const a of this.alerts) score += SEV_WEIGHT[a.sev] * Math.exp(-(now - a.ts) / 90000);
    const defcon = score < 8 ? 5 : score < 25 ? 4 : score < 55 ? 3 : score < 95 ? 2 : 1;
    for (const k of Object.keys(apps)) apps[k] = Math.round(apps[k]);
    return {
      ts: now, rx: Math.round(rx), tx: Math.round(tx), pps: Math.round(pps), flows,
      eps: this.epById.size, countries: cc.size, procs: procs.size, drops: 0, defcon, apps,
      totals: { ...this.totals },
    };
  }

  // ── behaviours ────────────────────────────────────────────────────────────

  baseline() {
    this.open('google', 'firefox', { rin: 9000, rout: 1500, shape: 'idle' });
    this.open('youtube', 'firefox', { rin: 3000, rout: 600, shape: 'idle' });
    this.open('cloudflare', 'firefox', { rin: 4000, rout: 900, shape: 'idle', ech: true });
    this.open('discord', 'discord', { rin: 1800, rout: 700, ja4: JA4.chromium });
    this.open('spotify', 'spotify', { rin: 1500, rout: 500, ja4: JA4.chromium });
    this.open('spotify-audio', 'spotify', { rin: 320000, rout: 4000, shape: 'chunky', ja4: JA4.chromium });
    this.open('github-api', 'code', { rin: 2500, rout: 900, shape: 'idle', ja4: JA4.chromium });
    this.open('anthropic', 'claude', { rin: 26000, rout: 9000, shape: 'sse', ja4: JA4.node });
    this.open('bastion', 'ssh', { rin: 900, rout: 500, shape: 'interactive', app: 'ssh' });
    this.open('docker', 'dockerd', { rin: 300, rout: 200, shape: 'idle', ja4: JA4.go });
    this.open('doh', 'firefox', { rin: 1200, rout: 600, app: 'doh', shape: 'idle' });
    this.open('telegram', 'firefox', { rin: 1200, rout: 400, shape: 'idle' });
    this.open('router', null, { rin: 120, rout: 60, app: 'unknown', proto: 'udp', rport: 53, dns: false, shape: 'idle' });
    this.open('mdns', 'avahi', { rin: 300, rout: 120, proto: 'udp', dns: false, shape: 'idle' });
    this.open('tv', null, { rin: 200, rout: 0, proto: 'udp', dir: 'in', dns: false, shape: 'idle', rlocal: 1900 });
    this.open('ntp', 'timesyncd', { rin: 90, rout: 90, proto: 'udp', app: 'ntp', shape: 'idle' });
    this.open('wikipedia', 'firefox', { rin: 6000, rout: 1200, shape: 'decay', duration: 30 });
    this.open('jio', 'firefox', { rin: 5000, rout: 900, shape: 'idle', duration: 40 });
    this.open('naver', 'firefox', { rin: 7000, rout: 1000, shape: 'decay', duration: 25 });
    this.open('mirror', 'pacman', { rin: 90000, rout: 3000, shape: 'decay', duration: 20 });
  }

  pick(list) {
    const total = list.reduce((s, [, w]) => s + w, 0);
    let r = this.rand() * total;
    for (const [k, w] of list) if ((r -= w) <= 0) return k;
    return list[0][0];
  }

  browse() {
    const key = this.pick(BROWSING);
    const c = this.catalog.get(key);
    const quic = c.app === 'quic';
    this.open(key, 'firefox', {
      rin: 30000 + this.rand() * 520000,
      rout: 3000 + this.rand() * 26000,
      shape: 'decay',
      duration: 4 + this.rand() * 16,
      app: quic ? 'quic' : 'tls',
    });
  }

  buildTimeline() {
    const T = [];
    const at = (s, fn) => T.push([s, fn]);

    at(5, () => this.sceneVideo());
    at(14, () => this.alertIntel());
    at(26, () => this.sceneQuicTour());
    at(38, () => this.sceneSteam());
    at(50, () => this.alertDga());
    at(64, () => this.sceneGitPush());
    at(72, () => this.alertBeacon());
    at(92, () => this.alertScan());
    at(106, () => this.alertCleartext());
    at(119, () => this.alertTunnel());
    at(133, () => this.alertMiner());
    at(147, () => this.alertExfil());
    at(162, () => this.alertTor());
    at(175, () => this.alertArp());
    at(186, () => this.alertMisc());
    at(198, () => this.sceneVideo());
    return T.sort((a, b) => a[0] - b[0]);
  }

  sceneVideo() {
    this.open('googlevideo', 'firefox', { rin: 7_500_000, rout: 60_000, shape: 'video', duration: 48, app: 'quic', pin: 1300, pout: 70 });
    this.open('gstatic', 'firefox', { rin: 220_000, rout: 9000, shape: 'decay', duration: 6, app: 'quic' });
  }

  sceneQuicTour() {
    const keys = ['nhk', 'abc', 'straits', 'globo', 'news24', 'cbc', 'bbc', 'instagram', 'reddit', 'naver', 'jio', 'x'];
    keys.forEach((k, i) => this.after(i * 0.7, () => this.open(k, 'firefox', {
      rin: 200_000 + this.rand() * 900_000, rout: 12_000 + this.rand() * 30_000, shape: 'decay', duration: 6 + this.rand() * 8,
    })));
  }

  sceneSteam() {
    this.open('steam-api', 'steam', { rin: 40_000, rout: 6000, shape: 'decay', duration: 8, ja4: JA4.steam });
    ['steam-cdn1', 'steam-cdn2', 'steam-cdn3', 'steam-cdn1'].forEach((k, i) => this.after(0.8 + i * 0.35, () =>
      this.open(k, 'steam', { rin: 11_000_000, rout: 120_000, shape: 'ramp', duration: 26, app: 'http', pout: 66, dns: i < 3 })));
  }

  sceneGitPush() {
    this.open('github-ssh', 'git', { rin: 30_000, rout: 2_800_000, shape: 'ramp', duration: 7, app: 'ssh', pin: 120, pout: 1400 });
  }

  alertIntel() {
    this.open('c2', 'python', {
      rin: 6000, rout: 14000, duration: 18, ja4: JA4.python, sni: 'update-cdn.example',
      onOpen: (f, e) => this.after(1.2, () => this.raise('intel', 'critical',
        'Connection to a known botnet C2 server',
        `python3 (pid ${PROCS.python.pid}) → ${e.ip}:443 — listed on abuse.ch Feodo Tracker (demo data)`,
        { ep: e.id, flow: f.id, proc: this.proc('python').id, score: 96, tag: 'c2',
          evidence: { feed: 'abuse.ch Feodo Tracker', listing: 'botnet C2', first_listed: '2026-09-28', sni: 'update-cdn.example' } })),
    });
  }

  alertDga() {
    const tlds = ['com', 'net', 'org', 'info', 'top', 'biz'];
    const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const names = [];
    for (let i = 0; i < 26; i++) {
      this.after(i * 0.22, () => {
        let s = '';
        const n = 10 + Math.floor(this.rand() * 6);
        for (let k = 0; k < n; k++) s += alpha[Math.floor(this.rand() * (k ? alpha.length : 26))];
        const name = `${s}.${tlds[Math.floor(this.rand() * tlds.length)]}`;
        names.push(name);
        this.dns(name, [], { rcode: 'NXDOMAIN', force: true, ms: 18 + this.rand() * 40 });
      });
    }
    this.after(6.2, () => this.raise('dga', 'high',
      'Burst of algorithmically generated domains',
      `${names.length} NXDOMAIN answers in 6 s for high-entropy names (e.g. ${names[0]}); bigram score −4.3`,
      { score: 82, evidence: { nxdomain: names.length, window_s: 6, sample: names.slice(0, 4), entropy: 3.6, bigram: -4.3 } }));
  }

  sceneBeacon(count, done) {
    const one = (i) => {
      this.open('beacon', 'python', {
        rin: 2600, rout: 1400, shape: 'burst', duration: 1.1, ja4: JA4.python, sni: null, dns: false,
        onOpen: (f, e) => { if (i === count - 1) done(f, e); },
      });
      if (i + 1 < count) this.after(5 + (this.rand() - 0.5) * 0.3, () => one(i + 1));
    };
    one(0);
  }

  alertBeacon() {
    this.sceneBeacon(7, (f, e) => this.after(0.6, () => this.raise('beacon', 'high',
      'Periodic beaconing to an unfamiliar host',
      `python3 (pid ${PROCS.python.pid}) → ${e.ip}:8443 every 5.0 s ±0.1 s, 7 times, no DNS lookup`,
      { ep: e.id, flow: f.id, proc: this.proc('python').id, score: 78,
        evidence: { interval_s: 5.0, jitter: 0.024, count: 7, bowley_skew: 0.04, dns: false } })));
  }

  alertScan() {
    const ports = [21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 443, 445, 993, 995, 1433, 1723, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 9200, 11211, 27017];
    ports.forEach((port, i) => this.after(i * 0.13, () => this.open('iot', null, {
      dir: 'in', rlocal: port, rport: 40000 + i, lport: port, rin: 300, rout: 120, shape: 'burst', duration: 0.4,
      app: 'unknown', dns: false, pin: 60, pout: 54,
      onOpen: (f) => this.after(0.15, () => this.close(f, true)),
    })));
    this.after(ports.length * 0.13 + 0.5, () => {
      const e = this.eps.get('iot');
      this.raise('scan', 'medium', 'Port scan from a device on your network',
        `192.168.1.66 probed ${ports.length} TCP ports in ${(ports.length * 0.13).toFixed(1)} s (SYN scan), 2 answered`,
        { ep: e ? e.id : 0, score: 58, evidence: { ports: ports.length, window_s: +(ports.length * 0.13).toFixed(1), sample: ports.slice(0, 8), open: [22, 8080] } });
    });
  }

  alertCleartext() {
    this.open('router', 'firefox', {
      app: 'http', rport: 80, rin: 40_000, rout: 4000, shape: 'decay', duration: 6, dns: false,
      onOpen: (f, e) => this.after(0.8, () => this.raise('cleartext', 'high',
        'Credentials sent in clear text',
        `firefox (pid ${PROCS.firefox.pid}) → 192.168.1.1:80 — HTTP Basic authorization for user "admin"`,
        { ep: e.id, flow: f.id, proc: this.proc('firefox').id, score: 70, evidence: { protocol: 'HTTP Basic', user: 'admin', host: '192.168.1.1', path: '/cgi-bin/luci' } })),
    });
  }

  alertTunnel() {
    let n = 0;
    const hex = '0123456789abcdef';
    const tick = () => {
      let label = '';
      for (let i = 0; i < 52; i++) label += hex[Math.floor(this.rand() * 16)];
      this.dns(`${label}.t.tunnel.example`, [], { qtype: 'TXT', force: true, ms: 40 + this.rand() * 30 });
      n++;
    };
    for (let i = 0; i < 24; i++) this.after(i * 0.3, tick);
    this.open('resolver', 'resolved', {
      app: 'dns', proto: 'udp', rport: 53, rin: 9000, rout: 7000, duration: 8, dns: false, pin: 220, pout: 160,
      onOpen: (f, e) => this.after(7.6, () => this.raise('tunnel', 'high', 'DNS tunneling pattern',
        `${n} TXT queries in 8 s to t.tunnel.example with 52-character high-entropy labels`,
        { ep: e.id, flow: f.id, score: 74, evidence: { queries: n, apex: 't.tunnel.example', label_len: 52, entropy: 3.98, qtype: 'TXT' } })),
    });
  }

  alertMiner() {
    this.open('pool', 'xmrig', {
      app: 'unknown', rport: 3333, rin: 1800, rout: 1200, duration: 40, dns: true,
      onOpen: (f, e) => this.after(1.5, () => this.raise('miner', 'high',
        'Cryptomining protocol (Stratum) detected',
        `xmrig (pid ${PROCS.xmrig.pid}) → ${e.ip}:3333 — JSON-RPC "login" from XMRig/6.22`,
        { ep: e.id, flow: f.id, proc: this.proc('xmrig').id, score: 85, tag: 'miner', evidence: { protocol: 'stratum', agent: 'XMRig/6.22.2', method: 'login', pool: 'pool.hashfall.example' } })),
    });
  }

  alertExfil() {
    this.open('exfil', 'rclone', {
      rin: 90_000, rout: 9_000_000, shape: 'ramp', duration: 16, ja4: JA4.go, pin: 90, pout: 1400,
      onOpen: (f, e) => this.after(9, () => this.raise('exfil', 'high',
        'Large upload to an unfamiliar destination',
        `rclone (pid ${PROCS.rclone.pid}) sent ${Math.round(f.bytesOut / 1e6)} MB to ${e.ip} (first contact), 41× its usual upload`,
        { ep: e.id, flow: f.id, proc: this.proc('rclone').id, score: 72, evidence: { bytes_out: f.bytesOut, out_in_ratio: Math.round(f.bytesOut / Math.max(1, f.bytesIn)), baseline_x: 41, first_contact: true } })),
    });
  }

  alertTor() {
    this.open('tor1', 'tor', {
      rport: 9001, rin: 40_000, rout: 12_000, duration: 30, dns: false, sni: null, ja4: JA4.go,
      onOpen: (f, e) => this.after(1, () => this.raise('tor', 'medium', 'Connection to the Tor network',
        `tor (pid ${PROCS.tor.pid}) → ${e.ip}:9001 — listed Tor relay (Guard, Fast, Stable)`,
        { ep: e.id, flow: f.id, proc: this.proc('tor').id, score: 45, tag: 'tor', evidence: { relay: 'demoRelayReykjavik', flags: 'Guard Fast Stable', source: 'Tor bulk exit list' } })),
    });
    this.after(2, () => this.open('tor2', 'tor', { rport: 9001, rin: 30_000, rout: 9000, duration: 26, dns: false, sni: null, ja4: JA4.go }));
  }

  alertArp() {
    const e = this.endpoint('router');
    this.raise('arp-spoof', 'critical', 'Gateway MAC address changed — possible ARP spoofing',
      '192.168.1.1 moved from a4:91:b1:2c:00:01 to de:ad:be:ef:13:37, 0.4 s after an unsolicited ARP reply',
      { ep: e.id, score: 92, evidence: { ip: '192.168.1.1', old_mac: 'a4:91:b1:2c:00:01', new_mac: 'de:ad:be:ef:13:37', gratuitous: true } });
  }

  alertMisc() {
    this.open('news24', 'steam', {
      rin: 90_000, rout: 4000, shape: 'decay', duration: 8,
      onOpen: (f, e) => this.after(0.5, () => this.raise('novel', 'info', 'First contact with a new country',
        `steam (pid ${PROCS.steam.pid}) → South Africa — first connection there in 30 days`,
        { ep: e.id, flow: f.id, proc: this.proc('steam').id, score: 10, evidence: { country: 'ZA', window_days: 30 } })),
    });
    this.after(3, () => this.open('irc', 'python', {
      rport: 6667, app: 'unknown', rin: 900, rout: 400, duration: 14,
      onOpen: (f, e) => this.after(0.6, () => this.raise('port', 'low', 'Connection on a port associated with IRC botnets',
        `python3 (pid ${PROCS.python.pid}) → ${e.ip}:6667 (IRC)`,
        { ep: e.id, flow: f.id, proc: this.proc('python').id, score: 32, evidence: { port: 6667, service: 'IRC' } })),
    }));
    this.after(6, () => this.open('legacytls', 'python', {
      rin: 12_000, rout: 3000, duration: 6, tlsv: '1.0', ja4: JA4.legacy, alpn: null,
      onOpen: (f, e) => this.after(0.4, () => this.raise('tls', 'low', 'Legacy TLS 1.0 handshake',
        `python3 offered at most TLS 1.0 to ${e.ip} (SNI legacy-api.example)`,
        { ep: e.id, flow: f.id, proc: this.proc('python').id, score: 24, evidence: { max_version: 'TLS 1.0', ja4: JA4.legacy } })),
    }));
    this.after(9, () => this.open('docker', 'dockerd', {
      rin: 400_000, rout: 20_000, shape: 'decay', duration: 9, ja4: JA4.go,
      onOpen: (f, e) => this.after(1.5, () => this.raise('anomaly', 'low', 'Unusual flow profile',
        `dockerd (pid ${PROCS.dockerd.pid}) → ${e.ip}:443 scored in the top 1.2% of flows (Half-Space Trees 0.94)`,
        { ep: e.id, flow: f.id, proc: this.proc('dockerd').id, score: 28, evidence: { hst_score: 0.94, percentile: 98.8, features: 'burst size, packet-size mix, duration' } })),
    }));
  }
}

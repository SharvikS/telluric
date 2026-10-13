import { Emitter } from '../util/emitter.js';
import { appRow } from '../config.js';

const HISTORY = 300; // 1 Hz samples kept for graphs
const FAST_HISTORY = 240; // raw stats samples (~4 Hz) for sparklines
const DNS_KEEP = 400;
const ALERTS_KEEP = 400;
const EP_HISTORY = 120;

/**
 * Replace `prev` with `next` in place: keys absent from `next` are deleted
 * (the protocol sends complete objects), client-derived keys starting with
 * "_" survive.
 */
function assignFull(prev, next) {
  for (const k of Object.keys(prev)) if (k[0] !== '_' && !(k in next)) delete prev[k];
  return Object.assign(prev, next);
}

/**
 * The client's model of the engine: entities by id plus derived indexes.
 *
 * Events: reset, hello, home, snapshot, ep (ep, isNew), ep-gone (ep),
 * flow (flow, isNew), flow-gone (flow), proc (proc, isNew), proc-gone (proc),
 * dns (items), alert (alert, isNew), stats (stats), pkts (batch).
 */
export class Store extends Emitter {
  constructor() {
    super();
    this.reset(false);
  }

  reset(emit = true) {
    this.hello = null;
    this.mode = null;
    this.home = null;
    this.credits = [];
    this.features = {};
    this.endpoints = new Map();
    this.flows = new Map();
    this.procs = new Map();
    this.alerts = new Map();
    this.alertOrder = [];
    this.dns = [];
    this.stats = null;
    this.history = [];
    this.fastHistory = [];
    this.byIp = new Map();
    this.flowsByEp = new Map();
    this.lastHistorySec = 0;
    this.clockSkew = 0; // server time − local time
    this.version = (this.version || 0) + 1;
    if (emit) this.emit('reset');
  }

  /** Server time now, compensating for clock skew. */
  now() {
    return Date.now() + this.clockSkew;
  }

  handle(msg) {
    switch (msg.t) {
      case 'hello':
        this.hello = msg;
        this.mode = msg.mode;
        this.home = msg.home && msg.home.lat != null ? msg.home : null;
        this.credits = msg.credits || [];
        this.features = msg.features || {};
        if (typeof msg.now === 'number') this.clockSkew = msg.now - Date.now();
        this.emit('hello', msg);
        this.emit('home', this.home);
        break;
      case 'home':
        this.home = msg.home && msg.home.lat != null ? msg.home : null;
        this.emit('home', this.home);
        break;
      case 'snapshot':
        for (const p of msg.procs || []) this.upsertProc(p);
        for (const e of msg.endpoints || []) this.upsertEp(e);
        for (const f of msg.flows || []) this.upsertFlow(f);
        for (const a of msg.alerts || []) this.upsertAlert(a);
        if (msg.dns && msg.dns.length) this.addDns(msg.dns);
        if (msg.history) {
          this.history = msg.history.slice(-HISTORY);
          this.lastHistorySec = this.history.length ? Math.floor(this.history[this.history.length - 1].ts / 1000) : 0;
        }
        if (msg.stats) this.setStats(msg.stats);
        this.emit('snapshot', msg);
        break;
      case 'ep':
        for (const e of msg.items || []) this.upsertEp(e);
        break;
      case 'flow':
        for (const f of msg.items || []) this.upsertFlow(f);
        break;
      case 'proc':
        for (const p of msg.items || []) this.upsertProc(p);
        break;
      case 'gone':
        for (const id of msg.flows || []) this.removeFlow(id);
        for (const id of msg.eps || []) this.removeEp(id);
        for (const id of msg.procs || []) this.removeProc(id);
        break;
      case 'dns':
        this.addDns(msg.items || []);
        break;
      case 'alert':
        for (const a of msg.items || []) this.upsertAlert(a);
        break;
      case 'stats': {
        const { t, ...stats } = msg;
        this.setStats(stats);
        break;
      }
      default:
        break; // pong and unknown types
    }
  }

  upsertEp(e) {
    const prev = this.endpoints.get(e.id);
    if (prev) {
      if (prev.ip !== e.ip) this.byIp.delete(prev.ip);
      assignFull(prev, e);
      this.byIp.set(prev.ip, prev);
      this.recordEpRate(prev);
      this.emit('ep', prev, false);
      return prev;
    }
    const ep = Object.assign(e, {
      _born: performance.now(),
      _app: 'unknown',
      _hist: new Float32Array(EP_HISTORY),
      _histN: 0,
      _histAt: 0,
    });
    this.endpoints.set(ep.id, ep);
    this.byIp.set(ep.ip, ep);
    if (!this.flowsByEp.has(ep.id)) this.flowsByEp.set(ep.id, new Set());
    this.recomputeEpApp(ep);
    this.recordEpRate(ep);
    this.emit('ep', ep, true);
    return ep;
  }

  recordEpRate(ep) {
    const now = performance.now();
    if (now - ep._histAt < 900) return;
    ep._histAt = now;
    ep._hist.copyWithin(0, 1);
    ep._hist[EP_HISTORY - 1] = (ep.rateIn || 0) + (ep.rateOut || 0);
    ep._histN = Math.min(EP_HISTORY, ep._histN + 1);
  }

  removeEp(id) {
    const ep = this.endpoints.get(id);
    if (!ep) return;
    this.endpoints.delete(id);
    if (this.byIp.get(ep.ip) === ep) this.byIp.delete(ep.ip);
    this.flowsByEp.delete(id);
    this.emit('ep-gone', ep);
  }

  upsertFlow(f) {
    const prev = this.flows.get(f.id);
    let flow, isNew = false;
    if (prev) {
      if (prev.ep !== f.ep) this.flowsByEp.get(prev.ep)?.delete(prev.id);
      flow = assignFull(prev, f);
    } else {
      flow = Object.assign(f, { _born: performance.now() });
      this.flows.set(flow.id, flow);
      isNew = true;
    }
    let set = this.flowsByEp.get(flow.ep);
    if (!set) this.flowsByEp.set(flow.ep, (set = new Set()));
    set.add(flow.id);
    const ep = this.endpoints.get(flow.ep);
    if (ep) this.recomputeEpApp(ep);
    this.emit('flow', flow, isNew);
    return flow;
  }

  removeFlow(id) {
    const flow = this.flows.get(id);
    if (!flow) return;
    this.flows.delete(id);
    this.flowsByEp.get(flow.ep)?.delete(id);
    const ep = this.endpoints.get(flow.ep);
    if (ep) this.recomputeEpApp(ep);
    this.emit('flow-gone', flow);
  }

  /** Dominant application of an endpoint by bytes, for colouring its arc. */
  recomputeEpApp(ep) {
    const set = this.flowsByEp.get(ep.id);
    let best = ep._app || 'unknown', bestBytes = -1, threat = 0, inB = 0, outB = 0;
    if (set) {
      const by = new Map();
      for (const fid of set) {
        const f = this.flows.get(fid);
        if (!f) continue;
        const b = (f.bytesIn || 0) + (f.bytesOut || 0) + 1;
        by.set(f.app, (by.get(f.app) || 0) + b);
        threat = Math.max(threat, f.threat || 0);
        inB += f.rateIn || 0;
        outB += f.rateOut || 0;
      }
      for (const [app, b] of by) if (b > bestBytes) { best = app; bestBytes = b; }
    }
    ep._app = best || 'unknown';
    ep._flowThreat = threat;
    ep._dirBias = inB + outB > 0 ? (inB - outB) / (inB + outB) : 0;
  }

  upsertProc(p) {
    const prev = this.procs.get(p.id);
    if (prev) {
      assignFull(prev, p);
      this.emit('proc', prev, false);
      return prev;
    }
    const proc = Object.assign(p, { _born: performance.now() });
    this.procs.set(proc.id, proc);
    this.emit('proc', proc, true);
    return proc;
  }

  removeProc(id) {
    const p = this.procs.get(id);
    if (!p) return;
    this.procs.delete(id);
    this.emit('proc-gone', p);
  }

  addDns(items) {
    for (const d of items) this.dns.push(d);
    if (this.dns.length > DNS_KEEP) this.dns.splice(0, this.dns.length - DNS_KEEP);
    this.emit('dns', items);
  }

  upsertAlert(a) {
    const isNew = !this.alerts.has(a.id);
    const prev = this.alerts.get(a.id);
    const alert = prev ? assignFull(prev, a) : Object.assign(a, { _born: performance.now() });
    this.alerts.set(a.id, alert);
    if (isNew) {
      this.alertOrder.unshift(a.id);
      if (this.alertOrder.length > ALERTS_KEEP) {
        for (const id of this.alertOrder.splice(ALERTS_KEEP)) this.alerts.delete(id);
      }
    }
    this.emit('alert', alert, isNew);
  }

  setStats(s) {
    this.stats = s;
    this.fastHistory.push(s);
    if (this.fastHistory.length > FAST_HISTORY) this.fastHistory.shift();
    const sec = Math.floor((s.ts || Date.now()) / 1000);
    if (sec > this.lastHistorySec) {
      this.history.push(s);
      if (this.history.length > HISTORY) this.history.shift();
      this.lastHistorySec = sec;
    }
    this.emit('stats', s);
  }

  /** Per-country aggregates for the leaderboard and the choropleth. */
  countries() {
    const out = new Map();
    for (const ep of this.endpoints.values()) {
      if (!ep.cc || ep.scope !== 'public') continue;
      let c = out.get(ep.cc);
      if (!c) out.set(ep.cc, (c = { cc: ep.cc, country: ep.country || ep.cc, rate: 0, rateIn: 0, rateOut: 0, bytes: 0, eps: 0, threat: 0 }));
      c.rateIn += ep.rateIn || 0;
      c.rateOut += ep.rateOut || 0;
      c.rate += (ep.rateIn || 0) + (ep.rateOut || 0);
      c.bytes += (ep.bytesIn || 0) + (ep.bytesOut || 0);
      c.eps++;
      c.threat = Math.max(c.threat, ep.threat || 0);
    }
    return [...out.values()].sort((a, b) => b.rate - a.rate || b.bytes - a.bytes);
  }

  /** App mix as rows for the protocol ring: [{app, rate}] in APP_ROWS order. */
  appMix() {
    const apps = (this.stats && this.stats.apps) || {};
    const rows = new Map();
    for (const [app, r] of Object.entries(apps)) {
      const k = appRow(app);
      rows.set(k, (rows.get(k) || 0) + r);
    }
    return rows;
  }

  flowsOf(epId) {
    const set = this.flowsByEp.get(epId);
    const out = [];
    if (set) for (const id of set) { const f = this.flows.get(id); if (f) out.push(f); }
    return out;
  }

  alertsFor({ ep, flow, proc }) {
    const out = [];
    for (const id of this.alertOrder) {
      const a = this.alerts.get(id);
      if (!a) continue;
      if ((ep && a.ep === ep) || (flow && a.flow === flow) || (proc && a.proc === proc)) out.push(a);
    }
    return out;
  }
}

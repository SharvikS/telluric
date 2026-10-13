import { h } from '../dom.js';
import { icon, ILLUSTRATIONS } from '../icons.js';
import { DataTable } from '../components/table.js';
import { RankList } from '../components/rank.js';
import { Summary, topSegments, accentRamp } from '../components/summary.js';
import { BarChart } from '../charts/bars.js';
import { sparkPaths } from '../charts/spark.js';
import { View } from './overview.js';
import {
  esc, rate, bytes, integer, time, agoShort, duration, middleTruncate, pct, count,
} from '../../util/format.js';
import { appName, hex, family, SERVICES } from '../../config.js';

const STATE_COLOR = { est: 'var(--success)', syn: 'var(--warning)', fin: 'var(--text-4)', closed: 'var(--text-4)', rst: 'var(--danger)', active: 'var(--info)' };
const STATE_LABEL = { est: 'Established (TCP)', syn: 'Handshaking', fin: 'Closing', closed: 'Closed', rst: 'Reset', active: 'Active (UDP)' };
const proto = (app) => `<span class="proto-chip"><i style="background:${hex(family(app))}"></i>${esc(appName(app))}</span>`;
const where = (ep) => (!ep ? '—' : ep.scope === 'public'
  ? (ep.cc ? `<span class="flag">${esc(ep.cc)}</span> ${esc(ep.city || ep.country || '')}` : '<span class="subtle">Unlocated</span>')
  : `<span class="subtle">${ep.scope === 'multicast' ? 'Multicast' : 'Local network'}</span>`);
const hostCell = (name, sub) => `<div class="td-host"><span class="n">${esc(name)}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ''}</div>`;
const rateCell = (v) => (v > 0.5 ? rate(v) : '<span class="faint">—</span>');
const threatCell = (n) => (n > 0 ? `<span class="badge ${n >= 70 ? 'danger' : n >= 40 ? 'orange' : 'warning'}">${n}</span>` : '<span class="faint">—</span>');

function sparkSvg(arr, color) {
  if (!arr || arr.length < 2) return '';
  const vals = Array.from(arr.slice(-60));
  const [line, area] = sparkPaths(vals, 120, 22, 1.5, 512, 60);
  // Not enough history yet: a dotted baseline marks the part we have not seen.
  const gap = vals.length < 60 ? `<path d="M0 20.5H${((60 - vals.length) / 59 * 120).toFixed(1)}" stroke="currentColor" stroke-width="1" stroke-dasharray="1.5 3" opacity=".35" vector-effect="non-scaling-stroke"/>` : '';
  return `<svg class="td-spark" viewBox="0 0 120 22" preserveAspectRatio="none" style="color:${color}">${gap}<path d="${area}" fill="currentColor" opacity=".14"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`;
}

/** Shared base: a header, a toolbar-table and periodic refresh. */
class TableView extends View {
  head(title, desc, extra) {
    return h('div.view-head', h('div', h('h1', title), h('p', desc)), extra ? h('div.actions', extra) : null);
  }

  frame(now, dt) {
    this.summary?.frame(dt);
  }
}

const ENCRYPTED = new Set(['tls', 'quic', 'ssh', 'doh', 'dot', 'wireguard', 'openvpn', 'stun']);
const median = (xs) => {
  if (!xs.length) return null;
  const v = xs.slice().sort((a, b) => a - b);
  return v[v.length >> 1];
};
const flowBytes = (f) => (f.bytesIn || 0) + (f.bytesOut || 0);
const pctHTML = (v) => (v == null ? '<span class="faint">—</span>' : `${Math.round(v * 100)}<small>%</small>`);

// ── connections ─────────────────────────────────────────────────────────────
export class ConnectionsView extends TableView {
  constructor(app) {
    super(app, 'connections', 'Connections');
  }

  mount() {
    const app = this.app, s = app.store;
    const ep = (f) => s.endpoints.get(f.ep);
    const pr = (f) => (f.proc ? s.procs.get(f.proc) : null);
    this.table = new DataTable({
      exportName: 'connections',
      placeholder: 'Filter by host, process, SNI…',
      rowKey: (f) => f.id,
      sort: { key: 'total', dir: 'desc' },
      columns: [
        { key: 'state', label: '', w: 34, html: (f) => `<span class="state-dot" style="background:${STATE_COLOR[f.state] || 'var(--text-4)'}" data-tip="${esc(STATE_LABEL[f.state] || f.state)}"></span>`, text: (f) => f.state },
        { key: 'app', label: 'Protocol', w: 104, sort: (f) => f.app, html: (f) => proto(f.app), text: (f) => appName(f.app) },
        { key: 'proc', label: 'Process', w: 150, sort: (f) => (pr(f)?.name || '~'), html: (f) => { const p = pr(f); return p ? hostCell(p.name, `pid ${p.pid}`) : '<span class="faint">unattributed</span>'; }, text: (f) => pr(f)?.name || '' },
        { key: 'host', label: 'Remote host', flex: 1, min: 220, sort: (f) => (ep(f)?.name || ep(f)?.ip || ''), html: (f) => { const e = ep(f); return e ? hostCell(middleTruncate(e.name || e.ip, 44), [e.name ? e.ip : null, e.org].filter(Boolean).join(' · ')) : '…'; }, text: (f) => { const e = ep(f); return e ? e.name || e.ip : ''; } },
        { key: 'loc', label: 'Location', w: 170, hide: 860, sort: (f) => ep(f)?.country || '~', html: (f) => where(ep(f)), text: (f) => [ep(f)?.city, ep(f)?.cc].filter(Boolean).join(', ') },
        { key: 'port', label: 'Port', w: 72, hide: 1400, align: 'right', sort: (f) => f.rport, html: (f) => `<span class="mono">${f.rport}</span>`, text: (f) => f.rport },
        { key: 'dir', label: 'Dir', w: 56, hide: 1400, sort: (f) => f.dir, html: (f) => `<span data-tip="${f.dir === 'in' ? 'Inbound' : 'Outbound'}" style="color:var(--text-3)">${icon(f.dir === 'in' ? 'arrow-down-left' : 'arrow-up-right')}</span>`, text: (f) => f.dir },
        { key: 'rtt', label: 'RTT', w: 80, hide: 1100, align: 'right', sort: (f) => f.rtt ?? -1, html: (f) => (f.rtt != null ? `${f.rtt.toFixed(f.rtt < 10 ? 1 : 0)} ms` : '<span class="faint">—</span>'), text: (f) => f.rtt ?? '' },
        { key: 'in', label: 'In', w: 96, align: 'right', hide: 1000, sort: (f) => f.rateIn || 0, html: (f) => rateCell(f.rateIn), text: (f) => Math.round(f.rateIn || 0) },
        { key: 'out', label: 'Out', w: 96, align: 'right', hide: 1000, sort: (f) => f.rateOut || 0, html: (f) => rateCell(f.rateOut), text: (f) => Math.round(f.rateOut || 0) },
        { key: 'total', label: 'Total', w: 96, align: 'right', sort: (f) => (f.bytesIn || 0) + (f.bytesOut || 0), html: (f) => bytes((f.bytesIn || 0) + (f.bytesOut || 0)), text: (f) => (f.bytesIn || 0) + (f.bytesOut || 0) },
        { key: 'age', label: 'Age', w: 76, hide: 1300, align: 'right', sort: (f) => -f.start, html: (f) => `<span class="subtle">${agoShort(f.start, s.now())}</span>`, text: (f) => new Date(f.start).toISOString() },
        { key: 'sni', label: 'SNI', w: 220, visible: false, sort: (f) => f.sni || '~', html: (f) => (f.sni ? `<span class="mono">${esc(f.sni)}</span>` : '<span class="faint">—</span>'), text: (f) => f.sni || '' },
        { key: 'alpn', label: 'ALPN', w: 80, visible: false, sort: (f) => f.alpn || '~', html: (f) => esc(f.alpn || '—'), text: (f) => f.alpn || '' },
        { key: 'tlsv', label: 'TLS', w: 64, visible: false, sort: (f) => f.tlsv || '~', html: (f) => esc(f.tlsv || '—'), text: (f) => f.tlsv || '' },
        { key: 'ja4', label: 'JA4', w: 280, visible: false, sort: (f) => f.ja4 || '~', html: (f) => (f.ja4 ? `<span class="mono">${esc(f.ja4)}</span>` : '<span class="faint">—</span>'), text: (f) => f.ja4 || '' },
        { key: 'pq', label: 'Post-quantum', w: 112, visible: false, sort: (f) => (f.pq ? 1 : 0), html: (f) => (f.pq ? '<span class="badge success">ML-KEM</span>' : '<span class="faint">—</span>'), text: (f) => (f.pq ? 'yes' : 'no') },
        { key: 'threat', label: 'Threat', w: 72, align: 'right', sort: (f) => f.threat || 0, html: (f) => threatCell(f.threat), text: (f) => f.threat || 0 },
      ],
      filters: [
        { key: 'app', label: 'Protocol', value: (f) => f.app, format: (v) => appName(v) },
        { key: 'proc', label: 'Process', value: (f) => pr(f)?.name || 'unattributed' },
        { key: 'dir', label: 'Direction', value: (f) => f.dir, format: (v) => (v === 'in' ? 'Inbound' : 'Outbound') },
        { key: 'state', label: 'State', value: (f) => f.state },
        { key: 'country', label: 'Country', value: (f) => ep(f)?.cc || '' },
        { key: 'threat', label: 'Threat', value: (f) => ((f.threat || 0) > 0 ? 'flagged' : 'clean') },
      ],
      search: (f) => {
        const e = ep(f), p = pr(f);
        return `${e?.name || ''} ${e?.ip || ''} ${e?.org || ''} ${e?.city || ''} ${p?.name || ''} ${f.sni || ''} ${f.app} ${f.rport}`.toLowerCase();
      },
      rowClass: (f) => ((f.state === 'closed' || f.state === 'fin') ? 'dim' : ''),
      empty: { ill: ILLUSTRATIONS.table, title: 'No connections', body: 'Nothing matches the current filters.' },
      onOpen: (f, el) => app.openEntity({ type: 'flow', id: f.id }, { from: el && fromRow(el, hex(family(f.app))) }),
    });
    this.summary = new Summary({
      stats: [
        { key: 'active', label: 'Open connections', tip: 'Flows that have not closed yet' },
        { key: 'split', label: 'TCP · UDP', format: (v) => `${integer(v[0])}<small>tcp</small> ${integer(v[1])}<small>udp</small>` },
        { key: 'enc', label: 'Encrypted', tip: 'Share of bytes carried by TLS, QUIC, SSH, DoH and VPN protocols', format: pctHTML },
        { key: 'pq', label: 'Post-quantum', tip: 'TLS 1.3 / QUIC handshakes using a hybrid ML-KEM key exchange', format: pctHTML },
        { key: 'rtt', label: 'Median RTT', format: (v) => (v == null ? '<span class="faint">—</span>' : `${Math.round(v)}<small>ms</small>`) },
      ],
      dist: { title: 'Traffic by protocol', onPick: (k) => this.table.addFilter('app', k) },
    });
    this.el.appendChild(h('div.page.fill', this.head('Connections', 'Every transport conversation on this machine, live. Click a row for the TLS handshake, RTT and process.'), this.summary.el, this.table.el));
  }

  show(params) {
    if (params.proc) this.table.addFilter('proc', params.proc);
    if (params.host) {
      this.table.input.value = params.host;
      this.table.query = params.host.toLowerCase();
    }
    this.refresh();
    setTimeout(() => this.table.focus(), 50);
  }

  refresh() {
    const flows = [...this.app.store.flows.values()];
    this.table.setRows(flows);
    let tcp = 0, udp = 0, enc = 0, all = 0, tlsN = 0, pqN = 0;
    const rtts = [], byApp = new Map();
    for (const f of flows) {
      if (f.state === 'closed' || f.state === 'fin') continue;
      if (f.proto === 'udp') udp++; else tcp++;
      const b = flowBytes(f);
      all += b;
      if (ENCRYPTED.has(f.app)) enc += b;
      if (f.pq != null) { tlsN++; if (f.pq) pqN++; }
      if (f.rtt != null) rtts.push(f.rtt);
      byApp.set(f.app, (byApp.get(f.app) || 0) + b);
    }
    this.summary.set(
      { active: tcp + udp, split: [tcp, udp], enc: all ? enc / all : null, pq: tlsN ? pqN / tlsN : null, rtt: median(rtts) },
      topSegments(byApp, 6, (k) => appName(k), (k) => hex(family(k))),
      'click to filter');
  }
}

// ── hosts ───────────────────────────────────────────────────────────────────
export class HostsView extends TableView {
  constructor(app) {
    super(app, 'hosts', 'Hosts');
  }

  mount() {
    const app = this.app, s = app.store;
    this.table = new DataTable({
      exportName: 'hosts',
      placeholder: 'Filter by name, IP, organization…',
      rowKey: (e) => e.id,
      sort: { key: 'rate', dir: 'desc' },
      columns: [
        { key: 'host', label: 'Host', flex: 1, min: 240, sort: (e) => e.name || e.ip, html: (e) => hostCell(middleTruncate(e.name || e.ip, 46), e.name ? e.ip : ''), text: (e) => e.name || e.ip },
        { key: 'org', label: 'Network', w: 220, hide: 1000, sort: (e) => e.org || '~', html: (e) => hostCell(e.org || '—', e.asn ? `AS${e.asn}` : ''), text: (e) => e.org || '' },
        { key: 'loc', label: 'Location', w: 170, sort: (e) => e.country || '~', html: (e) => where(e), text: (e) => [e.city, e.cc].filter(Boolean).join(', ') },
        { key: 'app', label: 'Protocol', w: 100, sort: (e) => e._app, html: (e) => proto(e._app), text: (e) => appName(e._app) },
        { key: 'flows', label: 'Conns', w: 76, align: 'right', hide: 1250, sort: (e) => e.flows || 0, html: (e) => integer(e.flows || 0), text: (e) => e.flows || 0 },
        { key: 'traffic', label: 'Traffic', w: 130, hide: 1100, html: (e) => sparkSvg(app.history.epSeries(e.id), (e.threat || 0) >= 40 ? 'var(--viz-threat)' : `var(--viz-${family(e._app)})`), text: () => '' },
        { key: 'rate', label: 'Rate', w: 100, align: 'right', sort: (e) => (e.rateIn || 0) + (e.rateOut || 0), html: (e) => rateCell((e.rateIn || 0) + (e.rateOut || 0)), text: (e) => Math.round((e.rateIn || 0) + (e.rateOut || 0)) },
        { key: 'total', label: 'Total', w: 96, align: 'right', hide: 900, sort: (e) => (e.bytesIn || 0) + (e.bytesOut || 0), html: (e) => bytes((e.bytesIn || 0) + (e.bytesOut || 0)), text: (e) => (e.bytesIn || 0) + (e.bytesOut || 0) },
        { key: 'threat', label: 'Threat', w: 72, align: 'right', sort: (e) => e.threat || 0, html: (e) => threatCell(e.threat), text: (e) => e.threat || 0 },
        { key: 'last', label: 'Last seen', w: 90, hide: 1300, align: 'right', sort: (e) => e.last || 0, html: (e) => `<span class="subtle">${agoShort(e.last, s.now())}</span>`, text: (e) => new Date(e.last).toISOString() },
      ],
      filters: [
        { key: 'country', label: 'Country', value: (e) => e.cc || '' },
        { key: 'scope', label: 'Scope', value: (e) => e.scope },
        { key: 'app', label: 'Protocol', value: (e) => e._app, format: (v) => appName(v) },
        { key: 'svc', label: 'Service', value: (e) => e.svc || '', format: (v) => SERVICES[v] || v },
        { key: 'org', label: 'Network', value: (e) => e.org || '' },
        { key: 'threat', label: 'Threat', value: (e) => ((e.threat || 0) > 0 ? 'flagged' : 'clean') },
      ],
      search: (e) => `${e.name || ''} ${(e.names || []).join(' ')} ${e.ip} ${e.org || ''} ${e.city || ''} ${e.country || ''} ${e.cc || ''}`.toLowerCase(),
      empty: { ill: ILLUSTRATIONS.globe, title: 'No hosts', body: 'Nothing matches the current filters.' },
      onOpen: (e, el) => app.openEntity({ type: 'ep', id: e.id }, { from: el && fromRow(el, hex(family(e._app))) }),
    });
    this.summary = new Summary({
      stats: [
        { key: 'hosts', label: 'Hosts' },
        { key: 'countries', label: 'Countries' },
        { key: 'networks', label: 'Networks', tip: 'Distinct autonomous systems' },
        { key: 'fresh', label: 'First seen < 5 min' },
        { key: 'flagged', label: 'Flagged', tone: (v) => (v > 0 ? 'danger' : '') },
      ],
      dist: { title: 'Traffic by country', onPick: (k) => this.table.addFilter('country', k) },
    });
    this.el.appendChild(h('div.page.fill', this.head('Hosts', 'Every remote address this machine talked to, with where it is and who runs it.'), this.summary.el, this.table.el));
  }

  show(params) {
    if (params.country) this.table.addFilter('country', params.country);
    this.refresh();
    setTimeout(() => this.table.focus(), 50);
  }

  refresh() {
    const s = this.app.store, now = s.now();
    const eps = [...s.endpoints.values()];
    this.table.setRows(eps);
    const cc = new Set(), nets = new Set(), byCc = new Map();
    let fresh = 0, flagged = 0;
    for (const e of eps) {
      if (e.cc) cc.add(e.cc);
      if (e.asn || e.org) nets.add(e.asn || e.org);
      if (now - (e.first || 0) < 300e3) fresh++;
      if ((e.threat || 0) >= 40) flagged++;
      const k = e.scope === 'public' ? e.cc || '??' : 'LAN';
      byCc.set(k, (byCc.get(k) || 0) + (e.bytesIn || 0) + (e.bytesOut || 0));
    }
    const names = new Map(eps.filter((e) => e.cc).map((e) => [e.cc, e.country || e.cc]));
    this.summary.set({ hosts: eps.length, countries: cc.size, networks: nets.size, fresh, flagged },
      topSegments(byCc, 6, (k) => (k === 'LAN' ? 'Local network' : k === '??' ? 'Unknown' : names.get(k) || k), (k, i) => accentRamp(i)),
      'click to filter');
  }
}

// ── processes ───────────────────────────────────────────────────────────────
export class ProcessesView extends TableView {
  constructor(app) {
    super(app, 'processes', 'Processes');
  }

  mount() {
    const app = this.app, s = app.store;
    const flowsOf = (p) => [...s.flows.values()].filter((f) => f.proc === p.id).sort((a, b) => (b.rateIn + b.rateOut) - (a.rateIn + a.rateOut));
    const hostsOf = (p) => new Set(flowsOf(p).map((f) => f.ep)).size;
    this.table = new DataTable({
      exportName: 'processes',
      placeholder: 'Filter by name, PID, unit…',
      rowKey: (p) => p.id,
      sort: { key: 'rate', dir: 'desc' },
      columns: [
        { key: 'name', label: 'Process', flex: 1, min: 220, sort: (p) => p.name, html: (p, t) => `<div class="row" style="gap:6px"><button class="expand-btn" data-expand data-tip="Show connections">${icon('chevron-right', `caret${t.expanded.has(p.id) ? ' open' : ''}`)}</button>${hostCell(p.name, `pid ${p.pid}${p.user ? ` · ${p.user}` : ''}`)}</div>`, text: (p) => p.name },
        { key: 'unit', label: 'Unit / container', w: 240, hide: 1000, sort: (p) => p.container || p.unit || '~', html: (p) => (p.container ? `<span class="badge accent">${esc(p.container)}</span>` : `<span class="subtle">${esc(middleTruncate(p.unit || '—', 34))}</span>`), text: (p) => p.container || p.unit || '' },
        { key: 'flows', label: 'Conns', w: 76, align: 'right', sort: (p) => p.flows || 0, html: (p) => integer(p.flows || 0), text: (p) => p.flows || 0 },
        { key: 'hosts', label: 'Hosts', w: 70, hide: 1100, align: 'right', sort: (p) => hostsOf(p), html: (p) => integer(hostsOf(p)), text: (p) => hostsOf(p) },
        { key: 'traffic', label: 'Traffic', w: 140, html: (p) => sparkSvg(app.history.procSeries(p.id), 'var(--accent)'), text: () => '' },
        { key: 'in', label: 'In', w: 96, align: 'right', hide: 900, sort: (p) => p.rateIn || 0, html: (p) => rateCell(p.rateIn), text: (p) => Math.round(p.rateIn || 0) },
        { key: 'out', label: 'Out', w: 96, align: 'right', hide: 900, sort: (p) => p.rateOut || 0, html: (p) => rateCell(p.rateOut), text: (p) => Math.round(p.rateOut || 0) },
        { key: 'rate', label: 'Total rate', w: 104, align: 'right', sort: (p) => (p.rateIn || 0) + (p.rateOut || 0), html: (p) => rateCell((p.rateIn || 0) + (p.rateOut || 0)), text: (p) => Math.round((p.rateIn || 0) + (p.rateOut || 0)) },
        { key: 'total', label: 'Transferred', w: 110, align: 'right', sort: (p) => (p.bytesIn || 0) + (p.bytesOut || 0), html: (p) => bytes((p.bytesIn || 0) + (p.bytesOut || 0)), text: (p) => (p.bytesIn || 0) + (p.bytesOut || 0) },
      ],
      filters: [
        { key: 'name', label: 'Process', value: (p) => p.name },
        { key: 'user', label: 'User', value: (p) => p.user || '' },
        { key: 'unit', label: 'Unit', value: (p) => p.unit || '' },
      ],
      search: (p) => `${p.name} ${p.pid} ${p.cmd || ''} ${p.exe || ''} ${p.unit || ''} ${p.user || ''}`.toLowerCase(),
      expand: {
        key: (f) => f.id,
        children: (p) => flowsOf(p).slice(0, 25),
        html: (f) => {
          const e = s.endpoints.get(f.ep);
          return `<div class="row" style="gap:12px;cursor:pointer" data-flow="${f.id}">${proto(f.app)}<span class="ellipsis" style="max-width:340px">→ ${esc(e ? e.name || e.ip : '…')}<span class="subtle">:${f.rport}</span></span><span class="subtle ellipsis">${e && e.city ? esc(`${e.city}, ${e.cc}`) : ''}</span><span class="spacer"></span><span class="num">${rate((f.rateIn || 0) + (f.rateOut || 0))}</span></div>`;
        },
      },
      empty: { ill: ILLUSTRATIONS.table, title: 'No processes', body: 'Process attribution needs the engine to read /proc for the sockets it sees.' },
      onOpen: (p, el) => app.openEntity({ type: 'proc', id: p.id }, { from: el && fromRow(el, 'var(--accent)') }),
    });
    this.table.spacer.addEventListener('click', (e) => {
      const f = e.target.closest('[data-flow]');
      if (f) app.openEntity({ type: 'flow', id: Number(f.dataset.flow) });
    });
    this.summary = new Summary({
      stats: [
        { key: 'procs', label: 'Processes' },
        { key: 'talking', label: 'Talking now', tip: 'Processes moving data in the last second' },
        { key: 'conns', label: 'Attributed connections' },
        { key: 'unattr', label: 'Unattributed', tip: 'Connections whose socket owner could not be found (short-lived, or in another network namespace)', tone: (v) => (v > 0 ? 'warning' : '') },
      ],
      dist: { title: 'Traffic by process', onPick: (k) => this.table.addFilter('name', k) },
    });
    this.el.appendChild(h('div.page.fill', this.head('Processes', 'Which programs use the network, how much, and with whom. Expand a row to see its connections.'), this.summary.el, this.table.el));
  }

  show() {
    this.refresh();
    setTimeout(() => this.table.focus(), 50);
  }

  refresh() {
    const s = this.app.store;
    const procs = [...s.procs.values()].filter((p) => p.flows || (p.rateIn + p.rateOut) > 0 || p.bytesIn);
    this.table.setRows(procs);
    let conns = 0, unattr = 0;
    for (const f of s.flows.values()) {
      if (f.state === 'closed') continue;
      if (f.proc) conns++; else unattr++;
    }
    const byName = new Map();
    for (const p of procs) byName.set(p.name, (byName.get(p.name) || 0) + (p.bytesIn || 0) + (p.bytesOut || 0));
    this.summary.set({ procs: procs.length, talking: procs.filter((p) => (p.rateIn || 0) + (p.rateOut || 0) > 1).length, conns, unattr },
      topSegments(byName, 6, (k) => k, (k, i) => accentRamp(i)),
      'click to filter');
  }
}

// ── DNS ─────────────────────────────────────────────────────────────────────
const RC_COLOR = { NOERROR: '--viz-dns', NXDOMAIN: '--warning', other: '--danger' };

export class DnsView extends TableView {
  constructor(app) {
    super(app, 'dns', 'DNS');
    this.keys = new WeakMap();
    this.seq = 0;
  }

  mount() {
    const app = this.app, s = app.store;
    const kpi = (label, ic) => {
      const v = h('div.mk-v');
      return [h('div.card', h('div.mk-l', h('span', { html: icon(ic) }), label), v), v];
    };
    const [k1, v1] = kpi('Queries / min', 'dns');
    const [k2, v2] = kpi('NXDOMAIN rate', 'alert');
    const [k3, v3] = kpi('Unique names', 'hash');
    const [k4, v4] = kpi('Median latency', 'clock');
    this.kv = { v1, v2, v3, v4 };
    const chartEl = h('div', { style: { position: 'absolute', inset: '0 16px 12px 16px', width: 'auto', height: 'auto' } });
    this.bars = new BarChart(chartEl, {
      series: [{ key: 'ok', label: 'Answered', color: RC_COLOR.NOERROR }, { key: 'nx', label: 'NXDOMAIN', color: RC_COLOR.NXDOMAIN }, { key: 'err', label: 'Errors', color: RC_COLOR.other }],
      format: (v) => String(Math.round(v)),
    });
    this.top = new RankList({ max: 5, rowH: 42, onClick: (q) => { this.table.input.value = q; this.table.query = q.toLowerCase(); this.table.apply(); } });
    this.table = new DataTable({
      exportName: 'dns',
      placeholder: 'Filter queries…',
      rowKey: (d) => this.key(d),
      sort: { key: 'ts', dir: 'desc' },
      columns: [
        { key: 'ts', label: 'Time', w: 100, sort: (d) => d.ts, html: (d) => `<span class="subtle num">${time(d.ts)}</span>`, text: (d) => new Date(d.ts).toISOString() },
        { key: 'q', label: 'Query', flex: 1, min: 260, sort: (d) => d.q, html: (d) => `<span class="mono">${esc(middleTruncate(d.q, 64))}</span>`, text: (d) => d.q },
        { key: 'qtype', label: 'Type', w: 80, sort: (d) => d.qtype, html: (d) => `<span class="badge outline">${esc(d.qtype)}</span>`, text: (d) => d.qtype },
        { key: 'rcode', label: 'Response', w: 120, sort: (d) => d.rcode, html: (d) => `<span class="badge ${d.rcode === 'NOERROR' ? 'success' : d.rcode === 'NXDOMAIN' ? 'warning' : 'danger'}">${esc(d.rcode)}</span>`, text: (d) => d.rcode },
        { key: 'answers', label: 'Answers', w: 230, hide: 1000, sort: (d) => (d.answers || [])[0] || '~', html: (d) => (d.answers && d.answers.length ? `<span class="mono">${esc(d.answers[0])}</span>${d.answers.length > 1 ? ` <span class="subtle">+${d.answers.length - 1}</span>` : ''}` : '<span class="faint">—</span>'), text: (d) => (d.answers || []).join(' ') },
        { key: 'ms', label: 'Latency', w: 90, align: 'right', sort: (d) => d.ms ?? -1, html: (d) => (d.ms != null ? `${d.ms.toFixed(d.ms < 10 ? 1 : 0)} ms` : '<span class="faint">—</span>'), text: (d) => d.ms ?? '' },
        { key: 'proc', label: 'Process', w: 140, hide: 900, sort: (d) => (d.proc && s.procs.get(d.proc)?.name) || '~', html: (d) => esc((d.proc && s.procs.get(d.proc)?.name) || '—'), text: (d) => (d.proc && s.procs.get(d.proc)?.name) || '' },
        { key: 'server', label: 'Resolver', w: 130, visible: false, sort: (d) => d.server || '', html: (d) => `<span class="mono">${esc(d.server || '—')}</span>`, text: (d) => d.server || '' },
      ],
      filters: [
        { key: 'qtype', label: 'Type', value: (d) => d.qtype },
        { key: 'rcode', label: 'Response', value: (d) => d.rcode },
        { key: 'proc', label: 'Process', value: (d) => (d.proc && s.procs.get(d.proc)?.name) || 'unattributed' },
        { key: 'server', label: 'Resolver', value: (d) => d.server || '' },
      ],
      search: (d) => `${d.q} ${(d.answers || []).join(' ')} ${(d.cname || []).join(' ')}`.toLowerCase(),
      empty: { ill: ILLUSTRATIONS.inbox, title: 'No DNS queries yet', body: 'Queries appear here as the machine resolves names. DNS-over-HTTPS traffic is encrypted and shows up as connections instead.' },
      onOpen: (d) => {
        const ip = (d.answers || [])[0];
        const ep = ip ? s.byIp.get(ip) : null;
        if (ep) app.openEntity({ type: 'ep', id: ep.id });
        else app.toast({ kind: 'info', title: d.q, desc: `${d.qtype} · ${d.rcode}${d.answers && d.answers.length ? ` · ${esc(d.answers.join(', '))}` : ''} — no connection to these addresses yet.`, duration: 4000 });
      },
    });
    this.el.appendChild(h('div.page',
      this.head('DNS', 'Every lookup seen on the wire — what was asked, what came back, and how fast.'),
      h('div.mini-kpis', k1, k2, k3, k4),
      h('div.charts-row',
        h('div.card', h('div.card-head', h('h3', 'Queries per minute'), h('span.sub', 'last 30 minutes')), h('div.card-body.flush', chartEl)),
        h('div.card', h('div.card-head', h('h3', 'Top names'), h('span.sub', 'last 30 minutes')), h('div.card-body.flush', this.top.el))),
      this.table.el));
  }

  key(d) {
    let k = this.keys.get(d);
    if (!k) this.keys.set(d, (k = ++this.seq));
    return k;
  }

  show(params) {
    if (params.q) {
      this.table.input.value = params.q;
      this.table.query = params.q.toLowerCase();
    }
    this.refresh();
  }

  frame(now, dt) {
    this.bars.draw(dt);
  }

  refresh() {
    const s = this.app.store;
    const all = s.dns;
    this.table.setRows(all.slice(-4000));
    const now = s.now();
    const recent = all.filter((d) => d.ts >= now - 30 * 60e3);
    const lastMin = all.filter((d) => d.ts >= now - 60e3);
    this.kv.v1.textContent = integer(lastMin.length);
    const nx = recent.filter((d) => d.rcode === 'NXDOMAIN').length;
    this.kv.v2.textContent = recent.length ? pct(nx / recent.length, 1) : '—';
    this.kv.v3.textContent = count(new Set(recent.map((d) => d.q)).size);
    const lat = recent.map((d) => d.ms).filter((x) => x != null).sort((a, b) => a - b);
    this.kv.v4.textContent = lat.length ? `${lat[Math.floor(lat.length / 2)].toFixed(1)} ms` : '—';
    const buckets = [];
    const b0 = Math.floor(now / 60e3) * 60e3 - 29 * 60e3;
    for (let i = 0; i < 30; i++) buckets.push({ ts: b0 + i * 60e3, values: { ok: 0, nx: 0, err: 0 } });
    for (const d of recent) {
      const i = Math.floor((d.ts - b0) / 60e3);
      if (i < 0 || i >= 30) continue;
      const k = d.rcode === 'NOERROR' ? 'ok' : d.rcode === 'NXDOMAIN' ? 'nx' : 'err';
      buckets[i].values[k]++;
    }
    this.bars.set(buckets);
    const counts = new Map();
    for (const d of recent) counts.set(d.q, (counts.get(d.q) || 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1]);
    const max = top.length ? top[0][1] : 1;
    this.top.set(top.slice(0, 12).map(([q, n]) => ({ key: q, icon: icon('dns'), name: middleTruncate(q, 34), sub: '', value: n, display: `<span class="num">${n}</span>`, bar: n / max, color: 'var(--viz-dns)' })));
  }
}

function fromRow(el, color) {
  const r = el.getBoundingClientRect();
  return { x: r.left + 24, y: r.top + r.height / 2, color };
}

export { duration };

import { icon } from './icons.js';
import { spark } from './charts/spark.js';
import { h } from './dom.js';
import {
  esc, rate, bytes, integer, time, dateTime, ago, duration, latLon, middleTruncate,
} from '../util/format.js';
import { appName, hex, family, SEVERITY, ALERT_KINDS, SERVICES } from '../config.js';

/**
 * Renderers for the detail drawer: for each entity type, a header and tabs.
 * Each returns { title, sub, avatar: { icon, color }, badges, tabs, actions }
 * or null when the entity no longer exists.
 */
export function describe(app, ref) {
  const fn = { ep: hostDesc, flow: flowDesc, proc: procDesc, alert: alertDesc, trace: traceDesc }[ref.type];
  return fn ? fn(app, ref.id) : null;
}

const badge = (cls, text, extra = '') => `<span class="badge ${cls}">${extra}${esc(text)}</span>`;
const protoBadge = (app) => `<span class="badge outline"><span class="sw" style="background:${hex(app)}"></span>${esc(appName(app))}</span>`;
const sevBadge = (sev) => {
  const s = SEVERITY[sev] || SEVERITY.medium;
  return `<span class="badge ${s.css}">${esc(s.label)}</span>`;
};
const STATE_LABEL = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' };
const stateBadge = (a) => {
  const st = a.state || 'open';
  const cls = st === 'open' ? 'danger' : st === 'acknowledged' ? 'warning' : 'success';
  return `${badge(cls, STATE_LABEL[st] || st)}${a.muted ? ` ${badge('outline', 'Muted')}` : ''}`;
};
const link = (type, id, text) => `<a href="#" data-open="${type}:${id}">${esc(text)}</a>`;
const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const stat = (label, value) => `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div></div>`;
const copyBtn = (text) => `<button class="icon-btn" data-copy="${esc(text)}" data-tip="Copy" style="width:24px;height:24px;display:inline-grid;vertical-align:-6px">${icon('copy')}</button>`;

function rawJSON(obj) {
  const json = JSON.stringify(obj, (k, v) => (k[0] === '_' ? undefined : v), 2);
  const html = esc(json)
    .replace(/&quot;([^&]*?)&quot;(\s*:)/g, '<span class="k">"$1"</span>$2')
    .replace(/(:\s*)&quot;(.*?)&quot;/g, '$1<span class="s">"$2"</span>')
    .replace(/(:\s*)(-?\d+(?:\.\d+)?)/g, '$1<span class="n">$2</span>');
  return `<pre class="raw">${html}</pre>`;
}

function flowRow(app, f) {
  const p = f.proc ? app.store.procs.get(f.proc) : null;
  const tls = f.sni || f.alpn || f.tlsv
    ? `<div class="subtle" style="font-size:12px;margin-top:3px">${f.sni ? `SNI <span class="mono" style="color:var(--text)">${esc(f.sni)}</span>` : 'No SNI'}${f.alpn ? ` · ${esc(f.alpn)}` : ''}${f.tlsv ? ` · TLS ${esc(f.tlsv)}` : ''}${f.ech ? ' · <span style="color:var(--success)">ECH</span>' : ''}${f.pq ? ' · <span style="color:var(--success)">ML-KEM</span>' : ''}</div>`
    : '';
  return `<div class="card hoverable" style="padding:10px 12px;margin-bottom:8px;cursor:pointer" data-open="flow:${f.id}">
    <div class="row">${protoBadge(f.app)}<span class="mono subtle">${f.dir === 'in' ? '←' : '→'} :${f.rport}</span>
      <span class="subtle">${p ? esc(p.name) : 'unattributed'}</span><span class="spacer"></span>
      <span class="num" style="font-weight:600">${rate((f.rateIn || 0) + (f.rateOut || 0))}</span></div>
    <div class="subtle" style="font-size:12px;margin-top:4px">${esc(f.state)}${f.rtt != null ? ` · RTT ${f.rtt.toFixed(1)} ms` : ''} · ↓ ${bytes(f.bytesIn)} ↑ ${bytes(f.bytesOut)} · ${ago(f.start, app.store.now())}</div>
    ${tls}</div>`;
}

function timeline(items) {
  if (!items.length) return '<div class="subtle">Nothing recorded yet.</div>';
  return `<div class="timeline">${items.sort((a, b) => b.ts - a.ts).slice(0, 40).map((it) => `
    <div class="tl-item" style="--tl:${it.color || 'var(--text-3)'}"><div class="tl-time">${dateTime(it.ts)}</div><div class="tl-text">${it.html}</div></div>`).join('')}</div>`;
}

// ── host ─────────────────────────────────────────────────────────────────────
function hostDesc(app, id) {
  const s = app.store;
  const ep = s.endpoints.get(id);
  if (!ep) return null;
  const flows = s.flowsOf(id).sort((a, b) => (b.rateIn + b.rateOut) - (a.rateIn + a.rateOut));
  const alerts = s.alertsFor({ ep: id });
  const procs = [...new Map(flows.filter((f) => f.proc && s.procs.has(f.proc)).map((f) => [f.proc, s.procs.get(f.proc)])).values()];
  const tlsFlows = flows.filter((f) => typeof f.pq === 'boolean');
  const pq = tlsFlows.length ? (tlsFlows.every((f) => f.pq) ? '<span style="color:var(--success)">ML-KEM offered</span>' : `${tlsFlows.filter((f) => f.pq).length} of ${tlsFlows.length} handshakes`) : null;
  const where = ep.scope === 'public' ? [ep.city, ep.region, ep.country].filter(Boolean).join(', ') || 'Unlocated' : ep.scope === 'multicast' ? 'Multicast group' : 'Local network';
  const badges = [protoBadge(ep._app), ep.svc ? badge('accent', SERVICES[ep.svc] || ep.svc) : '', ep.threat ? badge('danger', `Threat ${ep.threat}`) : '',
    ...(ep.tags || []).map((t) => badge('outline', t))].join(' ');
  return {
    title: ep.name || ep.ip,
    sub: `${ep.ip}${ep.org ? ` · ${ep.org}` : ''}`,
    avatar: { icon: ep.scope === 'public' ? 'globe' : 'wifi', color: hex(family(ep._app)) },
    badges,
    tabs: [
      {
        value: 'overview', label: 'Overview', render: () => {
          const wrap = h('div');
          wrap.innerHTML = `
            <div class="stat-grid">${stat('Inbound', rate(ep.rateIn))}${stat('Outbound', rate(ep.rateOut))}${stat('Transferred', bytes((ep.bytesIn || 0) + (ep.bytesOut || 0)))}</div>
            <div class="section-title">Traffic · last 3 minutes</div><div class="d-spark" style="height:64px;color:${hex(family(ep._app))}"></div>
            <div class="section-title">Details</div>
            ${kv([
              ['Address', `<span class="mono">${esc(ep.ip)}</span> ${copyBtn(ep.ip)}`],
              ep.names && ep.names.length ? ['Names', ep.names.slice(0, 4).map((n) => `<span class="mono">${esc(n)}</span>`).join('<br>')] : null,
              ['Network', ep.asn ? `AS${ep.asn} · ${esc(ep.org || '')}` : esc(ep.org || '—')],
              ['Location', esc(where)],
              ep.lat != null ? ['Coordinates', latLon(ep.lat, ep.lon)] : null,
              ['Protocol', esc(appName(ep._app))],
              pq ? ['Post-quantum', pq] : null,
              ['First seen', `${time(ep.first)} · ${ago(ep.first, s.now())}`],
              ['Last active', ago(ep.last, s.now())],
            ])}
            ${procs.length ? `<div class="section-title">Processes</div><div class="row" style="flex-wrap:wrap;gap:6px">${procs.map((p) => `<a href="#" class="badge outline" data-open="proc:${p.id}">${icon('cpu')}${esc(p.name)}</a>`).join('')}</div>` : ''}
            ${alerts.length ? `<div class="section-title">Alerts</div>${alerts.slice(0, 5).map((a) => `<div class="card hoverable" style="padding:10px 12px;margin-bottom:8px;cursor:pointer" data-open="alert:${a.id}"><div class="row">${sevBadge(a.sev)}<b class="ellipsis">${esc(a.title)}</b></div><div class="subtle" style="font-size:12px;margin-top:4px">${esc(a.detail || '')}</div></div>`).join('')}` : ''}`;
          const sp = wrap.querySelector('.d-spark');
          const hist = app.history.epSeries(ep.id);
          if (hist) spark(sp, Array.from(hist), 'currentColor', { w: 300, h: 64, slots: hist.slots });
          return wrap;
        },
      },
      { value: 'flows', label: `Connections`, count: flows.length, render: () => flows.length ? flows.slice(0, 40).map((f) => flowRow(app, f)).join('') : '<div class="subtle">No active connections.</div>' },
      {
        value: 'timeline', label: 'Timeline', render: () => timeline([
          { ts: ep.first, html: 'First packet exchanged' },
          ...s.dns.filter((d) => (d.answers || []).includes(ep.ip)).slice(-12).map((d) => ({ ts: d.ts, html: `DNS: <span class="mono">${esc(d.q)}</span> resolved here`, color: 'var(--viz-dns)' })),
          ...flows.map((f) => ({ ts: f.start, html: `${esc(appName(f.app))} connection to port ${f.rport}${f.proc && s.procs.get(f.proc) ? ` by ${esc(s.procs.get(f.proc).name)}` : ''}`, color: hex(f.app) })),
          ...alerts.map((a) => ({ ts: a.first || a.ts, html: `Alert: ${esc(a.title)}`, color: 'var(--danger)' })),
        ]),
      },
      { value: 'raw', label: 'Raw', render: () => rawJSON(ep) },
    ],
    actions: [
      { label: 'Show on map', icon: 'globe', onClick: () => app.showOnMap(ep) },
      { label: 'Filter connections', icon: 'filter', onClick: () => app.navigate('connections', { host: ep.name || ep.ip }) },
    ],
  };
}

// ── flow ─────────────────────────────────────────────────────────────────────
function flowDesc(app, id) {
  const s = app.store;
  const f = s.flows.get(id);
  if (!f) return null;
  const ep = s.endpoints.get(f.ep);
  const p = f.proc ? s.procs.get(f.proc) : null;
  const tls = f.sni || f.alpn || f.tlsv || f.ja4;
  return {
    title: `${p ? p.name : 'Unknown'} → ${ep ? middleTruncate(ep.name || ep.ip, 34) : '…'}`,
    sub: `${appName(f.app)} · ${f.proto.toUpperCase()} :${f.lport} → :${f.rport}`,
    avatar: { icon: 'connections', color: hex(family(f.app)) },
    badges: [protoBadge(f.app), badge('outline', f.state), badge('outline', f.dir === 'in' ? 'Inbound' : 'Outbound'), f.ech ? badge('success', 'ECH') : '', f.pq ? badge('success', 'Post-quantum') : '', f.threat ? badge('danger', `Threat ${f.threat}`) : ''].join(' '),
    tabs: [
      {
        value: 'overview', label: 'Overview', render: () => `
          <div class="stat-grid">${stat('Inbound', rate(f.rateIn))}${stat('Outbound', rate(f.rateOut))}${stat('RTT', f.rtt != null ? `${f.rtt.toFixed(1)}<small class="subtle"> ms</small>` : '—')}</div>
          <div class="section-title">Connection</div>
          ${kv([
            ['Process', p ? link('proc', p.id, `${p.name} (pid ${p.pid})`) : '<span class="subtle">unattributed</span>'],
            ['Remote', ep ? link('ep', ep.id, ep.name || ep.ip) : '—'],
            ep ? ['Address', `<span class="mono">${esc(ep.ip)}:${f.rport}</span>`] : null,
            ['Local port', `<span class="mono">${f.lport}</span>`],
            ['Transport', f.proto.toUpperCase()],
            ['State', esc(f.state)],
            ['Started', `${time(f.start)} · ${duration(s.now() - f.start)} ago`],
            ['Transferred', `↓ ${bytes(f.bytesIn)} (${integer(f.pktsIn)} pkts) · ↑ ${bytes(f.bytesOut)} (${integer(f.pktsOut)} pkts)`],
          ])}
          ${tls ? `<div class="section-title">TLS handshake</div>${kv([
            ['SNI', f.sni ? `<span class="mono">${esc(f.sni)}</span>` : '<span class="subtle">none</span>'],
            ['ALPN', esc(f.alpn || '—')],
            ['Version', f.tlsv ? `TLS ${esc(f.tlsv)}` : '—'],
            ['JA4', f.ja4 ? `<span class="mono">${esc(f.ja4)}</span> ${copyBtn(f.ja4)}` : '—'],
            ['ECH', f.ech ? '<span style="color:var(--success)">Encrypted Client Hello</span>' : 'Not used'],
            ['Post-quantum', f.pq ? '<span style="color:var(--success)">ML-KEM hybrid offered</span>' : typeof f.pq === 'boolean' ? 'Not offered' : '—'],
          ])}` : ''}`,
      },
      { value: 'raw', label: 'Raw', render: () => rawJSON(f) },
    ],
    actions: [
      ep ? { label: 'Open host', icon: 'hosts', onClick: () => app.openEntity({ type: 'ep', id: ep.id }) } : null,
      p ? { label: 'Open process', icon: 'cpu', onClick: () => app.openEntity({ type: 'proc', id: p.id }) } : null,
    ].filter(Boolean),
  };
}

// ── process ──────────────────────────────────────────────────────────────────
function procDesc(app, id) {
  const s = app.store;
  const p = s.procs.get(id);
  if (!p) return null;
  const flows = [...s.flows.values()].filter((f) => f.proc === id).sort((a, b) => (b.rateIn + b.rateOut) - (a.rateIn + a.rateOut));
  const hosts = new Map();
  for (const f of flows) {
    const ep = s.endpoints.get(f.ep);
    if (!ep) continue;
    const x = hosts.get(ep.id) || { ep, rate: 0 };
    x.rate += (f.rateIn || 0) + (f.rateOut || 0);
    hosts.set(ep.id, x);
  }
  return {
    title: p.name,
    sub: `pid ${p.pid} · ${p.user || 'unknown user'}`,
    avatar: { icon: 'cpu', color: 'var(--accent-2)' },
    badges: [p.unit ? badge('outline', p.unit) : '', p.container ? badge('accent', p.container) : ''].join(' '),
    tabs: [
      {
        value: 'overview', label: 'Overview', render: () => {
          const wrap = h('div');
          wrap.innerHTML = `
            <div class="stat-grid">${stat('Inbound', rate(p.rateIn))}${stat('Outbound', rate(p.rateOut))}${stat('Connections', integer(p.flows))}</div>
            <div class="section-title">Traffic · last 3 minutes</div><div class="d-spark" style="height:64px;color:var(--accent)"></div>
            <div class="section-title">Process</div>
            ${kv([
              ['PID', `<span class="mono">${p.pid}</span>`],
              ['User', esc(p.user || '—')],
              ['Executable', `<span class="mono">${esc(p.exe || '—')}</span>`],
              ['Command', `<span class="mono">${esc(p.cmd || '—')}</span>`],
              ['Unit', esc(p.unit || '—')],
              p.container ? ['Container', esc(p.container)] : null,
              ['Transferred', `↓ ${bytes(p.bytesIn)} · ↑ ${bytes(p.bytesOut)}`],
            ])}
            ${hosts.size ? `<div class="section-title">Talks to</div>${[...hosts.values()].sort((a, b) => b.rate - a.rate).slice(0, 8).map((x) => `<div class="row" style="padding:5px 0"><a href="#" data-open="ep:${x.ep.id}" class="ellipsis">${esc(x.ep.name || x.ep.ip)}</a><span class="subtle ellipsis">${esc(x.ep.city || '')}</span><span class="spacer"></span><span class="num">${rate(x.rate)}</span></div>`).join('')}` : ''}`;
          const hist = app.history.procSeries(p.id);
          if (hist) spark(wrap.querySelector('.d-spark'), Array.from(hist), 'currentColor', { w: 300, h: 64, slots: hist.slots });
          return wrap;
        },
      },
      { value: 'flows', label: 'Connections', count: flows.length, render: () => flows.length ? flows.slice(0, 40).map((f) => flowRow(app, f)).join('') : '<div class="subtle">No active connections.</div>' },
      { value: 'raw', label: 'Raw', render: () => rawJSON(p) },
    ],
    actions: [{ label: 'Filter connections', icon: 'filter', onClick: () => app.navigate('connections', { proc: p.name }) }],
  };
}

// ── alert ────────────────────────────────────────────────────────────────────
function alertDesc(app, id) {
  const s = app.store;
  const a = s.alerts.get(id);
  if (!a) return null;
  const sev = SEVERITY[a.sev] || SEVERITY.medium;
  const ep = a.ep ? s.endpoints.get(a.ep) : null;
  const p = a.proc ? s.procs.get(a.proc) : null;
  const f = a.flow ? s.flows.get(a.flow) : null;
  const st = a.state || 'open';
  const ev = Object.entries(a.evidence || {});
  return {
    title: a.title,
    sub: `${ALERT_KINDS[a.kind] || a.kind} · score ${a.score ?? '—'}`,
    avatar: { icon: 'shield-alert', color: `var(${sev.var})` },
    badges: `${sevBadge(a.sev)} ${stateBadge(a)} ${a.count > 1 ? badge('outline', `×${a.count}`) : ''}${a._pending ? ` ${badge('outline', 'Syncing…')}` : ''}`,
    tabs: [
      {
        value: 'overview', label: 'Overview', render: () => `
          <p style="font-size:14px;line-height:1.55">${esc(a.detail || '')}</p>
          <div class="stat-grid" style="margin-top:14px">${stat('Occurrences', integer(a.count || 1))}${stat('First seen', ago(a.first || a.ts, s.now()))}${stat('Last seen', ago(a.ts, s.now()))}</div>
          ${ev.length ? `<div class="section-title">Evidence</div>${kv(ev.map(([k, v]) => [k.replace(/_/g, ' '), `<span class="mono">${esc(Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? (Number.isInteger(v) ? integer(v) : v.toFixed(3)) : String(v))}</span>`]))}` : ''}
          <div class="section-title">Related</div>
          ${kv([
            ['Host', ep ? link('ep', ep.id, ep.name || ep.ip) : a.ep ? '<span class="subtle">expired</span>' : '—'],
            ['Process', p ? link('proc', p.id, `${p.name} (pid ${p.pid})`) : '—'],
            ['Connection', f ? link('flow', f.id, `${appName(f.app)} :${f.lport} → :${f.rport}`) : '—'],
          ])}
          <div class="section-title">Workflow</div>
          ${kv([
            ['State', `${esc(STATE_LABEL[st] || st)} · since ${time(a.stateTs || a.ts)}`],
            ['Muted', a.muted ? 'Yes — recurrences update silently and do not raise the threat level' : 'No'],
          ])}`,
      },
      {
        value: 'timeline', label: 'Timeline', render: () => timeline([
          { ts: a.first || a.ts, html: 'First detected', color: `var(${sev.var})` },
          ...(a.count > 1 ? [{ ts: a.ts, html: `Latest occurrence (×${a.count})`, color: `var(${sev.var})` }] : []),
          ...(a._events || []).slice(1).map((e) => ({ ts: e.at, html: e.muted ? 'Muted' : `State: ${STATE_LABEL[e.state] || e.state}${e.count > 1 ? ` · ×${e.count}` : ''}`, color: e.state === 'resolved' ? 'var(--success)' : 'var(--text-3)' })),
        ]),
      },
      { value: 'raw', label: 'Raw', render: () => rawJSON(a) },
    ],
    actions: [
      st === 'open' ? { label: 'Acknowledge', icon: 'check', kind: 'primary', onClick: () => app.alertCommand(a, 'ack') } : null,
      st !== 'resolved' ? { label: 'Resolve', icon: 'check-circle', onClick: () => app.alertCommand(a, 'resolve') } : { label: 'Reopen', icon: 'undo', onClick: () => app.alertCommand(a, 'reopen') },
      { label: a.muted ? 'Unmute' : 'Mute similar', icon: a.muted ? 'bell' : 'mute', onClick: () => app.alertCommand(a, a.muted ? 'unmute' : 'mute') },
    ].filter(Boolean),
  };
}

// ── trace ────────────────────────────────────────────────────────────────────
function traceDesc(app, id) {
  const t = app.store.traces.get(id);
  if (!t) return null;
  const last = t.hops[t.hops.length - 1];
  return {
    title: t.name || t.dst,
    sub: `${t.dst} · ${last ? last.n : t.hops.length} hops${last && last.rtt != null ? ` · ${Math.round(last.rtt)} ms` : ''}`,
    avatar: { icon: 'route', color: 'var(--warning)' },
    badges: t.done ? badge('success', 'Complete') : badge('warning', 'Probing'),
    tabs: [
      { value: 'overview', label: 'Hops', render: () => hopTable(t) },
      { value: 'raw', label: 'Raw', render: () => rawJSON(t) },
    ],
    actions: [{ label: 'Open in Traces', icon: 'route', onClick: () => app.navigate('traces', { trace: t.id }) }],
  };
}

export function hopTable(t) {
  const max = Math.max(1, ...t.hops.map((x) => x.rtt || 0));
  let prev = 0;
  return `<div class="hops">${t.hops.map((hp) => {
    const d = hp.rtt != null ? hp.rtt - prev : null;
    if (hp.rtt != null) prev = hp.rtt;
    const where = hp.scope === 'public' ? [hp.city, hp.cc].filter(Boolean).join(', ') : 'Local network';
    return `<div class="hop">
      <div class="hop-n">${hp.n}</div>
      <div class="hop-main"><div class="hop-name">${esc(hp.name || hp.ip)}</div><div class="hop-sub"><span class="mono">${esc(hp.ip)}</span> · ${esc(where)}${hp.org ? ` · ${esc(hp.org)}` : ''}</div></div>
      <div class="hop-rtt"><div class="num">${hp.rtt != null ? `${hp.rtt < 10 ? hp.rtt.toFixed(1) : Math.round(hp.rtt)} ms` : '—'}</div>
        <div class="hop-bar"><i style="transform:scaleX(${(hp.rtt || 0) / max})"></i></div>
        ${d != null && d > 25 ? `<div class="hop-jump">+${Math.round(d)} ms</div>` : ''}</div></div>`;
  }).join('')}</div>`;
}

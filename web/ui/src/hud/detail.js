import { esc, bytes, rate, ago, duration, latLon, timeOfDay } from '../util/format.js';
import { appColor, cssColor, SEVERITY, ALERT_KINDS, SERVICES } from '../config.js';
import { sparkline, fitCanvas } from './charts.js';

/** "Post-quantum" summary for an endpoint's TLS/QUIC flows (Flow.pq). */
function pqRow(flows) {
  const known = flows.filter((f) => typeof f.pq === 'boolean');
  if (!known.length) return '';
  const yes = known.filter((f) => f.pq).length;
  const val = yes === known.length
    ? '<span style="color:var(--green)">ML-KEM ✓</span>'
    : yes ? `<span style="color:var(--amber)">ML-KEM on ${yes} of ${known.length} handshakes</span>`
      : '<span style="color:var(--muted)">not offered</span>';
  return `<dt>Post-quantum</dt><dd title="client offered a post-quantum hybrid key exchange (X25519MLKEM768)">${val}</dd>`;
}

/** Slide-in panel with everything known about one endpoint. */
export class Detail {
  constructor(store, { onClose, onFocusProc }) {
    this.store = store;
    this.el = document.getElementById('detail');
    this.body = document.getElementById('detail-body');
    this.onClose = onClose;
    this.onFocusProc = onFocusProc;
    this.epId = 0;
    this.last = 0;
    document.getElementById('detail-close').addEventListener('click', () => this.close());
    this.body.addEventListener('click', (e) => {
      const p = e.target.closest('[data-proc]');
      if (p) this.onFocusProc(Number(p.dataset.proc));
    });
    store.on('ep-gone', (ep) => {
      if (ep.id === this.epId) this.render(ep, true);
    });
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  open(id) {
    this.epId = id;
    this.el.classList.add('open');
    document.getElementById('hud').classList.add('detail-open');
    this.render();
  }

  close() {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    document.getElementById('hud').classList.remove('detail-open');
    this.epId = 0;
    this.onClose();
  }

  update(now) {
    if (!this.isOpen || now - this.last < 1000) return;
    this.last = now;
    this.render();
  }

  render(gone = null, isGone = false) {
    const ep = gone || this.store.endpoints.get(this.epId);
    if (!ep) return;
    const s = this.store;
    const scroll = this.body.scrollTop;
    const flows = s.flowsOf(ep.id).sort((a, b) => (b.rateIn + b.rateOut) - (a.rateIn + a.rateOut) || b.start - a.start);
    const alerts = s.alertsFor({ ep: ep.id });
    const procs = new Map();
    for (const f of flows) if (f.proc && s.procs.has(f.proc)) procs.set(f.proc, s.procs.get(f.proc));
    const chips = [];
    if (ep.svc) chips.push(`<span class="chip">${esc(SERVICES[ep.svc] || ep.svc)}</span>`);
    chips.push(`<span class="chip ${ep.scope === 'public' ? '' : 'violet'}">${esc(ep.scope)}</span>`);
    if (ep.threat) chips.push(`<span class="chip red">threat ${ep.threat}</span>`);
    for (const t of ep.tags || []) chips.push(`<span class="chip amber">${esc(t)}</span>`);
    if (isGone) chips.push('<span class="chip">expired</span>');
    const appRgb = appColor(ep._app);

    const loc = ep.scope === 'public'
      ? `<dl class="kv">
          <dt>City</dt><dd>${esc(ep.city || '—')}${ep.region ? `, ${esc(ep.region)}` : ''}</dd>
          <dt>Country</dt><dd>${ep.cc ? `<span class="cc">${esc(ep.cc)}</span> ` : ''}${esc(ep.country || '—')}</dd>
          <dt>Coordinates</dt><dd>${latLon(ep.lat, ep.lon)}</dd>
          <dt>Network</dt><dd>${ep.asn ? `AS${ep.asn} · ` : ''}${esc(ep.org || '—')}</dd>
        </dl>`
      : `<dl class="kv"><dt>Network</dt><dd>${ep.scope === 'multicast' ? 'Multicast group' : 'Local network'}</dd><dt>Location</dt><dd>orbiting home — not a place on the map</dd></dl>`;

    const threat = alerts.length
      ? `<h3>Threat</h3>${alerts.slice(0, 6).map((a) => {
          const sev = SEVERITY[a.sev] || SEVERITY.medium;
          const ev = Object.entries(a.evidence || {}).slice(0, 8)
            .map(([k, v]) => `<span>${esc(k)}</span><span>${esc(Array.isArray(v) ? v.join(', ') : String(v))}</span>`).join('');
          return `<div class="threat-box" style="border-color:${sev.color}55">
            <div style="display:flex;justify-content:space-between;align-items:baseline">
              <span class="chip" style="color:${sev.color}">${sev.label} · ${esc(ALERT_KINDS[a.kind] || a.kind)}</span>
              <span style="color:var(--faint);font-size:9px">${ago(a.ts, s.now())} ago · score ${a.score ?? '—'}</span></div>
            <div class="tt" style="margin-top:5px">${esc(a.title)}</div>
            <div class="td">${esc(a.detail || '')}</div>
            ${ev ? `<div class="ev">${ev}</div>` : ''}</div>`;
        }).join('')}`
      : '';

    const flowRows = flows.slice(0, 24).map((f) => {
      const p = f.proc ? s.procs.get(f.proc) : null;
      const rgb = appColor(f.app);
      const tls = f.sni || f.alpn || f.tlsv
        ? `<div class="dim">${f.sni ? `SNI <span style="color:var(--text)">${esc(f.sni)}</span>` : 'no SNI'}${f.alpn ? ` · ${esc(f.alpn)}` : ''}${f.tlsv ? ` · TLS ${esc(f.tlsv)}` : ''}${f.ech ? ' · <span style="color:var(--green)">ECH</span>' : ''}${f.pq ? ' · <span style="color:var(--green)" title="client offered a post-quantum hybrid key exchange (ML-KEM)">PQ ✓</span>' : ''}</div>`
        : '';
      const ja4 = f.ja4 ? `<div class="ja4">JA4 ${esc(f.ja4)}</div>` : '';
      return `<tr>
        <td><span class="app" style="color:${cssColor(rgb)}">${esc(String(f.app).toUpperCase())}</span><div class="dim">${esc(f.proto)}</div></td>
        <td>${f.dir === 'in' ? '←' : '→'} :${f.rport} <span class="dim">from :${f.lport}</span>
          <div class="dim">${esc(f.state)}${f.rtt != null ? ` · rtt ${f.rtt.toFixed(1)} ms` : ''}${p ? ` · <a data-proc="${p.id}" style="color:var(--cyan);cursor:pointer">${esc(p.name)}</a>` : ''}</div>
          ${tls}${ja4}</td>
        <td style="text-align:right;white-space:nowrap">${rate((f.rateIn || 0) + (f.rateOut || 0))}
          <div class="dim">↓${bytes(f.bytesIn)} ↑${bytes(f.bytesOut)}</div></td></tr>`;
    }).join('');

    const dnsHits = s.dns.filter((d) => (d.answers || []).includes(ep.ip)).slice(-6).reverse();
    const names = [...new Set([...(ep.names || []), ...dnsHits.map((d) => d.q)])];

    this.body.innerHTML = `
      <h2>${esc(ep.name || ep.ip)}</h2>
      <div class="ipline">${esc(ep.ip)}${ep.name ? '' : ' <span style="color:var(--muted)">· no name seen</span>'}</div>
      <div class="chips">${chips.join('')}</div>
      ${threat}
      <h3>Location</h3>${loc}
      <h3>Traffic</h3>
      <dl class="kv">
        <dt>Now</dt><dd><span style="color:#7ff3ff">↓ ${rate(ep.rateIn)}</span> &nbsp; <span style="color:#ff8be6">↑ ${rate(ep.rateOut)}</span></dd>
        <dt>Total</dt><dd>↓ ${bytes(ep.bytesIn)} &nbsp; ↑ ${bytes(ep.bytesOut)}</dd>
        <dt>Seen</dt><dd>${timeOfDay(ep.first)} → ${ago(ep.last, s.now())} ago <span style="color:var(--muted)">(${duration(ep.last - ep.first)})</span></dd>
        <dt>Dominant</dt><dd style="color:${cssColor(appRgb)}">${esc(String(ep._app || 'unknown').toUpperCase())}</dd>
        ${pqRow(flows)}
      </dl>
      <canvas class="spark" id="detail-spark"></canvas>
      ${procs.size ? `<h3>Processes</h3><dl class="kv">${[...procs.values()].map((p) => `<dt><a data-proc="${p.id}" style="color:var(--cyan);cursor:pointer">${esc(p.name)}</a></dt><dd class="mono">pid ${p.pid} · ${esc(p.user || '')}${p.unit ? ` · ${esc(p.unit)}` : ''}<br><span style="color:var(--muted)">${esc((p.cmd || p.exe || '').slice(0, 120))}</span></dd>`).join('')}</dl>` : ''}
      <h3>Flows · ${flows.length}</h3>
      ${flows.length ? `<table class="flows">${flowRows}</table>` : '<div style="color:var(--muted);font-size:10px">no active flows</div>'}
      ${names.length ? `<h3>Names</h3><dl class="kv">${names.slice(0, 8).map((n, i) => `<dt>${i === 0 ? 'resolved' : 'alias'}</dt><dd>${esc(n)}</dd>`).join('')}</dl>` : ''}
      ${dnsHits.length ? `<h3>DNS</h3><dl class="kv">${dnsHits.map((d) => `<dt>${timeOfDay(d.ts)}</dt><dd>${esc(d.q)} <span style="color:var(--muted)">${esc(d.qtype)}${d.ms != null ? ` · ${d.ms.toFixed(1)} ms` : ''}</span></dd>`).join('')}</dl>` : ''}
    `;
    this.body.scrollTop = scroll;
    const cv = document.getElementById('detail-spark');
    if (cv && ep._hist) {
      fitCanvas(cv);
      const n = Math.max(2, ep._histN || 0);
      sparkline(cv, Array.from(ep._hist.slice(ep._hist.length - n)), appRgb);
    }
  }
}

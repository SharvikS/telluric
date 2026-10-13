import { h } from '../dom.js';
import { icon } from '../icons.js';
import { esc, time, middleTruncate, agoShort } from '../../util/format.js';
import { appName, SEVERITY, ALERT_KINDS } from '../../config.js';

const MAX = 60;
const QUIET = new Set(['dns', 'mdns', 'ssdp', 'ntp', 'dhcp']);

/**
 * Activity stream: connections, DNS answers, alerts and traceroutes as calm,
 * linkable events. New events slide in at the top; bursts are rate-limited.
 */
export class Activity {
  constructor(store, { max = 12, onOpen } = {}) {
    this.store = store;
    this.max = max;
    this.onOpen = onOpen;
    this.el = h('div.activity');
    this.events = [];
    this.queue = [];
    this.window = [];
    this.paused = false;
    store.on('flow', (f, isNew) => {
      if (!isNew || QUIET.has(f.app)) return;
      this.push({ kind: 'conn', ts: f.start || Date.now(), flow: f.id, ep: f.ep });
    });
    store.on('dns', (items) => {
      for (const d of items) {
        if (d.rcode && d.rcode !== 'NOERROR') this.push({ kind: 'nx', ts: d.ts, dns: d });
        else this.push({ kind: 'dns', ts: d.ts, dns: d }, true);
      }
    });
    store.on('alert', (a, isNew) => {
      if (isNew && !a.muted) this.push({ kind: 'alert', ts: a.ts, alert: a.id }, false, true);
    });
    store.on('trace', (t, isNew) => {
      if (t.done && !t._announced) {
        t._announced = true;
        this.push({ kind: 'trace', ts: Date.now(), trace: t.id }, false, true);
      }
    });
    store.on('reset', () => {
      this.events = [];
      this.queue = [];
      this.el.innerHTML = '';
    });
  }

  push(ev, low = false, important = false) {
    const now = performance.now();
    this.window = this.window.filter((t) => now - t < 1000);
    if (!important && this.window.length >= (low ? 3 : 6)) return;
    this.window.push(now);
    this.queue.push(ev);
  }

  /** Called from the frame loop; renders queued events. */
  flush() {
    if (this.paused || !this.queue.length) return;
    const items = this.queue.splice(0);
    for (const ev of items) this.events.unshift(ev);
    this.events.length = Math.min(this.events.length, MAX);
    // Render the newest `max`, animating only fresh rows.
    const frag = document.createDocumentFragment();
    const fresh = new Set(items);
    for (const ev of this.events.slice(0, this.max)) {
      let el = ev._el;
      if (!el) {
        el = ev._el = this.renderEvent(ev);
        if (!el) continue;
        el.addEventListener('click', () => this.onOpen?.(ev));
      }
      el.classList.toggle('enter', fresh.has(ev));
      frag.appendChild(el);
    }
    this.el.replaceChildren(frag);
  }

  tickTimes() {
    const now = this.store.now();
    for (const ev of this.events.slice(0, this.max)) {
      const t = ev._el?.querySelector('.a-time');
      if (t) t.textContent = agoShort(ev.ts, now);
    }
  }

  renderEvent(ev) {
    const s = this.store;
    let ic = 'activity', text = '', sub = '', tone = '';
    if (ev.kind === 'conn') {
      const f = s.flows.get(ev.flow);
      const ep = s.endpoints.get(ev.ep);
      const p = f && f.proc ? s.procs.get(f.proc) : null;
      ic = 'connections';
      text = `<b>${esc(p ? p.name : 'Unknown process')}</b> connected to <b>${esc(middleTruncate(ep ? ep.name || ep.ip : '…', 34))}</b>`;
      sub = [f ? appName(f.app) : '', ep && ep.city ? `${ep.city}, ${ep.cc}` : ep && ep.scope !== 'public' ? 'Local network' : '', f ? `port ${f.rport}` : ''].filter(Boolean).join(' · ');
    } else if (ev.kind === 'dns') {
      ic = 'dns';
      text = `Resolved <b>${esc(middleTruncate(ev.dns.q, 40))}</b>`;
      sub = `${ev.dns.qtype} → ${(ev.dns.answers || [])[0] || '—'}${ev.dns.ms != null ? ` · ${ev.dns.ms.toFixed(ev.dns.ms < 10 ? 1 : 0)} ms` : ''}`;
    } else if (ev.kind === 'nx') {
      ic = 'dns';
      tone = 'warning';
      text = `<b>${esc(middleTruncate(ev.dns.q, 40))}</b> does not exist`;
      sub = `${ev.dns.qtype} · ${ev.dns.rcode}`;
    } else if (ev.kind === 'alert') {
      const a = s.alerts.get(ev.alert);
      if (!a) return null;
      const sev = SEVERITY[a.sev] || SEVERITY.medium;
      ic = 'shield-alert';
      tone = sev.css;
      text = `<b>${esc(a.title)}</b>`;
      sub = `${sev.label} · ${ALERT_KINDS[a.kind] || a.kind}`;
    } else if (ev.kind === 'trace') {
      const t = s.traces.get(ev.trace);
      if (!t) return null;
      const last = t.hops[t.hops.length - 1];
      ic = 'route';
      tone = 'warning';
      text = `Traceroute to <b>${esc(t.name || t.dst)}</b>`;
      sub = `${last ? last.n : t.hops.length} hops${last && last.rtt != null ? ` · ${Math.round(last.rtt)} ms` : ''}`;
    }
    const icEl = h('div.a-ic', { html: icon(ic) });
    if (tone) icEl.style.color = `var(--${tone})`;
    return h('div.act', icEl, h('div', { style: { minWidth: 0 } }, h('div.a-text', { html: text }), h('div.a-sub', sub)),
      h('div.a-time', { title: time(ev.ts) }, agoShort(ev.ts, s.now())));
  }
}

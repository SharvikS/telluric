import { esc, timeOfDay, middleTruncate } from '../util/format.js';
import { SEVERITY, ALERT_KINDS } from '../config.js';

const MAX_LINES = 90;
const MAX_PER_SEC = 12;

/**
 * Terminal-style event log. The newest line types itself out; bursts above
 * MAX_PER_SEC are folded into a single "+N more" line so the log stays
 * readable during a download storm or a DGA burst.
 */
export class Feed {
  constructor(el, countEl, store) {
    this.el = el;
    this.countEl = countEl;
    this.store = store;
    this.queue = [];
    this.window = [];
    this.suppressed = 0;
    this.typing = null;
    this.total = 0;
    this.connLines = new Map(); // flow id → feed line awaiting process attribution

    store.on('dns', (items) => {
      for (const d of items) {
        if (d.rcode && d.rcode !== 'NOERROR') {
          this.push('nx', d.rcode === 'NXDOMAIN' ? 'NX' : d.rcode.slice(0, 5), `<b>${esc(middleTruncate(d.q, 46))}</b> ${d.qtype}`, d.ts);
        } else {
          const ans = d.answers && d.answers.length ? d.answers[0] + (d.answers.length > 1 ? ` +${d.answers.length - 1}` : '') : '—';
          const ms = d.ms != null ? ` <span style="color:var(--faint)">${d.ms.toFixed(d.ms < 10 ? 1 : 0)}ms</span>` : '';
          this.push('dns', 'DNS', `<b>${esc(middleTruncate(d.q, 34))}</b> → ${esc(ans)}${ms}`, d.ts);
        }
      }
    });
    // Resolver chatter already appears as DNS lines; don't double it as connections.
    const quiet = new Set(['dns', 'mdns', 'ssdp', 'ntp', 'dhcp']);
    store.on('flow', (f, isNew) => {
      if (!isNew) {
        // Attribution usually lands a few hundred ms after the flow: patch the line.
        const ln = this.connLines.get(f.id);
        if (ln && f.proc) {
          this.patchWho(ln);
          this.connLines.delete(f.id);
        }
        return;
      }
      if (quiet.has(f.app)) return;
      const ep = store.endpoints.get(f.ep);
      const p = f.proc ? store.procs.get(f.proc) : null;
      const who = `<span class="who" data-flow="${f.id}">${p ? esc(p.name) : '<span style="color:var(--faint)">…</span>'}</span>`;
      const host = ep ? esc(middleTruncate(ep.name || ep.ip, 30)) : '…';
      const where = ep && ep.cc ? ` <span style="color:var(--faint)">${esc(ep.cc)}</span>` : ep && ep.scope !== 'public' ? ' <span style="color:var(--faint)">LAN</span>' : '';
      const arrow = f.dir === 'in' ? '←' : '→';
      this.push('conn', f.dir === 'in' ? 'IN' : 'CONN', `${who} ${arrow} <b>${host}</b>:${f.rport} ${String(f.app).toUpperCase()}${where}`, f.start);
    });
    store.on('alert', (a, isNew) => {
      if (!isNew) return;
      const sev = SEVERITY[a.sev] || SEVERITY.medium;
      this.push('alert', 'ALERT', `<span style="color:${sev.color};font-weight:800">${sev.label}</span> ${esc(ALERT_KINDS[a.kind] || a.kind)} · <b>${esc(a.title)}</b>`, a.ts, true);
    });
  }

  system(text) {
    this.push('sys', 'SYS', text, Date.now(), true);
  }

  patchWho(ln) {
    const span = ln.querySelector('.who');
    if (!span) return;
    const f = this.store.flows.get(Number(span.dataset.flow));
    const p = f && f.proc ? this.store.procs.get(f.proc) : null;
    if (p) span.textContent = p.name;
  }

  push(cls, tag, html, ts, priority = false) {
    const now = performance.now();
    while (this.window.length && now - this.window[0] > 1000) this.window.shift();
    if (!priority && this.window.length >= MAX_PER_SEC) {
      this.suppressed++;
      return;
    }
    this.window.push(now);
    this.queue.push({ cls, tag, html, ts: ts || Date.now() });
  }

  update() {
    if (this.suppressed && this.window.length < MAX_PER_SEC / 2) {
      this.queue.push({ cls: 'sys', tag: '···', html: `<span style="color:var(--muted)">+${this.suppressed} more events</span>`, ts: Date.now() });
      this.suppressed = 0;
    }
    if (!this.queue.length) return;
    const items = this.queue.splice(0);
    if (this.typing) this.finishTyping();
    const frag = document.createDocumentFragment();
    let lastLine = null;
    for (const it of items) {
      const ln = document.createElement('div');
      ln.className = `ln ${it.cls}`;
      ln.innerHTML = `<span class="ts">${timeOfDay(it.ts)}</span><span class="k">${it.tag}</span><span class="msg">${it.html}</span>`;
      const who = ln.querySelector('.who');
      if (who) {
        this.connLines.set(Number(who.dataset.flow), ln);
        if (this.connLines.size > 150) this.connLines.delete(this.connLines.keys().next().value);
      }
      frag.appendChild(ln);
      lastLine = ln;
      this.total++;
    }
    this.el.appendChild(frag);
    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild.remove();
    if (lastLine) this.typeOut(lastLine);
    if (this.countEl) this.countEl.textContent = `${this.total}`;
  }

  /** Reveal the last line's message character by character. */
  typeOut(ln) {
    const msg = ln.querySelector('.msg');
    const full = msg.innerHTML;
    const text = msg.textContent;
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    let i = 0;
    msg.textContent = '';
    msg.appendChild(cursor);
    const ln2 = ln;
    const step = () => {
      i = Math.min(text.length, i + 3);
      msg.textContent = text.slice(0, i);
      msg.appendChild(cursor);
      if (i >= text.length) return this.finishTyping();
      this.typing.timer = setTimeout(step, 14);
    };
    this.typing = { msg, full, ln: ln2, timer: setTimeout(step, 14) };
  }

  finishTyping() {
    if (!this.typing) return;
    clearTimeout(this.typing.timer);
    this.typing.msg.innerHTML = this.typing.full;
    // The process may have been attributed while the line was typing.
    this.patchWho(this.typing.ln);
    this.typing = null;
  }
}

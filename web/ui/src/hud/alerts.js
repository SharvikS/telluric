import { esc, ago } from '../util/format.js';
import { SEVERITY, ALERT_KINDS } from '../config.js';

/** Alert list panel: newest first, click to focus the related endpoint. */
export class AlertList {
  constructor(el, countEl, store, { onSelect }) {
    this.el = el;
    this.countEl = countEl;
    this.store = store;
    this.onSelect = onSelect;
    this.cards = new Map();
    this.lastAges = 0;
    this.empty = document.createElement('div');
    this.empty.className = 'empty';
    this.empty.textContent = 'no alerts · all quiet';
    this.el.appendChild(this.empty);
    store.on('alert', (a, isNew) => this.upsert(a, isNew));
    store.on('reset', () => {
      for (const c of this.cards.values()) c.remove();
      this.cards.clear();
      this.empty.style.display = '';
      this.countEl.textContent = '';
    });
  }

  upsert(a, isNew) {
    let card = this.cards.get(a.id);
    if (!card) {
      card = document.createElement('div');
      card.className = 'alert-card';
      card.addEventListener('click', () => this.onSelect(a));
      this.cards.set(a.id, card);
      this.el.insertBefore(card, this.el.firstChild);
      while (this.cards.size > 120) {
        const [id, old] = this.cards.entries().next().value;
        old.remove();
        this.cards.delete(id);
      }
    }
    const sev = SEVERITY[a.sev] || SEVERITY.medium;
    card.innerHTML = `<div class="sev" style="background:${sev.color};box-shadow:0 0 8px ${sev.color}"></div>
      <div class="kind" style="color:${sev.color}">${sev.label} · ${esc(ALERT_KINDS[a.kind] || a.kind)}</div>
      <div class="when" data-ts="${a.ts}">${ago(a.ts, this.store.now())}</div>
      <div class="title">${esc(a.title)}</div>
      <div class="det">${esc(a.detail || '')}</div>`;
    this.empty.style.display = 'none';
    this.countEl.textContent = `${this.store.alerts.size}`;
  }

  update(now) {
    if (now - this.lastAges < 5000) return;
    this.lastAges = now;
    const t = this.store.now();
    for (const el of this.el.querySelectorAll('.when')) el.textContent = ago(Number(el.dataset.ts), t);
  }
}

/**
 * Hacker-movie alert banner for medium+ alerts. Queued, typed out, and it
 * reports intensity so the renderer can glitch and the camera can shake.
 */
export class Banner {
  constructor(store, { onShow, onClick }) {
    this.el = document.getElementById('banner');
    this.k = document.getElementById('banner-k');
    this.t = document.getElementById('banner-t');
    this.d = document.getElementById('banner-d');
    this.queue = [];
    this.current = null;
    this.onShow = onShow;
    this.el.addEventListener('click', () => this.current && onClick(this.current));
    store.on('alert', (a, isNew) => {
      if (!isNew) return;
      const rank = (SEVERITY[a.sev] || SEVERITY.info).rank;
      if (rank < 2) return;
      // Don't replay a backlog: only alerts from the last few seconds.
      if (store.now() - a.ts > 8000) return;
      this.queue.push(a);
      if (this.queue.length > 4) this.queue.splice(0, this.queue.length - 4);
      if (!this.current) this.next();
    });
  }

  next() {
    clearTimeout(this.timer);
    clearInterval(this.typer);
    const a = this.queue.shift();
    this.current = a || null;
    if (!a) {
      this.el.classList.remove('show');
      return;
    }
    const sev = SEVERITY[a.sev] || SEVERITY.medium;
    this.el.className = `banner sev-${a.sev} show`;
    this.k.textContent = `THREAT DETECTED · ${sev.label} · ${ALERT_KINDS[a.kind] || a.kind}`;
    this.d.textContent = a.detail || '';
    this.t.textContent = '';
    const title = a.title;
    let i = 0;
    this.typer = setInterval(() => {
      i += 2;
      this.t.textContent = title.slice(0, i) + (i < title.length ? '▌' : '');
      if (i >= title.length) clearInterval(this.typer);
    }, 22);
    this.onShow(a);
    const hold = a.sev === 'critical' ? 7000 : a.sev === 'high' ? 6000 : 4500;
    this.timer = setTimeout(() => {
      this.el.classList.remove('show');
      this.timer = setTimeout(() => this.next(), 350);
    }, hold);
  }
}

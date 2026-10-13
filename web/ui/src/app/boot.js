import { h } from '../ui/dom.js';
import { icon, MARK } from '../ui/icons.js';
import { motion } from './motion.js';

/**
 * Boot sequence: the mark draws itself, then real steps tick off as they
 * complete (map data, engine link, first snapshot). The overlay lifts as the
 * globe zooms in from space and the app shell staggers into place.
 */
export class Boot {
  constructor() {
    this.steps = new Map();
    this.list = h('div.boot-steps');
    this.el = h('div.boot', { role: 'status', 'aria-live': 'polite' },
      h('div.boot-card',
        h('div.boot-mark', { html: MARK }),
        h('div.boot-title', h('h1', 'Telluric'), h('p', 'Your network, live on a globe')),
        this.list));
    document.body.appendChild(this.el);
    this.t0 = performance.now();
  }

  step(key, label) {
    const ic = h('span.ic', h('span.spinner'));
    const ms = h('span.ms');
    const row = h('div.boot-step.active', ic, h('span', label), ms);
    this.list.appendChild(row);
    this.steps.set(key, { row, ic, ms, t: performance.now(), done: false });
  }

  done(key) {
    const s = this.steps.get(key);
    if (!s || s.done) return;
    s.done = true;
    s.row.classList.remove('active');
    s.row.classList.add('done');
    s.ic.innerHTML = `<span class="tick">${icon('check')}</span>`;
    s.ic.querySelector('svg').style.cssText = 'width:15px;height:15px';
    s.ms.textContent = `${Math.round(performance.now() - s.t)} ms`;
  }

  fail(message) {
    this.list.replaceWith(h('div.boot-error', { html: message }));
  }

  /** Resolves when the overlay has started leaving (min display time for polish). */
  async finish() {
    const minShow = motion.reduced ? 0 : 1250;
    const wait = Math.max(0, minShow - (performance.now() - this.t0));
    await new Promise((r) => setTimeout(r, wait));
    this.el.classList.add('leaving');
    setTimeout(() => this.el.remove(), 700);
  }
}

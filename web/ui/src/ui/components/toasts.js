import { h } from '../dom.js';
import { icon } from '../icons.js';
import { motion } from '../../app/motion.js';

const ICONS = { info: 'info', success: 'check-circle', warning: 'alert', danger: 'shield-alert' };
const VISIBLE = 3;

/**
 * Stacked toasts (bottom-right). Collapsed, older toasts tuck behind the
 * newest one, smaller and fainter; hovering the stack fans them out. Each
 * has a progress bar that pauses while the pointer is over the stack.
 */
export class Toaster {
  constructor() {
    this.root = h('div.toasts', { 'aria-live': 'polite' });
    document.body.appendChild(this.root);
    this.items = [];
    this.expanded = false;
    this.root.addEventListener('pointerenter', () => this.setExpanded(true));
    this.root.addEventListener('pointerleave', () => this.setExpanded(false));
  }

  setExpanded(on) {
    this.expanded = on;
    for (const t of this.items) {
      if (on) t.pause();
      else t.resume();
    }
    this.layout();
  }

  /** opts: { kind: info|success|warning|danger, title, desc, actions: [{label, onClick, primary}], duration } */
  show({ kind = 'info', title, desc = '', actions = [], duration = 5000, key } = {}) {
    if (key) {
      const dup = this.items.find((t) => t.key === key);
      if (dup) this.dismiss(dup);
    }
    const progress = h('div.t-progress');
    const close = h('button.t-close', { type: 'button', 'aria-label': 'Dismiss', html: icon('x') });
    const acts = actions.length
      ? h('div.t-actions', actions.map((a) => {
        const b = h(`button.btn.xs${a.primary ? '.primary' : ''}`, { type: 'button' }, a.label);
        b.addEventListener('click', () => {
          a.onClick?.();
          this.dismiss(t);
        });
        return b;
      }))
      : null;
    const el = h(`div.toast.${kind}`, { role: 'status' },
      h('div.t-ic', { html: icon(ICONS[kind] || 'info') }),
      h('div', h('div.t-title', title), desc ? h('div.t-desc', { html: desc }) : null, acts),
      close, progress);
    const t = {
      el, key, progress, duration, left: duration, startedAt: performance.now(), timer: 0, dead: false,
      pause() {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = 0;
          this.left -= performance.now() - this.startedAt;
          const p = getComputedStyle(this.progress).transform;
          this.progress.style.transition = 'none';
          this.progress.style.transform = p === 'none' ? 'scaleX(1)' : p;
        }
      },
      resume: () => {
        if (t.dead || t.timer || t.left <= 0) return;
        t.startedAt = performance.now();
        t.progress.style.transition = `transform ${t.left}ms linear`;
        t.progress.style.transform = 'scaleX(0)';
        t.timer = setTimeout(() => this.dismiss(t), t.left);
      },
    };
    close.addEventListener('click', () => this.dismiss(t));
    el.style.transform = 'translateY(24px) scale(0.96)';
    el.style.opacity = '0';
    this.root.appendChild(el);
    this.items.unshift(t);
    if (this.items.length > 8) this.dismiss(this.items[this.items.length - 1]);
    progress.style.transform = 'scaleX(1)';
    requestAnimationFrame(() => {
      this.layout();
      if (!this.expanded) t.resume();
    });
    return t;
  }

  dismiss(t) {
    if (t.dead) return;
    t.dead = true;
    clearTimeout(t.timer);
    this.items = this.items.filter((x) => x !== t);
    t.el.style.transition = `transform ${motion.reduced ? 1 : 260}ms var(--ease-in), opacity ${motion.reduced ? 1 : 200}ms`;
    t.el.style.transform = `${t.el.style.transform} translateX(30px)`;
    t.el.style.opacity = '0';
    setTimeout(() => t.el.remove(), 280);
    this.layout();
  }

  layout() {
    let y = 0;
    this.items.forEach((t, i) => {
      const hgt = t.el.offsetHeight;
      if (this.expanded) {
        t.el.style.transform = `translateY(${-y}px)`;
        t.el.style.opacity = '1';
        y += hgt + 10;
      } else {
        const k = Math.min(i, VISIBLE);
        t.el.style.transform = `translateY(${-k * 12}px) scale(${1 - k * 0.05})`;
        t.el.style.opacity = i >= VISIBLE ? '0' : String(1 - k * 0.18);
      }
      t.el.style.zIndex = String(100 - i);
      t.el.style.pointerEvents = !this.expanded && i > 0 ? 'none' : 'auto';
    });
  }
}

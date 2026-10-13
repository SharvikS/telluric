import { Emitter } from '../util/emitter.js';
import { motion } from './motion.js';

/**
 * Resolves the theme preference (system / dark / light) to a concrete mode,
 * applies it to <html data-theme>, and animates switches: a circular reveal
 * from the control that triggered it (View Transitions API), or a colour
 * cross-fade where that API is missing.
 */
export class Theme extends Emitter {
  constructor(prefs) {
    super();
    this.prefs = prefs;
    this.mq = window.matchMedia('(prefers-color-scheme: light)');
    this.mode = this.resolve();
    this.apply(this.mode);
    this.mq.addEventListener('change', () => {
      if (this.prefs.get('theme') === 'system') this.switchTo(this.resolve(), null);
    });
    prefs.on('change', (key) => {
      if (key === 'theme') this.switchTo(this.resolve(), this.origin);
    });
  }

  resolve() {
    const q = new URLSearchParams(location.search).get('theme');
    if ((q === 'dark' || q === 'light') && !this.overridden) return q;
    const p = this.prefs.get('theme');
    if (p === 'dark' || p === 'light') return p;
    return this.mq.matches ? 'light' : 'dark';
  }

  /** Set the preference, revealing the new theme from screen point `origin`. */
  set(pref, origin = null) {
    this.overridden = true; // an explicit choice beats the ?theme= URL override
    this.origin = origin;
    this.prefs.set('theme', pref);
    this.origin = null;
  }

  toggle(origin) {
    this.set(this.mode === 'dark' ? 'light' : 'dark', origin);
  }

  apply(mode) {
    document.documentElement.dataset.theme = mode;
    this.mode = mode;
    this.emit('change', mode);
  }

  switchTo(mode, origin) {
    if (mode === this.mode) return;
    if (motion.reduced) {
      this.apply(mode);
      return;
    }
    if (document.startViewTransition) {
      const x = origin ? origin.x : innerWidth / 2;
      const y = origin ? origin.y : 0;
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      try {
        this.vt?.skipTransition();
      } catch {
        /* nothing running */
      }
      const vt = document.startViewTransition(() => {
        this.apply(mode);
        this.emit('repaint');
      });
      this.vt = vt;
      vt.ready
        .then(() => {
          document.documentElement.animate(
            { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
            { duration: 620, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', pseudoElement: '::view-transition-new(root)' },
          );
        })
        .catch(() => {});
      vt.finished.finally(() => {
        if (this.vt === vt) this.vt = null;
      });
      return;
    }
    const html = document.documentElement;
    html.classList.add('theme-xfade');
    this.apply(mode);
    clearTimeout(this.xfadeTimer);
    this.xfadeTimer = setTimeout(() => html.classList.remove('theme-xfade'), 320);
  }
}

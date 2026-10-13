// Motion system: reduced-motion state, JS springs and tweens that share the
// CSS tokens' feel, a WAAPI wrapper that honours the preference, and FLIP.

export const motion = {
  reduced: false,
  /** Durations in ms, mirroring tokens.css. */
  dur: { instant: 90, fast: 150, base: 220, slow: 340, slower: 520, slowest: 800 },
  ease: {
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
    inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
    in: 'cubic-bezier(0.7, 0, 0.84, 0)',
  },
};

export function setReducedMotion(on) {
  motion.reduced = on;
  document.documentElement.classList.toggle('reduce-motion', on);
}

/** element.animate that collapses to the end state when motion is reduced. */
export function animate(el, keyframes, opts = {}) {
  if (!el || !el.animate) return null;
  if (motion.reduced) opts = { ...opts, duration: 1, delay: 0 };
  return el.animate(keyframes, { fill: 'both', ...opts });
}

/** Exponential approach: frame-rate independent smoothing. */
export const approach = (cur, target, dt, rate = 10) => cur + (target - cur) * (1 - Math.exp(-dt * rate));

/**
 * A critically damped spring (no overshoot) or an under-damped one (zeta < 1).
 * step(dt) returns the new value.
 */
export class Spring {
  constructor(value = 0, { stiffness = 170, damping = 26, mass = 1 } = {}) {
    this.x = value;
    this.v = 0;
    this.target = value;
    this.k = stiffness;
    this.c = damping;
    this.m = mass;
  }

  set(target) {
    this.target = target;
  }

  jump(value) {
    this.x = this.target = value;
    this.v = 0;
  }

  get settled() {
    return Math.abs(this.x - this.target) < 1e-3 && Math.abs(this.v) < 1e-3;
  }

  step(dt) {
    if (motion.reduced) {
      this.jump(this.target);
      return this.x;
    }
    // Sub-step for stability at low frame rates.
    let t = Math.min(dt, 0.064);
    while (t > 0) {
      const h = Math.min(t, 1 / 120);
      const a = (-this.k * (this.x - this.target) - this.c * this.v) / this.m;
      this.v += a * h;
      this.x += this.v * h;
      t -= h;
    }
    return this.x;
  }
}

/**
 * Number tweening: an element whose text counts towards a target value.
 * Registered tweens are advanced from the app's frame loop.
 */
export class Tweens {
  constructor() {
    this.set = new Set();
  }

  number(el, format, { rate = 7, from = 0 } = {}) {
    const t = {
      el, format, value: from, target: from, rate, shown: '',
      to(v) {
        if (!Number.isFinite(v)) v = 0;
        this.target = v;
      },
    };
    this.set.add(t);
    return t;
  }

  remove(t) {
    this.set.delete(t);
  }

  update(dt) {
    for (const t of this.set) {
      if (!t.el.isConnected) continue;
      if (motion.reduced || Math.abs(t.target - t.value) < Math.abs(t.target) * 1e-4 + 1e-6) t.value = t.target;
      else t.value = approach(t.value, t.target, dt, t.rate);
      const s = t.format(t.value);
      if (s !== t.shown) {
        t.shown = s;
        if (s.includes('<')) t.el.innerHTML = s;
        else t.el.textContent = s;
      }
    }
  }
}

/**
 * FLIP: call first() before a DOM change and play() after it; elements
 * matched by key glide from their old positions to the new ones.
 */
export function flipFirst(els, key) {
  const m = new Map();
  for (const el of els) m.set(key(el), el.getBoundingClientRect());
  return m;
}

export function flipPlay(els, key, first, opts = {}) {
  if (motion.reduced) return;
  for (const el of els) {
    const a = first.get(key(el));
    if (!a) {
      animate(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: motion.ease.out });
      continue;
    }
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    animate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: opts.duration || 420, easing: motion.ease.out });
  }
}

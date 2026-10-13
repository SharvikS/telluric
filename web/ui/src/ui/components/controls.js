import { h } from '../dom.js';
import { icon } from '../icons.js';

/**
 * Segmented control with a sliding thumb.
 * options: [{ value, label, icon? }]
 */
export function segmented(options, value, onChange, { tip } = {}) {
  const el = h('div.seg', { role: 'radiogroup' });
  const thumb = h('div.seg-thumb');
  el.appendChild(thumb);
  const btns = options.map((o) => {
    const b = h('button', { type: 'button', role: 'radio', dataset: { v: o.value }, 'data-tip': o.tip || null },
      o.icon ? h('span', { html: icon(o.icon) }) : null, o.label != null ? h('span', o.label) : null);
    b.addEventListener('click', () => {
      if (el.value === o.value) return;
      api.set(o.value);
      onChange(o.value);
    });
    el.appendChild(b);
    return b;
  });
  const place = () => {
    const b = btns.find((x) => x.dataset.v === String(el.value));
    if (!b || !b.offsetWidth) return;
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.transform = `translateX(${b.offsetLeft - 2}px)`;
  };
  const api = {
    el,
    set(v) {
      el.value = v;
      for (const b of btns) {
        const on = b.dataset.v === String(v);
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
      place();
    },
  };
  new ResizeObserver(place).observe(el);
  if (tip) el.dataset.tip = tip;
  api.set(value);
  return api;
}

/** Tabs with an animated ink bar. items: [{ value, label, count? }] */
export function tabs(items, value, onChange) {
  const el = h('div.tabs', { role: 'tablist' });
  const ink = h('div.tabs-ink');
  const btns = new Map();
  for (const it of items) {
    const count = h('span.count');
    const b = h('button.tab', { type: 'button', role: 'tab' }, it.label, it.count != null ? count : null);
    b._count = count;
    b.addEventListener('click', () => {
      api.set(it.value);
      onChange(it.value);
    });
    btns.set(it.value, b);
    el.appendChild(b);
  }
  el.appendChild(ink);
  const place = () => {
    const b = btns.get(el.value);
    if (!b || !b.offsetWidth) return;
    ink.style.width = `${b.offsetWidth - 16}px`;
    ink.style.transform = `translateX(${b.offsetLeft + 8}px)`;
  };
  const api = {
    el,
    set(v) {
      el.value = v;
      for (const [k, b] of btns) {
        b.classList.toggle('active', k === v);
        b.setAttribute('aria-selected', k === v ? 'true' : 'false');
      }
      place();
    },
    count(v, n) {
      const b = btns.get(v);
      if (b && b._count.textContent !== String(n)) b._count.textContent = String(n);
    },
  };
  new ResizeObserver(place).observe(el);
  api.set(value);
  return api;
}

/** Switch. */
export function toggle(on, onChange, label) {
  const sw = h(`button.switch${on ? '.on' : ''}`, { type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label || null });
  sw.addEventListener('click', () => {
    const v = !sw.classList.contains('on');
    sw.classList.toggle('on', v);
    sw.setAttribute('aria-checked', v ? 'true' : 'false');
    onChange(v);
  });
  return {
    el: sw,
    set(v) {
      sw.classList.toggle('on', v);
      sw.setAttribute('aria-checked', v ? 'true' : 'false');
    },
  };
}

export function kbd(keys) {
  return h('span.kbds', keys.split(' ').map((k) => h('kbd', k)));
}

export function emptyState(ill, title, body, action) {
  return h('div.empty', h('div.ill', { html: ill }), h('h4', title), h('p', { html: body }), action || null);
}

export function skeleton(lines = 4, widths = [70, 92, 54, 80]) {
  return h('div.col', { style: { gap: '10px', padding: '6px 0' } },
    Array.from({ length: lines }, (_, i) => h('div.skel', { style: { height: '12px', width: `${widths[i % widths.length]}%` } })));
}

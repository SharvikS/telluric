import { h } from '../dom.js';
import { icon } from '../icons.js';

let open = null;

export function closePopover() {
  if (!open) return;
  const p = open;
  open = null;
  p.el.classList.add('closing');
  p.anchor?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', p.outside, true);
  document.removeEventListener('keydown', p.key, true);
  setTimeout(() => p.el.remove(), 140);
  p.onClose?.();
}

export const popoverOpen = () => !!open;

/**
 * Opens `content` in a popover anchored to `anchor`. align: 'end' | 'start'.
 * Closes on outside click, Escape, or closePopover().
 */
export function openPopover(anchor, content, { align = 'end', width, onClose, className = '' } = {}) {
  const same = open && open.anchor === anchor;
  closePopover();
  if (same) return null;
  const el = h(`div.popover${className ? '.' + className : ''}`, { role: 'dialog' }, content);
  if (width) el.style.width = `${width}px`;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let x = align === 'end' ? r.right - w : r.left;
  x = Math.max(8, Math.min(innerWidth - w - 8, x));
  let y = r.bottom + 6;
  if (y + hgt > innerHeight - 8) y = Math.max(8, r.top - hgt - 6);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--origin', `${align === 'end' ? 'top right' : 'top left'}`);
  anchor.setAttribute('aria-expanded', 'true');
  const outside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const key = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
      anchor.focus?.();
    }
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  open = { el, anchor, outside, key, onClose };
  return el;
}

/**
 * A menu: items = [{ label, icon, end, onSelect, checked, header, sep, keep }].
 * Arrow keys move, Enter selects. `keep` keeps the menu open (checkbox lists).
 */
export function openMenu(anchor, items, opts = {}) {
  const list = h('div.menu', { role: 'menu' });
  const buttons = [];
  for (const it of items) {
    if (it.sep) { list.appendChild(h('div.menu-sep')); continue; }
    if (it.header) { list.appendChild(h('div.menu-label', it.header)); continue; }
    const check = it.checked != null ? h(`span.check-box${it.checked ? '.on' : ''}`, { html: icon('check') }) : null;
    const b = h('button.menu-item', { role: 'menuitem', type: 'button' },
      check, it.icon ? h('span', { html: icon(it.icon) }) : null, h('span.grow.ellipsis', it.label),
      it.end ? h('span.end', { html: it.end }) : null);
    b.addEventListener('click', () => {
      it.onSelect?.();
      if (it.keep) {
        if (check) check.classList.toggle('on');
      } else closePopover();
    });
    buttons.push(b);
    list.appendChild(b);
  }
  const el = openPopover(anchor, list, opts);
  if (!el) return null;
  let k = -1;
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      k = (k + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[k].focus();
    }
  });
  requestAnimationFrame(() => buttons[0]?.focus({ preventScroll: true }));
  return el;
}

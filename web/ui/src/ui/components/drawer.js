import { h, copyText } from '../dom.js';
import { icon } from '../icons.js';
import { tabs } from './controls.js';
import { describe } from '../entity.js';
import { animate, motion } from '../../app/motion.js';

/**
 * Right-side detail drawer for any entity (host, flow, process, alert,
 * trace). Spring slide-in, tabs, live refresh once a second, deep links.
 */
export class Drawer {
  constructor(app) {
    this.app = app;
    this.ref = null;
    this.tab = 'overview';
    this.avatar = h('div.drawer-avatar');
    this.titleEl = h('div.drawer-title');
    this.subEl = h('div.drawer-sub');
    this.badgesEl = h('div.drawer-badges');
    const linkBtn = h('button.icon-btn', { type: 'button', 'data-tip': 'Copy link', html: icon('link') });
    linkBtn.addEventListener('click', async () => {
      const ok = await copyText(location.href);
      app.toast({ kind: ok ? 'success' : 'warning', title: ok ? 'Link copied' : 'Could not copy link', duration: 2200 });
    });
    const closeBtn = h('button.icon-btn', { type: 'button', 'data-tip': 'Close', 'data-kbd': 'Esc', html: icon('x') });
    closeBtn.addEventListener('click', () => this.close());
    this.tabsWrap = h('div');
    this.body = h('div.drawer-body');
    this.actions = h('div.drawer-actions');
    this.el = h('aside.drawer', { role: 'dialog', 'aria-label': 'Details' },
      h('div.drawer-head', this.avatar, h('div.grow', this.titleEl, this.subEl, this.badgesEl), h('div.head-actions', linkBtn, closeBtn)),
      this.tabsWrap, this.body, this.actions);
    this.scrim = h('div.drawer-scrim');
    this.scrim.addEventListener('click', () => this.close());
    document.body.append(this.scrim, this.el);
    this.el.addEventListener('click', (e) => {
      const o = e.target.closest('[data-open]');
      if (o) {
        e.preventDefault();
        const [type, id] = o.dataset.open.split(':');
        app.openEntity({ type, id: Number(id) });
        return;
      }
      const c = e.target.closest('[data-copy]');
      if (c) {
        copyText(c.dataset.copy).then((ok) => app.toast({ kind: ok ? 'success' : 'warning', title: ok ? 'Copied' : 'Copy failed', desc: ok ? `<span class="mono">${c.dataset.copy}</span>` : '', duration: 2000 }));
      }
    });
    this.last = 0;
  }

  get isOpen() {
    return !!this.ref;
  }

  open(ref, { from } = {}) {
    const same = this.ref && this.ref.type === ref.type && this.ref.id === ref.id;
    this.ref = ref;
    if (!same) this.tab = 'overview';
    const d = describe(this.app, ref);
    this.render(d, true);
    const wasOpen = this.el.classList.contains('open');
    this.el.classList.add('open');
    this.scrim.classList.toggle('show', innerWidth < 900);
    if (from && !motion.reduced) this.morph(from, wasOpen);
    this.app.onDrawer(ref);
  }

  close() {
    if (!this.ref) return;
    this.ref = null;
    this.el.classList.remove('open');
    this.scrim.classList.remove('show');
    this.app.onDrawer(null);
  }

  /** Shared-element transition: a dot flies from the marker into the avatar. */
  morph(from, wasOpen) {
    const dot = h('div.morph');
    dot.style.background = from.color || 'var(--accent)';
    dot.style.left = `${from.x - 8}px`;
    dot.style.top = `${from.y - 8}px`;
    dot.style.width = dot.style.height = '16px';
    dot.style.boxShadow = `0 0 0 6px color-mix(in srgb, ${from.color || 'var(--accent)'} 25%, transparent)`;
    document.body.appendChild(dot);
    this.avatar.style.opacity = '0';
    requestAnimationFrame(() => {
      // The drawer may still be sliding in: target the avatar's final spot,
      // i.e. its offset inside the drawer from the drawer's resting place.
      const av = this.avatar.getBoundingClientRect();
      const d = this.el.getBoundingClientRect();
      const finalLeft = innerWidth - 8 - this.el.offsetWidth;
      const r = { left: finalLeft + (av.left - d.left), top: 8 + (av.top - d.top), width: av.width, height: av.height };
      const settle = wasOpen ? 0 : 180;
      // The dot scales about its centre, so travel centre to centre.
      const tx = r.left + r.width / 2 - from.x, ty = r.top + r.height / 2 - from.y;
      const s = r.width / 16;
      const a = animate(dot, [
        { transform: 'translate(0,0) scale(1)', borderRadius: '50%', opacity: 1 },
        { transform: `translate(${tx * 0.55}px, ${ty * 0.45 - 40}px) scale(${1 + (s - 1) * 0.5})`, borderRadius: '40%', opacity: 1, offset: 0.55 },
        { transform: `translate(${tx}px, ${ty}px) scale(${s})`, borderRadius: `${11 / s}px`, opacity: 1 },
      ], { duration: 560 + settle, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      const done = () => {
        this.avatar.style.opacity = '';
        animate(dot, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 }).finished.then(() => dot.remove());
      };
      if (a) a.finished.then(done).catch(done);
      else done();
    });
  }

  render(d, fresh) {
    if (!d) {
      this.titleEl.textContent = 'No longer active';
      this.subEl.textContent = 'This entity expired from the engine’s live view.';
      this.badgesEl.innerHTML = '';
      this.body.innerHTML = '<div class="drawer-gone">It may reappear if the traffic resumes.</div>';
      this.actions.innerHTML = '';
      return;
    }
    if (this.titleEl.textContent !== d.title) this.titleEl.textContent = d.title;
    if (this.subEl.textContent !== d.sub) this.subEl.textContent = d.sub;
    if (this.badgesEl._h !== d.badges) {
      this.badgesEl._h = d.badges;
      this.badgesEl.innerHTML = d.badges;
    }
    const av = `${d.avatar.icon}|${d.avatar.color}`;
    if (this.avatar._k !== av) {
      this.avatar._k = av;
      this.avatar.innerHTML = icon(d.avatar.icon);
      this.avatar.style.background = d.avatar.color;
    }
    const tabKey = d.tabs.map((t) => t.value).join(',');
    if (fresh || this.tabsKey !== tabKey) {
      this.tabsKey = tabKey;
      if (!d.tabs.some((t) => t.value === this.tab)) this.tab = d.tabs[0].value;
      this.tabCtl = tabs(d.tabs.map((t) => ({ value: t.value, label: t.label, count: t.count })), this.tab, (v) => {
        this.tab = v;
        this.renderBody(describe(this.app, this.ref), true);
      });
      this.tabsWrap.replaceChildren(this.tabCtl.el);
    }
    for (const t of d.tabs) if (t.count != null) this.tabCtl.count(t.value, t.count);
    this.renderBody(d, fresh);
    const actKey = d.actions.map((a) => a.label).join('|');
    if (fresh || this.actKey !== actKey) {
      this.actKey = actKey;
      this.actions.replaceChildren(...d.actions.map((a) => {
        const b = h(`button.btn.sm${a.kind === 'primary' ? '.primary' : ''}`, { type: 'button', html: `${icon(a.icon)}<span>${a.label}</span>` });
        b.addEventListener('click', () => a.onClick());
        return b;
      }));
      this.actions.classList.toggle('hidden', !d.actions.length);
    }
  }

  renderBody(d, animateIn) {
    if (!d) return;
    const tab = d.tabs.find((t) => t.value === this.tab) || d.tabs[0];
    const out = tab.render();
    const scroll = this.body.scrollTop;
    if (typeof out === 'string') {
      if (!animateIn && this.body._s === out) return;
      this.body._s = out;
      this.body.innerHTML = out;
    } else {
      this.body._s = null;
      this.body.replaceChildren(out);
    }
    if (animateIn) {
      this.body.scrollTop = 0;
      this.body.classList.add('anim');
      clearTimeout(this.animT);
      this.animT = setTimeout(() => this.body.classList.remove('anim'), 700);
    } else {
      this.body.scrollTop = scroll;
    }
  }

  update(now) {
    if (!this.ref || now - this.last < 1000) return;
    this.last = now;
    this.render(describe(this.app, this.ref), false);
  }
}

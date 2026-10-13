import { rate, count, clockUTC, clockLocal } from '../util/format.js';
import { sparkline } from './charts.js';
import { DEFCON_COLORS } from '../config.js';

const MODE_LABEL = { live: 'LIVE', demo: 'DEMO', replay: 'REPLAY', connecting: 'LINKING', reconnecting: 'RELINKING', offline: 'OFFLINE' };

export class TopBar {
  constructor(store) {
    this.store = store;
    const $ = (id) => document.getElementById(id);
    this.el = {
      mode: $('mode'), rx: $('m-rx'), tx: $('m-tx'), pps: $('m-pps'), flows: $('m-flows'), eps: $('m-eps'),
      cc: $('m-cc'), drops: $('m-drops'), dropsBox: $('drops'), srx: $('s-rx'), stx: $('s-tx'),
      defcon: $('defcon'), defconN: $('defcon-n'), utc: $('clock-utc'), local: $('clock-local'),
    };
    this.cells = [...this.el.defcon.querySelectorAll('.cells i')];
    this.lastDefcon = 0;
    this.lastClock = 0;
  }

  setMode(state, detail) {
    const m = this.el.mode;
    m.className = `badge ${state}`;
    m.textContent = MODE_LABEL[state] || state.toUpperCase();
    m.title = detail || '';
  }

  update(now) {
    const s = this.store.stats;
    if (now - this.lastClock > 250) {
      this.lastClock = now;
      const d = new Date(this.store.now());
      this.el.utc.textContent = clockUTC(d);
      this.el.local.textContent = clockLocal(d);
    }
    if (!s) return;
    this.el.rx.textContent = rate(s.rx);
    this.el.tx.textContent = rate(s.tx);
    this.el.pps.textContent = count(s.pps);
    this.el.flows.textContent = count(s.flows);
    this.el.eps.textContent = count(s.eps);
    this.el.cc.textContent = count(s.countries);
    this.el.drops.textContent = count(s.drops || 0);
    this.el.dropsBox.classList.toggle('warn', (s.drops || 0) > 0);
    const hist = this.store.fastHistory;
    sparkline(this.el.srx, hist.map((x) => x.rx), [0.37, 0.95, 1.0]);
    sparkline(this.el.stx, hist.map((x) => x.tx), [1.0, 0.45, 0.88]);
    const lvl = Math.min(5, Math.max(1, s.defcon || 5));
    if (lvl !== this.lastDefcon) {
      this.lastDefcon = lvl;
      const col = DEFCON_COLORS[lvl];
      this.el.defconN.textContent = lvl;
      this.el.defconN.style.color = col;
      // Cells fill from the right as the threat rises: DEFCON 5 lights one, 1 lights all.
      this.cells.forEach((c, i) => {
        const on = i >= lvl - 1;
        c.style.background = on ? col : 'transparent';
        c.style.borderColor = on ? col : '';
        c.style.boxShadow = on ? `0 0 8px ${col}` : 'none';
      });
      this.el.defcon.classList.toggle('critical', lvl <= 2);
    }
  }
}

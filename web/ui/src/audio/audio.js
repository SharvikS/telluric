// Synthesised sound, muted by default. Nothing is loaded: every sound is an
// oscillator with an envelope. Blips are rate-limited so a download storm
// doesn't turn into noise.

const PITCH = { tls: 880, quic: 988, http: 660, dns: 1318, doh: 1318, ssh: 740, stun: 1046, bittorrent: 587, unknown: 523 };

export class Audio {
  constructor() {
    this.enabled = false;
    this.ctx = null;
    this.master = null;
    this.window = [];
  }

  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.toggle();
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.ensure();
      this.ctx?.resume();
      this.blip('dns');
    }
    return this.enabled;
  }

  allow() {
    const now = performance.now();
    while (this.window.length && now - this.window[0] > 1000) this.window.shift();
    if (this.window.length >= 8) return false;
    this.window.push(now);
    return true;
  }

  blip(app) {
    if (!this.enabled || !this.ctx || !this.allow()) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(PITCH[app] || PITCH.unknown, t);
    o.frequency.exponentialRampToValueAtTime((PITCH[app] || PITCH.unknown) * 1.5, t + 0.06);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.14);
  }

  alarm(sev) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const crit = sev === 'critical';
    for (let i = 0; i < (crit ? 3 : 2); i++) {
      const o = this.ctx.createOscillator();
      const f = this.ctx.createBiquadFilter();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      const t0 = t + i * 0.32;
      o.frequency.setValueAtTime(crit ? 220 : 196, t0);
      o.frequency.linearRampToValueAtTime(crit ? 440 : 294, t0 + 0.24);
      f.type = 'lowpass';
      f.frequency.setValueAtTime(900, t0);
      f.frequency.linearRampToValueAtTime(2400, t0 + 0.24);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
      o.connect(f).connect(g).connect(this.master);
      o.start(t0);
      o.stop(t0 + 0.3);
    }
  }
}

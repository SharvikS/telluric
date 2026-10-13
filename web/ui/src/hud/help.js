import { APP_COLORS, cssColor } from '../config.js';

const KEYS = [
  ['drag · wheel', 'rotate · zoom the globe'],
  ['click', 'inspect a host (or a country)'],
  ['/ · Ctrl+K', 'search hosts, processes, countries, alerts'],
  ['Space', 'toggle auto-rotation'],
  ['C', 'cinematic mode: the camera tours live connections'],
  ['H', 'hide / show the HUD'],
  ['R', 'CRT scanline mode'],
  ['M', 'sound on / off'],
  ['F', 'fullscreen'],
  ['Esc', 'close panels, clear filters'],
  ['?', 'this help'],
];

export class Help {
  constructor() {
    this.el = document.getElementById('help');
    this.back = document.getElementById('modal-back');
    const legend = [['tls', 'TLS'], ['quic', 'QUIC / HTTP3'], ['http', 'cleartext HTTP'], ['dns', 'DNS'], ['ssh', 'SSH'], ['stun', 'WebRTC'], ['bittorrent', 'P2P']]
      .map(([k, l]) => `<span><i style="background:${cssColor(APP_COLORS[k])};color:${cssColor(APP_COLORS[k])}"></i>${l}</span>`).join('') +
      '<span><i style="background:#ff2a44;color:#ff2a44"></i>threat</span>';
    this.el.innerHTML = `<h2>TELLURIC</h2>
      <p>Every arc is a host your machine talks to, drawn to where it really is. Comets are packets: towards home is download, away is upload. Labels are DNS lookups as they happen. Hosts on your LAN orbit low above home; addresses that can't be located orbit higher.</p>
      <div class="keys">${KEYS.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div>
      <div class="legend2">${legend}</div>`;
    this.back.addEventListener('click', () => this.close());
  }

  get isOpen() { return this.el.classList.contains('open'); }
  toggle() { this.isOpen ? this.close() : this.open(); }
  open() { this.el.classList.add('open'); this.back.classList.add('open'); }
  close() { this.el.classList.remove('open'); if (!document.getElementById('search').classList.contains('open')) this.back.classList.remove('open'); }
}

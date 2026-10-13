// A small, consistent icon set drawn for Telluric: 24 px grid, 1.8 px
// rounded strokes, currentColor. Returned as SVG markup strings.

const P = {
  overview: '<rect x="3.5" y="3.5" width="7" height="8" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.6"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.6"/><rect x="3.5" y="14.5" width="7" height="6" rx="1.6"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5s1.3-6.1 3.9-8.5z"/>',
  connections: '<path d="M4 8h13"/><path d="M14 4.5 17.5 8 14 11.5"/><path d="M20 16H7"/><path d="M10 12.5 6.5 16l3.5 3.5"/>',
  hosts: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2.2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>',
  dns: '<path d="M4 6.5h16M4 12h10M4 17.5h7"/><circle cx="17.5" cy="16" r="3"/><path d="m19.7 18.2 1.8 1.8"/>',
  shield: '<path d="M12 3.2 19.5 6v5.6c0 4.6-3 7.8-7.5 9.2-4.5-1.4-7.5-4.6-7.5-9.2V6z"/>',
  'shield-check': '<path d="M12 3.2 19.5 6v5.6c0 4.6-3 7.8-7.5 9.2-4.5-1.4-7.5-4.6-7.5-9.2V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  'shield-alert': '<path d="M12 3.2 19.5 6v5.6c0 4.6-3 7.8-7.5 9.2-4.5-1.4-7.5-4.6-7.5-9.2V6z"/><path d="M12 8.5v4M12 15.8h.01"/>',
  route: '<circle cx="6" cy="18.5" r="2.2"/><circle cx="18" cy="5.5" r="2.2"/><path d="M8.2 18.5h7.3a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7h7.3"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h4M12 17h8"/><circle cx="15" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.3 6.3 0 0 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6.2 2.5 8 2.5 8h-17S6 15.2 6 9z"/><path d="M10.2 20.5a2 2 0 0 0 3.6 0"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7"/><path d="M12 17.2h.01"/>',
  play: '<path d="M7.5 5.5v13l11-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  'chevron-up': '<path d="m6 14.5 6-6 6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>',
  'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
  'arrow-up-right': '<path d="M7 17 17 7M8.5 7H17v8.5"/>',
  'arrow-down-left': '<path d="M17 7 7 17M15.5 17H7V8.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  filter: '<path d="M4 5.5h16l-6.2 7.2v5.8l-3.6 1.6v-7.4z"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.2 4.5v15M14.8 4.5v15"/>',
  download: '<path d="M12 3.5v11.5M7 10.5l5 5 5-5M4.5 20h15"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>',
  alert: '<path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18.5 14.5v4a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 6 5.5h4"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  'eye-off': '<path d="M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-3.2 3.9M6.4 6.5C3.9 8.2 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/><path d="M9.9 9.9a2.8 2.8 0 0 0 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6"/><path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5"/><path d="M20 3.5v5h-5"/>',
  layers: '<path d="M12 3.5 21 8.5l-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  zap: '<path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.2 10.5V7.4a3.8 3.8 0 0 1 7.6 0v3.1"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.2 10.5V7.4a3.8 3.8 0 0 1 7.3-1.5"/>',
  flag: '<path d="M5 21V4M5 4.5h11.5l-2 4 2 4H5"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M7.5 14.5h9"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  'volume-off': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.2"/><path d="M9.5 4v16"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M16 8a5.7 5.7 0 0 1 0 8M8 16a5.7 5.7 0 0 1 0-8M18.8 5.2a9.6 9.6 0 0 1 0 13.6M5.2 18.8a9.6 9.6 0 0 1 0-13.6"/>',
  more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  sparkles: '<path d="M12 3.5 13.7 8.3 18.5 10 13.7 11.7 12 16.5 10.3 11.7 5.5 10 10.3 8.3z"/><path d="M18.5 15.5 19.3 17.7 21.5 18.5 19.3 19.3 18.5 21.5 17.7 19.3 15.5 18.5 17.7 17.7z"/>',
  database: '<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  activity: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.6.4l2.6-2.6a4.6 4.6 0 0 0-6.5-6.5l-1.4 1.4"/><path d="M14 10.5a4.5 4.5 0 0 0-6.6-.4l-2.6 2.6a4.6 4.6 0 0 0 6.5 6.5l1.4-1.4"/>',
  mute: '<path d="M6 9a6 6 0 0 1 9.4-4.9M18 9c0 6.2 2.5 8 2.5 8H8M3 3l18 18"/><path d="M10.2 20.5a2 2 0 0 0 3.6 0"/>',
  undo: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H15a5 5 0 0 1 0 10h-3"/>',
  inbox: '<path d="M3.5 13.5 6 5.5h12l2.5 8V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>',
  'map-pin': '<path d="M12 21s-6.5-5.4-6.5-11a6.5 6.5 0 0 1 13 0c0 5.6-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  maximize: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a4.8 4.8 0 0 1 6.4 0"/><path d="M12 19.5h.01"/>',
  hash: '<path d="M5 9h15M4 15h15M10 3.5 8 20.5M16 3.5l-2 17"/>',
};

export function icon(name, cls = '') {
  const body = P[name] || P.info;
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** The Telluric mark: a planet, an orbit and a satellite. */
export const MARK = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <circle class="orbit" cx="32" cy="32" r="24" stroke="currentColor" stroke-width="3" stroke-linecap="round" transform="rotate(-90 32 32)" opacity=".35"/>
  <circle class="core" cx="32" cy="32" r="12" fill="currentColor"/>
  <path class="arc" d="M14 40 C 22 18, 42 14, 52 24" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>
  <circle class="sat" cx="52" cy="24" r="4.2" fill="currentColor"/>
</svg>`;

export const MARK_SMALL = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <circle cx="32" cy="32" r="24" stroke="currentColor" stroke-width="4" opacity=".35"/>
  <circle cx="32" cy="32" r="12" fill="currentColor"/>
  <path d="M14 40 C 22 18, 42 14, 52 24" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
  <circle cx="52" cy="24" r="5" fill="currentColor"/>
</svg>`;

/** Line illustrations for empty states. */
export const ILLUSTRATIONS = {
  globe: `<svg viewBox="0 0 132 96" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="66" cy="48" r="30"/><path d="M36 48h60M66 18c9 8 13 18 13 30s-4 22-13 30c-9-8-13-18-13-30s4-22 13-30z" opacity=".6"/><path d="M18 62c16 12 76 12 96-14" stroke-dasharray="3 5" opacity=".7"/><circle cx="114" cy="48" r="3.5" fill="currentColor"/></svg>`,
  shield: `<svg viewBox="0 0 132 96" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M66 14 92 24v20c0 17-11 28-26 33-15-5-26-16-26-33V24z"/><path d="m55 46 8 8 15-16"/><path d="M22 70h14M100 30h12M24 30h8M104 70h8" opacity=".5"/></svg>`,
  route: `<svg viewBox="0 0 132 96" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="28" cy="70" r="6"/><circle cx="104" cy="26" r="6"/><path d="M34 70h40a14 14 0 0 0 0-28H58a14 14 0 0 1 0-28h40" stroke-dasharray="4 5"/><circle cx="66" cy="42" r="3" fill="currentColor"/></svg>`,
  table: `<svg viewBox="0 0 132 96" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="26" y="18" width="80" height="60" rx="8"/><path d="M26 34h80M26 50h80M26 64h80M52 18v60" opacity=".6"/><circle cx="96" cy="70" r="12" fill="var(--surface)"/><path d="m104 78 6 6"/></svg>`,
  inbox: `<svg viewBox="0 0 132 96" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m30 54 10-30h52l10 30v16a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6z"/><path d="M30 54h18l5 8h26l5-8h18" opacity=".7"/></svg>`,
};

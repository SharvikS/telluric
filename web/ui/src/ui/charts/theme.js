// Chart colours come from CSS custom properties, so charts follow the theme.
let cache = null;

export function refreshChartTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  cache = {
    text: v('--text'), text2: v('--text-2'), text3: v('--text-3'), text4: v('--text-4'),
    grid: v('--grid-line'), border: v('--border'), border2: v('--border-2'), surface: v('--surface'),
    accent: v('--accent'), danger: v('--danger'), warning: v('--warning'), orange: v('--orange'),
    info: v('--info'), success: v('--success'),
    font: '500 11px Inter, ui-sans-serif, system-ui, sans-serif',
    color: (name) => (name.startsWith('--') ? v(name) : name),
  };
  return cache;
}

export const chartTheme = () => cache || refreshChartTheme();

/** "#rrggbb" or "rgb(...)" → rgba() string with alpha. */
export function alpha(color, a) {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1, 7), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = color.match(/[\d.]+/g);
  return m ? `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${a})` : color;
}

/** Shared floating tooltip for all charts. */
let tipEl = null;
export function dataTip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'data-tip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

export function showTip(x, y, html) {
  const t = dataTip();
  if (!html) {
    t.classList.remove('show');
    return;
  }
  if (t._html !== html) {
    t._html = html;
    t.innerHTML = html;
  }
  t.classList.add('show');
  const w = t.offsetWidth, hgt = t.offsetHeight;
  const tx = x + 16 + w > innerWidth - 8 ? x - w - 16 : x + 16;
  const ty = Math.min(innerHeight - hgt - 8, Math.max(8, y - hgt / 2));
  t.style.transform = `translate(${tx}px, ${ty}px)`;
}

/** Canvas that tracks its container size at device resolution. */
export function fitCanvas(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cv.clientWidth * dpr));
  const h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  return [w, h, dpr];
}

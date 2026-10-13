// Sparklines: tiny SVG line + area, scaled to their viewBox.

/** `slots` > values.length right-aligns a series that has not filled its
 *  window yet, so missing history reads as "no data" rather than as zero. */
export function sparkPaths(values, w, h, pad = 1.5, floor = 0, slots = values.length) {
  const n = values.length;
  if (n < 2) return ['', ''];
  let max = floor;
  for (const v of values) if (v > max) max = v;
  if (max <= 0) max = 1;
  const span = Math.max(n, slots) - 1;
  const off = span - (n - 1);
  const X = (i) => ((off + i) / span) * w;
  const Y = (v) => h - pad - (v / max) * (h - pad * 2);
  let line = '';
  for (let i = 0; i < n; i++) line += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(values[i]).toFixed(1)}`;
  const area = `${line}L${w} ${h}L${X(0).toFixed(1)} ${h}Z`;
  return [line, area];
}

/** Creates (or updates) an inline sparkline inside `el`. */
export function spark(el, values, color = 'var(--accent)', { w = 96, h = 32, fill = true, floor = 0, slots } = {}) {
  let svg = el._spark;
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';
    const gid = `sg${Math.random().toString(36).slice(2, 8)}`;
    svg.innerHTML = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
      <path class="a" fill="url(#${gid})"/><path class="l" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
    el.appendChild(svg);
    el._spark = svg;
  }
  svg.style.color = color;
  const [line, area] = sparkPaths(values, w, h, 1.5, floor, slots || values.slots || values.length);
  svg.querySelector('.l').setAttribute('d', line);
  const a = svg.querySelector('.a');
  if (fill) a.setAttribute('d', area);
  else a.setAttribute('d', '');
}

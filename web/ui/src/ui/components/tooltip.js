// Delegated tooltips: any element with data-tip (and optional data-kbd)
// gets a small tooltip after a short delay. One listener for the whole app.
let tip = null;
let timer = 0;
let current = null;

function show(el) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    document.body.appendChild(tip);
  }
  const kbd = el.dataset.kbd ? el.dataset.kbd.split(' ').map((k) => `<kbd>${k}</kbd>`).join('') : '';
  tip.innerHTML = `${el.dataset.tip}${kbd}`;
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const below = r.bottom + h + 10 < innerHeight;
  let x = r.left + r.width / 2 - w / 2;
  x = Math.max(8, Math.min(innerWidth - w - 8, x));
  const y = below ? r.bottom + 7 : r.top - h - 7;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.classList.add('show');
}

export function hideTip() {
  clearTimeout(timer);
  current = null;
  tip?.classList.remove('show');
}

export function installTooltips() {
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el === current) return;
    hideTip();
    if (!el) return;
    current = el;
    timer = setTimeout(() => current === el && el.isConnected && show(el), tip?.classList.contains('show') ? 0 : 420);
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('scroll', hideTip, true);
}

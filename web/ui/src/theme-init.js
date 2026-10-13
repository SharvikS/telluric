// Resolve the theme before first paint (no flash of the wrong theme).
// A classic script (not a module) so it runs synchronously in <head>; kept
// external because the engine's CSP forbids inline scripts.
(function () {
  var t = 'system';
  try {
    t = JSON.parse(localStorage.getItem('telluric.prefs.v2') || '{}').theme || 'system';
  } catch (e) {
    /* storage unavailable */
  }
  var q = new URLSearchParams(location.search).get('theme');
  if (q === 'dark' || q === 'light') t = q;
  if (t === 'system') t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
})();

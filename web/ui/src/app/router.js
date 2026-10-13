import { Emitter } from '../util/emitter.js';

/**
 * Hash router (works on static hosts such as GitHub Pages):
 *   #/hosts            → { name: 'hosts', params: {} }
 *   #/hosts?sel=ep:12  → { name: 'hosts', params: { sel: 'ep:12' } }
 */
export class Router extends Emitter {
  constructor(names, fallback) {
    super();
    this.names = new Set(names);
    this.fallback = fallback;
    this.current = this.parse();
    window.addEventListener('hashchange', () => {
      const r = this.parse();
      const prev = this.current;
      this.current = r;
      this.emit('route', r, prev);
    });
  }

  parse() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query = ''] = raw.split('?');
    const name = this.names.has(path) ? path : this.fallback;
    const params = Object.fromEntries(new URLSearchParams(query));
    return { name, params };
  }

  go(name, params = {}) {
    const q = new URLSearchParams(params).toString();
    const hash = `#/${name}${q ? `?${q}` : ''}`;
    if (location.hash === hash) return;
    location.hash = hash;
  }

  /** Update the query without a navigation (e.g. selection), no history spam. */
  replaceParams(params) {
    const q = new URLSearchParams(params).toString();
    const hash = `#/${this.current.name}${q ? `?${q}` : ''}`;
    history.replaceState(null, '', location.pathname + location.search + hash);
    this.current = { name: this.current.name, params };
  }
}

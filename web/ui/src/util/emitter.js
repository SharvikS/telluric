// A tiny synchronous event emitter.
export class Emitter {
  constructor() {
    this.handlers = new Map();
  }

  on(type, fn) {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(type, ...args) {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`handler for "${type}" failed:`, e);
      }
    }
  }
}

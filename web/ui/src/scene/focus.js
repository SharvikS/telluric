// Globe highlighting. With `active` set, everything that does not match is
// dimmed (a process's hosts, a country, an explicit set of hosts); `ep` on its
// own just marks the selection; `trace` quiets labels while a route is shown.

export function focusMatch(f, id, ep) {
  return !!((f.ep && f.ep === id) || (f.cc && ep.cc === f.cc) || (f.procEps && f.procEps.has(id)) || (f.eps && f.eps.has(id)));
}

export function clearFocus(f) {
  Object.assign(f, { active: false, ep: 0, proc: 0, cc: null, procEps: null, eps: null, trace: 0 });
}

// Collects the engine's stream during the live end-to-end test and checks
// what it saw. Exits non-zero on any failed expectation.
const [port, token] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
ws.binaryType = 'arraybuffer';
const flows = new Map(), eps = new Map(), procs = new Map();
const dns = [];
let hello, shots = 0;
ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') { shots += new DataView(ev.data).getUint16(2, true); return; }
  const m = JSON.parse(ev.data);
  if (m.t === 'hello') hello = m;
  if (m.t === 'snapshot') { m.flows.forEach(f => flows.set(f.id, f)); m.endpoints.forEach(e => eps.set(e.id, e)); m.procs.forEach(p => procs.set(p.id, p)); dns.push(...m.dns); }
  if (m.t === 'flow') m.items.forEach(f => flows.set(f.id, f));
  if (m.t === 'ep') m.items.forEach(e => eps.set(e.id, e));
  if (m.t === 'proc') m.items.forEach(p => procs.set(p.id, p));
  if (m.t === 'dns') dns.push(...m.items);
};
ws.onerror = () => { console.log('FAIL cannot connect'); process.exit(1); };

setTimeout(() => {
  let failed = 0;
  const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  — ' + detail : ''}`); if (!ok) failed++; };
  const proc = (f) => procs.get(f?.proc)?.name;
  const all = [...flows.values()];
  const http = all.find(f => f.proto === 'tcp' && f.rport === 8080);
  const bulk = all.find(f => f.proto === 'tcp' && f.rport === 8081);
  const tls = all.find(f => f.proto === 'tcp' && f.rport === 8443);
  const quic = all.find(f => f.proto === 'udp' && f.rport === 8443);
  const peer = [...eps.values()].find(e => e.ip === '10.99.0.2');

  check(hello?.mode === 'live', 'engine runs in live mode', hello?.mode);
  check(peer?.scope === 'lan', 'peer is a LAN endpoint', JSON.stringify({ ip: peer?.ip, scope: peer?.scope, name: peer?.name }));
  check(http?.app === 'http' && http?.state !== 'syn', 'HTTP flow classified', JSON.stringify({ app: http?.app, state: http?.state }));
  check(http?.rtt > 0, 'TCP handshake RTT measured', `${http?.rtt} ms`);
  check(proc(bulk) === 'curl', 'download attributed to curl', JSON.stringify({ proc: proc(bulk), bytesIn: bulk?.bytesIn }));
  check(bulk?.bytesIn >= 4000000, 'download fully counted, GRO super-packets included', String(bulk?.bytesIn));
  check(tls?.sni === 'secure.telluric.test' && tls?.tlsv === '1.3', 'TLS ClientHello: SNI + version', JSON.stringify({ sni: tls?.sni, tlsv: tls?.tlsv, alpn: tls?.alpn }));
  check(/^t13d\d{4}[a-z0-9]{2}_[0-9a-f]{12}_[0-9a-f]{12}$/.test(tls?.ja4 || ''), 'JA4 of a real OpenSSL client', tls?.ja4);
  check(tls?.pq === true, 'OpenSSL offered a post-quantum key share (X25519MLKEM768)', String(tls?.pq));
  if (process.env.NO_HTTP3) console.log('skip HTTP/3 check: this curl has no HTTP/3');
  else check(quic?.app === 'quic' && quic?.sni === 'quic.telluric.test', 'HTTP/3: SNI decrypted from a real ngtcp2 QUIC Initial', JSON.stringify({ app: quic?.app, sni: quic?.sni, ja4: quic?.ja4 }));
  const demo = dns.find(d => d.q === 'demo.telluric.test' && d.qtype === 'A');
  check(demo?.answers?.includes('10.99.0.2') && demo?.ms > 0, 'DNS answer observed with latency', JSON.stringify({ q: demo?.q, answers: demo?.answers, ms: demo?.ms }));
  // One-shot clients against a peer 10 µs away finish in a few milliseconds;
  // /proc polling may or may not see them in time. Reported, not asserted.
  for (const [what, id] of [['HTTP one-shot', http?.proc], ['TLS one-shot', tls?.proc], ['QUIC one-shot', quic?.proc], ['DNS lookup', demo?.proc]]) {
    console.log(`info ${what} attributed to: ${procs.get(id)?.name || '— (exited before attribution)'}`);
  }
  check(dns.filter(d => d.rcode === 'NXDOMAIN').length >= 10, 'NXDOMAIN answers observed', String(dns.filter(d => d.rcode === 'NXDOMAIN').length));
  check(shots > 0, 'packet shots streamed', String(shots));
  console.log(failed ? `\n${failed} check(s) failed` : '\nall live checks passed');
  process.exit(failed ? 1 : 0);
}, 12000);

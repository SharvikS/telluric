#!/usr/bin/env bash
# Live-capture end-to-end test, no root required.
#
# Builds a little world inside an unprivileged user namespace: two network
# namespaces joined by a veth pair. "Us" (10.99.0.1) runs Telluric in live
# mode, capturing on its veth through the real TPACKET_V3 ring. "Them"
# (10.99.0.2) runs a DNS server, HTTP servers and a TLS server. Real
# clients — glibc's resolver, curl over HTTP/1.1, TLS 1.3 with OpenSSL's
# post-quantum key share, and HTTP/3 via ngtcp2 — generate traffic made by
# the kernel, and a WebSocket client checks what the engine reported.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export ROOT WORK

for tool in unshare nsenter ip openssl curl python3 node getent; do
  command -v "$tool" >/dev/null || { echo "skip: $tool not installed"; exit 0; }
done
unshare -Urn true 2>/dev/null || { echo "skip: unprivileged user namespaces unavailable"; exit 0; }
curl --version | grep -q HTTP3 || export NO_HTTP3=1
make -C "$ROOT" -s engine

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -days 1 -nodes \
  -subj /CN=secure.telluric.test -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
printf 'nameserver 10.99.0.2\noptions attempts:1 timeout:1\n' >"$WORK/resolv.conf"
printf 'hosts: files dns\n' >"$WORK/nsswitch.conf"
head -c 4000000 /dev/zero >"$WORK/blob"
cat >"$WORK/dns.py" <<'PY'
# A tiny authoritative DNS server: every name is 10.99.0.2, except
# *.nx.test, which does not exist.
import socket, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("10.99.0.2", 53))
while True:
    q, addr = s.recvfrom(1500)
    if len(q) < 17:
        continue
    qid = struct.unpack("!H", q[:2])[0]
    i, labels = 12, []
    while q[i]:
        labels.append(q[i + 1:i + 1 + q[i]].decode())
        i += 1 + q[i]
    name, qtype = ".".join(labels), struct.unpack("!H", q[i + 1:i + 3])[0]
    question = q[12:i + 5]
    if name.endswith("nx.test"):
        r = struct.pack("!6H", qid, 0x8183, 1, 0, 0, 0) + question
    elif qtype == 1:
        r = (struct.pack("!6H", qid, 0x8180, 1, 1, 0, 0) + question +
             struct.pack("!HHHLH", 0xC00C, 1, 1, 60, 4) + socket.inet_aton("10.99.0.2"))
    else:
        r = struct.pack("!6H", qid, 0x8180, 1, 0, 0, 0) + question
    s.sendto(r, addr)
PY

unshare -Urnm --fork bash -euo pipefail -c '
  pids=()
  cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
  trap cleanup EXIT
  bg() { "$@" >>"$WORK/services.log" 2>&1 & pids+=($!); }

  mount --bind "$WORK/resolv.conf" /etc/resolv.conf
  mount --bind "$WORK/nsswitch.conf" /etc/nsswitch.conf
  ip link set lo up
  bg unshare -n sleep 600
  PEER=${pids[-1]}
  sleep 0.2
  ip link add veth0 type veth peer name veth1
  ip link set veth1 netns "$PEER"
  ip addr add 10.99.0.1/24 dev veth0 && ip link set veth0 up
  them() { nsenter -t "$PEER" -n "$@"; }
  them ip addr add 10.99.0.2/24 dev veth1
  them ip link set veth1 up
  them ip link set lo up
  bg nsenter -t "$PEER" -n python3 "$WORK/dns.py"
  bg nsenter -t "$PEER" -n python3 -m http.server 8080 --bind 10.99.0.2
  bg nsenter -t "$PEER" -n python3 -m http.server 8081 --bind 10.99.0.2 --directory "$WORK"
  bg nsenter -t "$PEER" -n openssl s_server -accept 10.99.0.2:8443 -cert "$WORK/cert.pem" -key "$WORK/key.pem" -www -quiet

  "$ROOT/bin/telluric" --capture ring -i veth0 --no-update --no-stun --home 50.11,8.68 \
      --listen 127.0.0.1:7900 --data-dir "$WORK/data" >"$WORK/telluric.log" 2>&1 &
  pids+=($!)
  sleep 1.5
  TOKEN=$(grep -o "token=[0-9a-f]*" "$WORK/telluric.log" | head -1 | cut -d= -f2)
  node "$ROOT/scripts/live-e2e-probe.mjs" 7900 "$TOKEN" >"$WORK/probe.out" 2>&1 &
  PROBE=$!
  sleep 0.5

  # A download that outlives attribution, then quick one-shots.
  curl -s --max-time 5 --limit-rate 2M -o /dev/null http://bulk.telluric.test:8081/blob || true
  curl -s --max-time 3 -o /dev/null http://demo.telluric.test:8080/ || true
  curl -sk --max-time 3 -o /dev/null https://secure.telluric.test:8443/ || true
  curl -sk --http3-only --max-time 2 -o /dev/null https://quic.telluric.test:8443/ || true
  for i in $(seq 1 12); do getent hosts "x$RANDOM$RANDOM.nx.test" >/dev/null || true; done

  status=0
  wait "$PROBE" || status=$?
  cat "$WORK/probe.out"
  exit "$status"
'

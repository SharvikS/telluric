# Renderer and UI

The browser side of Telluric is a raw WebGL2 renderer plus a DOM HUD,
written as native ES modules with no 3D library, no UI framework, no bundler
and no build step. Everything it needs, fonts included, ships inside the Go
binary (`web/ui`, embedded with `//go:embed`), and it makes no requests to
third parties. The same files run as a static site (GitHub Pages) with a
built-in demo engine.

```
web/ui/
  index.html              HUD skeleton
  styles/main.css         panels, labels, banner, modals, responsive rules
  assets/                 baked map textures (tools/geogen), fonts, favicon
  src/
    main.js               app controller: actions, input, frame loop
    config.js             palette: protocols, severities, DEFCON
    assets.js             loads world.json + textures, CPU id map for picking
    gl/gl.js              context, programs with uniform discovery, targets, MSAA
    gl/post.js            bloom chain, tone mapping, glitch, CRT
    scene/renderer.js     pass orchestration, adaptive resolution
    scene/camera.js       orbit camera, inertia, fly-to, lens shift, controls
    scene/globe.js        the planet shader
    scene/sky.js          stars, Milky Way, atmosphere halo
    scene/arcs.js         instanced great-circle ribbons
    scene/comets.js       GPU ring buffer of packet comets
    scene/markers.js      dots, beams, ripples, home beacon, shockwaves, orbits
    scene/traces.js       traceroute paths: gold route, hop beacons, pulse train
    scene/placement.js    where endpoints live in 3D
    scene/world.js        store → GPU layers, comet budgets, screen positions
    state/store.js        client model of the engine
    net/protocol.js       PKTS binary codec
    net/connection.js     WebSocket, auth, reconnect, demo fallback
    demo/                 the demo engine (catalog + simulator)
    hud/                  top bar, boards, feed, alerts, charts, minimap,
                          labels, detail, search, help
    audio/audio.js        synthesised sound
```

## A frame

```
┌ HDR scene target · RGBA16F · 4× MSAA ───────────────────────────────────┐
│ 1 sky      full-screen: stars, Milky Way, atmosphere halo   (no depth) │
│ 2 globe    sphere mesh, distance-field shading              (depth)    │
│ 3 layers   additive, depth-tested, no depth writes:                    │
│              arcs → markers → comet trails → comet heads               │
└──────────────────────────────┬──────────────────────────────────────────┘
                     blit resolve │
                                  ▼
          bloom: 6-level 13-tap downsample (Karis on level 0, soft knee)
                 → 3×3 tent upsample, additive back up the chain
                                  ▼
          composite → canvas: ACES fit, gamma, vignette, grain,
          chromatic split + slice glitch (alerts), optional CRT
```

The scene renders at an adaptive fraction of the canvas resolution. The
renderer watches the 75th-percentile frame time and steps resolution down
when it exceeds 19 ms and back up below 12 ms. The composite always runs at
full resolution.

## The globe

All of the globe's look comes from four small textures baked by
`tools/geogen` and a single fragment shader.

* **Seam-free sampling.** Latitude and longitude are recomputed per
  fragment from the sphere position. Texture derivatives come from whichever
  of two parameterisations (`u` and `fract(u + ½)`) is continuous at that
  pixel (Tarini's trick), so mipmapped lookups have no seam at the
  antimeridian.
* **Coasts and borders** are distance fields, rendered as an anti-aliased
  line (`fwidth`) plus a soft glow.
* **Dot-matrix land is a quadtree.** Level 0 is a latitude-corrected
  lattice of 150 rings. Each level splits every cell into 2×2 aligned
  sub-cells, and the shader picks the level that keeps cells about 11 px
  wide. Between levels, dots split by "mitosis": the parent shrinks while
  its four children grow. The first version cross-faded two unrelated
  lattices, which looked like a ghosted double exposure at the in-between
  zoom levels. Each dot samples the land field at its own centre, so dots
  are whole or absent, never clipped by the coastline.
* **Traffic heat.** A 256×1 texture maps country id → heat, updated twice a
  second from endpoint byte rates. The id texture is read with `texelFetch`,
  so it has no filtering and no seam.
* **Light.** The sub-solar point is computed from the real date (solar
  declination plus the equation of time). The terminator, a warm city-light
  layer on the night side and a small ocean glint follow it.
* **Home radar.** Range rings every 10° and a rotating sweep around the home
  beacon, drawn in the same shader.

The **atmosphere halo** is analytic. For each view ray, the closest-approach
altitude above the sphere drives a sum of exponentials, tinted by where that
point sits relative to the sun, and shifted to red as the threat level rises.
The **stars** are hashed cells on the view sphere, so they stay fixed in
space as the camera moves.

## Arcs and comets: all motion on the GPU

`arcPoint(a, b, lift, t)` exists twice, in GLSL and in JS, and the two
implementations are identical. It interpolates direction on the sphere
(slerp), interpolates radius linearly, and adds a `sin(πt)` lift that
scales with distance. CPU picking and minimap paths therefore match what
the GPU draws exactly.

* **Arcs.** Each arc is an instanced triangle strip of 73 segment pairs.
  The vertex shader evaluates the curve, takes a screen-space tangent from
  two neighbouring samples, and offsets each vertex sideways by a constant
  pixel width. Growth on creation, fades on expiry, flowing dashes in the
  dominant traffic direction and threat pulsing are all driven by uniform
  time against per-instance birth and death stamps. The CPU uploads 80
  bytes per arc.
* **Comets.** Each PKTS record becomes one 64-byte instance in a fixed ring
  buffer (32,768 slots). After that the CPU never touches it again: the
  vertex shader derives the comet's position from `(time − birth) /
  duration`. Each frame uploads only the slots written since the previous
  frame (two `bufferSubData` calls when the write wraps around) and draws
  only the live window of the ring. WebGL2 has no base-instance draw, so the
  instanced attribute pointers are re-pointed at the window's offset
  instead. Two programs share the buffer: a tapered 12-segment trail and a
  billboard head.
* **Comet budgets.** Real traffic is bursty and lopsided: one 20 MB/s
  download would otherwise draw a solid laser. Comets are limited per
  endpoint and direction. A token bucket sets the rate, and the rate scales
  with arc length so short arcs stay discrete. A hard cap allows 7 comets in
  flight per endpoint and direction. Throttled bytes carry into the next
  comet, whose size and brightness grow with log(bytes) up to a ceiling. A
  heavy flow reads as a stream of fat comets, and the arc itself thickens
  with the flow's rate.

## Traceroute paths

When the machine runs `mtr` or `traceroute`, the engine reconstructs the
route and streams `trace` messages. The UI turns each one into a set piece:

* A **gold route** runs from home through every located hop in TTL order.
  LAN hops sit at home, co-located hops merge, and hops that never answered
  or can't be located are skipped. The segments are drawn by a second
  instance of the arc renderer, fed explicit instances through
  `Arcs.setInstances`, so they share its growth, fade and flowing-dash
  shader with a lower, route-hugging lift.
* **Segment by segment.** Each segment is born when its far hop first
  answers, but never sooner than 0.32 s after the previous one, so the
  route draws itself outwards even if many hops arrive in one message. If
  mtr fills a gap later (a hop that was silent on the first pass), the path
  re-routes through it.
* A **pulse train** of hot-gold comets races from home to the farthest hop
  every 2.2 s, chained across segments.
* **Hop beacons and labels.** Each hop answering triggers a gold ripple and
  a typed label such as `6 · New York · 82 ms`; the destination gets a
  pulsing ring and `9 · api.anthropic.com · San Francisco · 151 ms`.
* **Announcements.** The feed logs `TRACE ⋯ probing …` and then
  `TRACE → api.anthropic.com · 9 hops · 151 ms`, and a toast appears. If the
  viewer has been idle (or cinematic mode is on), the camera frames the
  whole route.
* The trace fades out when the engine expires it (`gone.traces`).

## Data flow

```
WebSocket ──▶ Connection ──▶ Store ──▶ World (GPU layers)
  JSON frames    auth, reconnect,   full upserts,  ├─ arcs/markers rebuilt per frame
  PKTS frames    demo fallback      derived fields ├─ comets spawned per shot
                                    + indexes      └─ screen positions (labels, picking)
                                                 └▶ HUD (each panel at its own cadence)
```

* The **Store** applies the protocol's full-object upserts in place. Keys
  absent from the update are deleted, and client-derived keys (prefixed
  `_`) survive. It maintains flows-by-endpoint, endpoints-by-IP, the
  dominant protocol of each endpoint, per-endpoint rate history, 1 Hz and
  4 Hz stats history, and per-country aggregates.
* **Finding the engine.** On `*.github.io`, `file:` and `?demo` the page
  never opens a socket. Elsewhere it first fetches `healthz`: the engine
  answers `ok`, while a static host 404s silently. A failed WebSocket
  handshake would print a console error, so a socket is only ever opened
  to a confirmed engine. The same silent probe drives reconnection after
  the engine goes away, and a background check every 10 s switches a
  fallback demo to live data as soon as an engine starts.
* **Binary PKTS** frames decode into a reused struct-of-arrays, so decoding
  allocates nothing per packet. Shots that reference a flow the client
  hasn't seen yet wait in a pending queue for up to a second.
* The **HUD** updates each panel at its own rate: the feed and labels every
  frame, the top bar at 4 Hz, the minimap at 10 Hz, the leaderboards
  every 0.6 s, the donut at 1 Hz and the spectrogram every 0.5 s.
  Leaderboard rows are keyed DOM nodes moved with transforms. Ranking uses a
  smoothed rate with an 18% hysteresis band, so rows only move for real
  changes.

## Labels

When a DNS answer arrives, its label waits up to 1.6 s for an endpoint
with one of the answer addresses to appear. Then it types itself out at
that endpoint's position. If no endpoint appears, or the answer is
NXDOMAIN, it types out near home in amber. Labels are placed greedily: the
home tag first, then traceroute hops, then DNS labels by age, then tags for
the busiest endpoints.
Each tries up to ten candidate offsets until it overlaps nothing already
placed, including the alert banner, the detail panel, the filter chip and the HUD
panels (their rectangles are cached rather than measured every frame).
A label with nowhere free hides until space opens up, rather than overlap. Labels fade
near the globe's limb and disappear behind it, using an exact ray/sphere
occlusion test.

## The demo engine

`demo/simulator.js` is a second implementation of the engine's output and
emits the identical protocol: JSON message objects plus binary PKTS frames
encoded with the same codec, so the binary path is exercised in demo mode
too. Flows follow rate shapes: DASH-style video segments, music chunks, LLM
token streaming, interactive SSH, download ramps and decaying page loads.
DNS precedes connections, TCP moves from `syn` to `est` after a
distance-derived RTT, and rates are smoothed with the engine's τ = 2 s.
A 216-second scripted timeline loops through showcase scenes (including
an `mtr api.anthropic.com` traceroute whose Chicago hop only answers on a
re-probe) and raises every alert kind.

Benign services use addresses from their operators' public ranges. Every
malicious actor uses RFC 5737 documentation addresses, private-use ASNs and
the `.example` TLD, so the demo implicates no real party. `?stress=N` adds
N benchmark endpoints in the RFC 2544 range.

## Asset pipeline

`go run ./tools/geogen -out web/ui/assets` (Go standard library only)
downloads Natural Earth land, countries and populated places, and writes:

| file | size | content |
|---|---|---|
| `land.png` | 4096×2048 | signed distance to the coast, ±16 texels |
| `borders.png` | 4096×2048 | distance to the nearest land border, 0–8 texels |
| `countries.png` | 2048×1024 | country id (nearest sampling) |
| `lights.png` | 2048×1024 | night lights splatted from 7,342 cities by population |
| `world.json` | 21 KB | encodings plus the country table |

It rasterizes polygons with its own active-edge-table scanline filler,
using the even-odd rule so holes work. Distances come from an exact
Felzenszwalb–Huttenlocher EDT. Its horizontal metric is scaled by
cos(latitude) per row, so glows have the same width on the sphere at every
latitude, and it wraps across the antimeridian. Total output is about 1.1 MB;
the whole run takes about 2 s.

## Performance

Measured in headless Firefox 157 on an RTX 5070, at 1600×900:

| scenario | result |
|---|---|
| Demo, all panels | 60 fps · ~0.7–1.0 ms of JS per frame (world 0.05, GL submit 0.05, HUD 0.7) |
| Real Go engine (`--demo`) | 60 fps · ~1.0 ms JS per frame · ~1 ms/s handling frames |
| `?stress=200` | **28,199 comets in flight at 60 fps** |
| `?stress=1200` | 28,533 comets in flight, 1,227 arcs · 54 fps · HUD 1.7 ms, world 0.7 ms |

Things that were measured and fixed:

* **`backdrop-filter` on the panels: 17 fps → 60 fps when removed.** The
  browser re-blurred the live WebGL canvas under every panel on every
  frame. The panels now use slightly more opaque gradients, which read the
  same.
* **An animated `filter: drop-shadow` on the DEFCON meter** forced a
  repaint every frame (about 2 fps). It's now an opacity blink.
* **CRT mode's page-wide scanline overlay used `mix-blend-mode: multiply`**:
  14 fps. Plain alpha looks identical for black scanlines: 56 fps.
* **The minimap** recomputed 1,200 great circles at 10 Hz. Paths are now
  cached per endpoint, and only the 300 busiest are drawn: HUD time 4.1 →
  1.7 ms per frame under stress.
* **NaN in the bloom chain** blacked out the screen in blocky staircases.
  The cause was MSAA: a partially covered pixel shades at its centre, which
  can lie outside the triangle, so varyings extrapolate past their range and
  `pow()` receives a negative base, which is undefined in GLSL and gives NaN
  on NVIDIA. Every `pow` base is now clamped, squares are written as
  multiplications, and the bloom prefilter rejects NaN/Inf as a second line
  of defence.

## Debugging hooks

| | |
|---|---|
| `?demo` | force the demo engine (automatic on `*.github.io` and when no engine answers) |
| `?home=lat,lon` · `?seed=n` | demo home and random seed |
| `?stress=n` | n benchmark endpoints with heavy flows |
| `?off=arcs,markers,comets` | disable render layers |
| `window.telluric` | `{ store, world, camera, renderer, actions, hud, conn }` |
| `window.__telluric` | live counters: fps, per-subsystem frame time, comets, arcs… |

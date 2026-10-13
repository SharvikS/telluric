# Renderer and UI

The browser side of Telluric is a raw WebGL2 renderer under a monitoring
console: an app shell with nine views, a design system, a motion system and
hand-rolled charts. It is written as native ES modules (about 11k lines of JS,
1.2k of CSS), with no 3D library, no UI framework, no bundler and no build
step. Everything it needs, fonts included, ships inside the Go binary
(`web/ui`, embedded with `//go:embed`). It makes no requests to third parties.
The same files run as a static site (GitHub Pages) with a built-in demo engine.

```
web/ui/
  index.html                  shell mount points, pre-paint theme script
  styles/
    tokens.css                design tokens: colour (dark + light), type, space, radii, motion
    base.css                  reset, typography, keyframes, theme-switch rules
    shell.css                 nav rail, top bar, views, boot screen, globe slot
    components.css            buttons … tables, drawer, palette, toasts, summary strips
    views.css                 per-view layout (overview grid, map panels, security …)
  assets/                     baked map textures (tools/geogen), Inter + JetBrains Mono, favicon
  src/
    main.js                   wiring: prefs → theme → boot → renderer → app → frame loop
    theme-init.js             resolves the theme before first paint (CSP-safe, external)
    app/
      app.js                  App: shell, views, routing, globe slot, entities, keys, frame
      router.js               hash routes  #/view?param=…  (GitHub Pages friendly)
      prefs.js                persisted preferences (localStorage, versioned)
      theme.js                system / light / dark, view-transition reveal
      motion.js               durations, easings, animate(), springs, tweens, FLIP
      history.js              1 s + 1 min series per time range; per-entity rate rings
      boot.js                 boot sequence steps
    ui/
      shell.js                nav rail, top bar (search, live/pause, range, health, bell, theme)
      views/                  overview, map, tables (connections/hosts/processes/dns),
                              security, traces, settings
      components/             table, drawer, palette, toasts, popover/menu, tooltip,
                              controls (tabs, segmented, switch…), rank, activity, summary
      charts/                 area, bars, donut, heatmap, spark, series (buckets, monotone)
      entity.js               drawer content for hosts, flows, processes, alerts, traces
      globe-labels.js         DNS answers, hop pins, host tags placed around obstacles
      icons.js, dom.js        in-house stroke icons and illustrations; tiny DOM helper
    config.js                 data-viz palette, protocol families, severities, threat levels
    gl/ scene/                the renderer (below)
    state/store.js            client model of the engine
    net/                      WebSocket + PKTS codec, demo fallback
    demo/                     the demo engine (catalog + simulator)
    audio/audio.js            synthesised sound cues (off by default)
```

## Architecture

### One canvas, many views

A single full-window WebGL2 canvas sits behind the app (`z-index 0`,
`pointer-events: none`). Each view may expose a **globe slot**, an empty
element in its layout. The Overview has a card, the Map is full-bleed and
Traceroutes has a panel beside the hop list. Every frame, `GlobeSlot`
measures the active slot. The renderer then draws only into that rectangle
(viewport + scissor). The composite pass writes premultiplied alpha through
a rounded-rect mask with the slot's corner radius, so the globe appears to
live inside the card. Views without a globe (tables, Security, Settings)
cost the GPU nothing: the canvas is just cleared.

When the route changes, the slot rectangle tweens from the old host element
to the new one over 0.6 s (ease-in-out cubic). The globe flies out of the
Overview card into the full-bleed Map and back again: a shared-element
transition done in the renderer, not the DOM. Pointer input is re-attached
to whichever element currently hosts the globe.

### Views and routes

| route | view |
|---|---|
| `#/overview` | KPI tiles with sparklines and deltas, live globe, protocol mix, security summary, throughput, top hosts / processes / countries, activity |
| `#/map` | full-bleed globe, glass panels: layers, live stats, legend, zoom; the drawer is a non-modal inspector here |
| `#/connections` | every flow: summary strip (encrypted %, post-quantum %, median RTT, traffic by protocol) + virtualised table |
| `#/hosts` | every remote address with network, location, protocol, live sparkline; traffic by country |
| `#/processes` | programs on the network, expandable into their connections; traffic by process |
| `#/dns` | lookups per minute, NXDOMAIN rate, median latency, top names, query log |
| `#/security` | threat level, alert heatmap (severity × 5 min), open / acknowledged / resolved / muted, bulk actions |
| `#/traces` | reconstructed traceroutes: list, route on the globe (spotlit), hop table |
| `#/settings` | appearance, motion, globe layers, units & time, notifications, system status, about |

Selections deep-link (`?sel=ep:42`), as do filters (`#/connections?proc=firefox`,
`#/hosts?country=DE`) and settings sections (`#/settings?section=system`).

### Data flow

```
WebSocket ──▶ Connection ──▶ Store ──┬─▶ World (GPU layers: arcs, markers, comets, traces)
  JSON + PKTS    auth, reconnect,     ├─▶ History (time ranges, entity rate rings)
                 demo fallback,       ├─▶ App (toasts, badges, health, notifications)
                 commands ◀── App     └─▶ current View: refresh at its own cadence
                                          (Overview 2 Hz, tables 1 Hz, Settings 0.5 Hz)
```

* The **Store** applies the protocol's full-object upserts in place. Keys
  absent from the update are deleted, and client-derived keys (prefixed
  `_`) survive. It maintains flows-by-endpoint, endpoints-by-IP, each
  endpoint's dominant protocol, per-country aggregates, the 1 s history (up
  to an hour), the engine's one-minute averages (up to a day), the DNS log
  and the engine status. DNS that arrives in the snapshot is stored as a
  backlog, without announcing each lookup.
* **Alerts are a workflow.** Each alert carries `first`, `count`, `state`
  (open · acknowledged · resolved), `stateTs` and `muted`. Acknowledge,
  resolve, reopen, mute and unmute send `{"t":"alert.<cmd>","id":N}`. The
  UI updates optimistically (marked `_pending`), offers Undo, and reconciles
  when the server's echo arrives; the echo also reaches every other open
  tab. Muted alerts update silently: they don't toast, play sounds or count
  toward the badge or threat level. A resolved alert that recurs comes back
  open with its count raised.
* **Status** arrives every 2 s (and in the snapshot). It drives the top-bar
  health pill (amber whenever there are warnings), its popover, and
  Settings → System status: capture counters, engine CPU/heap/goroutines,
  frames per second and data sources with their age.
* **History.** `History.series(range)` serves 5m/15m from 1 s samples and
  1h/6h/24h from the engine's minute averages, with the current partial
  minute stitched on from 1 s samples so long ranges stay live. A freshly
  started engine has no minutes yet, so seconds are used whenever they reach
  further back, and charts mark where history begins.
* **Live / Paused.** Pausing freezes every view and the time axis while the
  store keeps ingesting. The pill counts buffered updates, and resuming
  catches up in one step.
* **Finding the engine.** On `*.github.io`, `file:` and `?demo` the page
  never opens a socket. Elsewhere it first fetches `healthz`: the engine
  answers `ok`, while a static host 404s silently. A socket is only ever
  opened to a confirmed engine, so a static deployment logs no errors. The
  same silent probe drives reconnection.

## Design system

The look aims for the restraint of Linear, Vercel and Datadog: layered
neutral surfaces, 1 px hairlines, one accent, semantic colour only where it
means something, and data set in tabular figures.

### Tokens (`styles/tokens.css`)

| group | values |
|---|---|
| surfaces | `--bg` → `--surface` → `--surface-2/3` → `--elevated` / `--overlay`; `--hover`, `--active` |
| text | `--text`, `--text-2`, `--text-3`, `--text-4` |
| lines | `--border`, `--border-2`, `--border-3` (1 px hairlines) |
| accent | indigo: `--accent`, `-2`, `-text`, `-soft`, `-softer`, `-ring` |
| semantic | `--success`, `--warning`, `--orange`, `--danger`, `--info` (each with `-soft`) |
| data viz | `--viz-tls/quic/http/dns/ssh/rtc/p2p/other/in/out/threat` |
| type | Inter (variable, vendored) for UI; JetBrains Mono only for data (IPs, JA4, DNS names); `--text-2xs … 4xl`; tabular numerals on every number |
| space | 4 px grid: `--s-1` (4) … `--s-8` (32) |
| radii | `--r-xs` 4 · `--r-sm` 6 · `--r-md` 8 · `--r-lg` 12 · `--r-xl` 16 · `--r-full` |
| elevation | `--shadow-sm/md/lg/xl`, `--glass` (map panels), `--scrim` |
| layout | nav 232 / 64 px, top bar 56 px, drawer 520 px, table rows 36 px |

### Themes

Dark is the default; light and "system" are a click away, and the choice
persists. `theme-init.js` resolves the theme before first paint. It is an
external script because the engine's CSP (`script-src 'self'`) blocks inline
ones. `?theme=dark|light` overrides for one page load without persisting.

Switching uses the **View Transitions API**: a circle grows from the toggle
(or from the clicked option in Settings) and reveals the new palette. While
the circle grows, colour transitions are disabled (`theme-switching`), so
the live "new" image is already final rather than mid-fade. Without View
Transitions, the page cross-fades colours for 280 ms instead.

The globe is themed too, not just tinted:

* **Dark:** an indigo-slate night globe with additive light (ONE, ONE), a
  bloom tuned per theme, a soft vignette and an analytic atmosphere.
* **Light:** a slate ocean one step darker than the page, paler land with
  higher-contrast dots, a soft terminator and limb, and a crisp 1 px
  silhouette outline. An offset drop shadow comes from a sphere nudged down
  the screen. Light layers blend premultiplied-over (ONE,
  ONE_MINUS_SRC_ALPHA), so arcs and comets stay legible on a light ground.

**Cinema mode** (Settings → Motion) restores the original showpiece look for
big screens: stronger bloom and arcs, film grain, vignette, and alert
glitch, chromatic split and camera shake.

### Colour that means something

* **Protocol families** use the Okabe–Ito palette, which stays distinct
  under the common colour-vision deficiencies. There are separate tunings
  for dark and light. `config.js` (`VIZ`) is the single source for the
  shaders, and the CSS `--viz-*` variables mirror it, so a QUIC arc, a QUIC
  comet, the QUIC donut slice and the QUIC chart layer are the same colour.
* **Severity:** critical red · high orange · medium amber · low blue · info grey.
* **Threat level** replaces the old DEFCON: 5 Normal · 4 Guarded · 3
  Elevated · 2 High · 1 Critical. It is shown as a five-segment meter.
* Categories without semantic colour (countries, processes) use an ordinal
  ramp of the accent.

### Components

* **Data table** (`components/table.js`):
  * virtualised rows (5,000+ rows scroll at 60 fps), keyed so re-sorting
    glides (FLIP)
  * sticky header, sort with a caret
  * filter menu with value counts, removable chips, free-text search,
    column chooser, CSV/JSON export
  * keyboard navigation (↑ ↓ Enter), expandable child rows (processes →
    connections), a highlight for new rows
  * fits its content and hides low-priority columns when narrow; an explicit
    column choice always wins
* **Summary strip:** headline numbers plus a distribution bar whose segments
  and legend entries filter the table in one click.
* **Drawer:** springs in from the right, with tabs (Overview, Connections,
  Timeline, Raw) and actions (show on map, filter, copy, alert workflow). It
  deep-links via `?sel=`. A dot morphs from the clicked marker or row into
  the drawer's avatar. On the Map it's a non-modal inspector: there is no
  scrim, the globe stays interactive and re-centres beside it, and the
  floating panels slide aside.
* **Command palette** (⌘K / Ctrl K, `/`):
  * fuzzy search over navigation, actions, hosts, processes, alerts,
    countries and traceroutes, with matched characters highlighted
  * scattered-letter matches are rejected
* **Toasts:** stacked with depth, they expand on hover. They have a progress
  bar that pauses on hover, actions (View, Acknowledge, Undo) and dedupe keys.
* **Also:** popovers and menus with keyboard navigation, tooltips with
  keyboard hints, tabs with a sliding ink bar, segmented controls with a
  sliding thumb, switches, badges, skeletons with shimmer, illustrated empty
  states, `kbd` hints, leaderboards (smoothed ranking with 18% hysteresis),
  and the activity feed.
* **Charts** (canvas and SVG, no library):
  * **Area chart:** averages time-weighted buckets sized to the range (about
    160 points: 10 s buckets for 15 minutes, 10 minutes for a day). It draws
    monotone-cubic curves (Fritsch–Carlson, no overshoot) with gradient
    fills. The window scrolls every frame, the y-domain eases, a range
    change animates the span, and the left edge fades. The crosshair snaps
    to the nearest bucket and rings each value. Stacked mode orders layers
    by volume.
  * **Other charts:** donut, bars, heatmap and sparklines (sparklines
    right-align partial history behind a dotted baseline).
  * **Theme:** every chart reads its colours from CSS variables, so it
    follows the theme.

## Motion system

Motion explains change: where something came from, where it went, what is
new. It is never decoration on a loop.

* **Tokens:** `--dur-instant … slowest` (90–800 ms), `--ease-out`
  (expo-like), `--ease-in-out`, and `--ease-spring`, a `linear()` easing
  sampled from a damped spring so CSS transitions can overshoot naturally.
* **JS primitives** (`app/motion.js`):
  * `animate()`, a WAAPI wrapper that honours reduced motion
  * `approach()`, frame-rate-independent smoothing
  * `Spring`, `Tweens` (count-up numbers) and `flipFirst/flipPlay`

| motion | how |
|---|---|
| Boot | the logo draws itself → steps tick off (*Loading map data*, *Connecting to engine*, *Receiving snapshot*) → the globe flies in from deep space → panels stagger in |
| Route change | outgoing view fades and settles, incoming rises in; the globe slot morphs between hosts |
| Lists | leaderboard rows and table rows glide to new ranks (keyed nodes + transforms) |
| Numbers | KPI values count up and ease between updates |
| Globe | arcs draw from home and fade on expiry; markers spring in; new hosts ripple; fly-to with a slight pull-back; slow auto-rotate when idle |
| Drawer | spring slide plus the shared-element dot from marker/row to avatar |
| Toasts | slide in, stack with depth, expand on hover, progress pauses |
| Theme | circular reveal from the toggle (View Transitions) |
| Controls | nav indicator, tab ink and segmented thumb slide with the spring |
| Charts | range changes zoom the time span; y-axis eases; live head rides the newest point |

**Reduced motion** follows the OS setting unless Settings → Motion says
otherwise. With it on:

* durations collapse to 1 ms, including hard-coded ones, via a global
  override
* loops stop: status pulses run once
* there is no shared-element dot or boot fly-in
* camera flights arrive at once and auto-rotation pauses

Each item in the table was checked with frame captures in headless Firefox:
slowed playback (`playbackRate` 0.1–0.25) for CSS and WAAPI motion, and
real-time captures for the WebGL motion. The theme reveal was verified by
instrumenting `startViewTransition`, because screenshots capture the live
document rather than the transition overlay.

## A frame

```
┌ scene target · RGBA16F · 4× MSAA · viewport/scissor = globe slot ──────┐
│ 1 sky      background, stars (dark), atmosphere or drop shadow (light) │
│ 2 globe    sphere mesh, distance-field shading                (depth)  │
│ 3 layers   depth-tested, no depth writes:                              │
│              arcs → markers → comet trails → comet heads               │
│            dark: additive · light: premultiplied over                  │
└──────────────────────────────┬──────────────────────────────────────────┘
                     blit resolve │
                                  ▼
          bloom: 6-level 13-tap downsample (Karis on level 0, soft knee)
                 → 3×3 tent upsample (per-theme strength)
                                  ▼
          composite → canvas (premultiplied, rounded-rect slot mask):
          tone curve with a soft shoulder, sRGB encode; vignette and grain
          (dark); chromatic split clamped to the slot (Cinema only)
```

The scene renders at an adaptive fraction of the slot's resolution. The
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
  its four children grow, so zooming never shows two lattices ghosted over
  each other. Each dot samples the land field at its own centre, so dots are
  whole or absent, never clipped by the coastline.
* **Traffic heat.** A 256×1 texture maps country id → heat, updated twice a
  second from endpoint byte rates and read with `texelFetch`.
* **Light.** The sub-solar point comes from the real date (solar
  declination plus the equation of time). The terminator, warm city lights
  on the night side and a small ocean glint follow it.
* **Home radar.** Range rings every 10° and a rotating sweep around home.
* **Silhouette.** Limb darkening and an atmosphere rim give depth. In the
  light theme, a crisp outline at `NdotV → 0` (about 1.3 px, from `fwidth`)
  keeps a pale globe's shape.

## Arcs and comets: all motion on the GPU

`arcPoint(a, b, lift, t)` exists twice, in GLSL and in JS, and the two
implementations are identical. It interpolates direction on the sphere
(slerp), interpolates radius linearly, and adds a `sin(πt)` lift that grows
with distance but flattens for intercontinental links. CPU picking and label
placement therefore match what the GPU draws exactly.

* **Arcs.** Each arc is an instanced triangle strip of 73 segment pairs. The
  vertex shader evaluates the curve and offsets vertices sideways by a
  constant pixel width. Growth, fade-out, flowing dashes in the dominant
  direction and threat pulsing all run off uniform time against
  per-instance birth and death stamps. The CPU uploads 80 bytes per arc.
* **Quiet by default.** Outside Cinema mode, arcs are hairline-thin. A soft
  gradient runs along each one, quieter at home. Long arcs dim at their apex,
  and a long arc whose plane contains the line of sight fades (|n̂·v̂| → 0)
  instead of reading as a straight streak shooting off the limb. Selected
  and traceroute arcs are exempt.
* **Comets.** Each PKTS record becomes one 64-byte instance in a fixed ring
  buffer (32,768 slots). After that the CPU never touches it again: the
  vertex shader derives the position from `(time − birth) / duration`. Each
  frame uploads only the slots written since the last frame and draws only
  the live window of the ring.
* **Comet budgets.** A token bucket per endpoint and direction sets the rate,
  scaled with arc length so short arcs stay discrete, and at most 7 comets
  are in flight per endpoint and direction. Throttled bytes carry into the
  next comet, whose size and brightness grow with log(bytes) up to a ceiling
  (lower outside Cinema).
* **Focus.** A process drawer dims every arc, comet, marker and label that
  isn't one of that process's hosts (`scene/focus.js`).

## Traceroutes

When the machine runs `mtr` or `traceroute`, the engine reconstructs the
route and streams `trace` messages.

* A **gold route** runs from home through every located hop in TTL order.
  It is drawn by a second instance of the arc renderer with a lower,
  route-hugging lift. Segments draw outwards, at least 0.32 s apart. A hop
  that answers late (as mtr fills gaps) re-routes the path.
* A **pulse train** of hot-gold comets races from home to the farthest hop
  every 2.2 s.
* **Hop pins** label each answering hop (`6 · New York · 82 ms`).
* The **Traceroutes view** spotlights the selected route: other traffic
  dims and host labels step aside.
* A completed trace raises a toast ("View path") and an Activity entry.

## Labels

When a DNS answer arrives, its label waits up to 1.6 s for an endpoint with
one of the answer addresses to appear, then appears at that endpoint (or near
home, in amber, for NXDOMAIN).

Labels are placed greedily: home first, then traceroute hops, then DNS
answers by age, then tags for the busiest hosts, threats and the selection.
Each label tries up to ten candidate offsets until it overlaps nothing:
neither an earlier label nor anything the current view reports as an
obstacle (map panels, the drawer). A label with nowhere free waits rather
than overlap.

Labels fade at the limb and hide behind it, using an exact ray/sphere test.
They also hide while the globe slot is mid-morph.

## The demo engine

`demo/simulator.js` is a second implementation of the engine's output. It
emits the identical protocol: JSON messages plus binary PKTS frames encoded
with the same codec.

* **Flows** follow rate shapes: DASH video segments, music chunks, LLM token
  streaming, interactive SSH, download ramps and decaying page loads. DNS
  precedes connections, and TCP moves from `syn` to `est` after a
  distance-derived RTT.
* **A 216-second scripted timeline** loops through showcase scenes,
  including an `mtr api.anthropic.com` traceroute, and raises every alert
  kind.
* **Everything the console needs:**
  * the alert lifecycle and its commands, with recurrence and muting
  * a status report every 2 s
  * 15 minutes of synthetic 1 s history plus 24 hours of minute averages
    with a diurnal curve, then a `stats.min` every minute
  * 30 minutes of earlier DNS lookups

  So the static GitHub Pages build shows every view populated.

Benign services use addresses from their operators' public ranges. Every
malicious actor uses RFC 5737 documentation addresses, private-use ASNs and
the `.example` TLD, so the demo implicates no real party. `?stress=N` adds N
benchmark endpoints in the RFC 2544 range.

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
cos(latitude) per row and wraps across the antimeridian.

Fonts are vendored: Inter (variable, SIL OFL) and JetBrains Mono 400/500/700
(SIL OFL).

## Performance

Measured in headless Firefox 157 on an RTX 5070, at 1920×1080. Each figure
is an 8 s window timed from `requestAnimationFrame`. "JS" is the app's own
work per frame: world update, view frame, labels and GL submission.

| scenario | fps | p95 frame | JS / frame |
|---|---|---|---|
| Real Go engine (`--demo`) · Overview · dark | 60.0 | 17.1 ms | 1.69 ms |
| Real Go engine · Overview · light | 60.0 | 17.1 ms | 1.48 ms |
| Real Go engine · Map · dark | 59.9 | 17.1 ms | 0.54 ms |
| Real Go engine · Map · light | 60.0 | 17.2 ms | 0.58 ms |
| In-page demo engine · Overview · dark / light | 59.5 | 17.2 ms | 2.1 ms |
| In-page demo engine · Map · dark / light | 60.0 | 17.2 ms | 0.7 ms |
| Tables, Security, Settings | 60.0 | — | < 0.3 ms |

The in-page demo runs its simulator on the main thread, which adds work
the real engine does not; it accounts for the occasional 33 ms frame on the
Overview.

What was measured and fixed in this version:

* **Throughput chart: 3.7 → 2.1 ms per frame on the Overview.** It drew 900
  one-second points per frame; it now draws about 160 cached buckets. It also
  stopped looking like a barcode.
* **Glass map panels** use `backdrop-filter`. In v1, page-wide panels over
  the live canvas cost 17 fps. Four small panels now cost nothing
  measurable: 60.0 fps and p95 17.1 ms with them, 17.2 ms without.
* **Chromatic aberration** sampled outside the slot and left a 1 px coloured
  fringe on the globe card. It is now clamped to the slot and only used in
  Cinema mode.
* **Tables relayout only when their width changes.** Fit-to-content tables
  change height as rows come and go, and a height-triggered relayout would
  have rebuilt every row.

Kept from v1:

* **NaN in the bloom chain** (blocky black staircases) came from MSAA
  extrapolating varyings past their range into `pow()` with a negative base.
  Every `pow` base is now clamped, and the bloom prefilter rejects NaN/Inf.
* **Comet budgets** stop a single 20 MB/s download from drawing a solid
  laser.
* **Stress test:** `?stress=200` holds 28,000 comets in flight at 60 fps.

## Keyboard

| | |
|---|---|
| ⌘K · Ctrl K · `/` | command palette |
| `G` then `O M C H P D T S ,` | go to Overview, Map, Connections, Hosts, Processes, DNS, Traceroutes, Security, Settings |
| `L` | pause / resume live updates |
| `⇧T` | toggle theme |
| `[` | collapse the sidebar |
| `?` | shortcuts |
| `Esc` | close drawer / palette / popover, clear selection |
| `↑ ↓ Enter` | move and open in tables and menus |
| Map: `+ − R A` | zoom, home, auto-rotate |

## Debugging hooks

| | |
|---|---|
| `?demo` | force the demo engine (automatic on `*.github.io` and when no engine answers) |
| `?theme=dark\|light` | theme for this page load (not persisted) |
| `?home=lat,lon` · `?seed=n` | demo home and random seed |
| `?stress=n` | n benchmark endpoints with heavy flows |
| `?off=arcs,markers,comets` | disable render layers |
| `window.telluric` | `{ app, store, world, camera, renderer, conn, prefs, theme }` |
| `window.__telluric` | live counters: fps, JS frame time, comets, arcs, endpoints, alerts, render scale, route |

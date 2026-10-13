import { createProgram, createTexture, textureFromImage, GLSL_COMMON } from '../gl/gl.js';

const VS = `#version 300 es
in vec3 aPos;
uniform mat4 uViewProj;
out vec3 vPos;
void main() {
  vPos = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

// Texture encodings come from tools/geogen (see assets/world.json).
const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec3 vPos;
out vec4 outColor;

uniform sampler2D uLand;      // coast SDF, R8, mipmapped, repeat-S
uniform sampler2D uBorders;   // border distance, R8, mipmapped
uniform sampler2D uLights;    // night lights, R8, mipmapped
uniform sampler2D uCountries; // country id, R8, nearest
uniform sampler2D uHeat;      // 256×1, traffic heat per country id
uniform vec2 uCountrySize;
uniform vec3 uEye;
uniform vec3 uSun;
uniform vec3 uHome;
uniform float uHasHome;
uniform float uTime;
uniform float uDotRings;
uniform float uSelCountry;
uniform float uHoverCountry;
uniform float uAlert;         // 0..1, global alert pulse
// Theme palette (linear RGB) and shading constants, see PALETTES below.
uniform vec3 uOcean, uShelf, uGrat, uLandFill, uDotNight, uDotDay, uHeatLo, uHeatHi;
uniform vec3 uCoast, uCoastGlow, uBorder, uSelTint, uLightsCol, uRadar, uRimNight, uRimDay, uAlertCol;
uniform vec4 uK;   // night multiplier, city-light gain, limb darkening, rim gain
uniform vec4 uK2;  // coast, border, specular, graticule
uniform float uTerminator; // day/night shading on/off
uniform float uHeatOn;

${GLSL_COMMON}

const float LAND_RANGE = 16.0;
const float BORDER_RANGE = 8.0;

// Dot-matrix land as a quadtree lattice. Level 0 is a latitude-corrected
// lattice with \`rings\` rows; each level splits every cell into 2×2. As the
// camera closes in, dots undergo "mitosis": the parent shrinks while its four
// aligned children grow, so LOD changes are geometric, never two patterns
// alpha-blended over each other.
struct Cell { float latC; float lonC; float dLat; float dLon; vec2 q; float id; };

Cell baseCell(float lat, float lon, float rings) {
  Cell c;
  c.dLat = PI / rings;
  float i = floor((lat + 0.5 * PI) / c.dLat);
  c.latC = -0.5 * PI + (i + 0.5) * c.dLat;
  float nDots = max(1.0, floor(TAU * cos(c.latC) / c.dLat));
  c.dLon = TAU / nDots;
  float j = floor((lon + PI) / c.dLon);
  c.lonC = -PI + (j + 0.5) * c.dLon;
  c.q = vec2((lon - c.lonC) / c.dLon, (lat - c.latC) / c.dLat); // [-0.5, 0.5]²
  c.id = i * 4099.0 + j;
  return c;
}

// Coverage of the level-L dots of cell c with radius r (in sub-cell units).
float levelDots(Cell c, float L, float r, float lat, float pixCells, out float hot) {
  float s = exp2(-L);
  vec2 k = floor((c.q + 0.5) / s);
  vec2 ctr = -0.5 + (k + 0.5) * s;
  vec2 d = (c.q - ctr) / s;
  d.x *= c.dLon * cos(lat) / c.dLat;              // physical aspect of the cell
  float dist = length(d);
  float aa = max(pixCells / s * 0.8, 1e-4);
  float cov = 1.0 - smoothstep(r - aa, r + aa, dist);
  cov = mix(cov, 3.14159 * r * r, smoothstep(0.25, 0.6, pixCells / s));
  float slat = c.latC + ctr.y * c.dLat, slon = c.lonC + ctr.x * c.dLon;
  vec2 suv = vec2(slon / TAU + 0.5, 0.5 - slat / PI);
  float isLand = step(0.5, textureLod(uLand, suv, 0.0).r);
  float h = hash12(vec2(c.id, L * 17.0 + k.x * 3.0 + k.y * 7.0));
  hot = step(0.985, fract(h * 37.0 + floor(uTime * 0.7 + h * 13.0) * 0.618));
  return cov * isLand * (0.7 + 0.3 * h);
}

void main() {
  vec3 n = normalize(vPos);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.x, n.z);
  vec2 uv = vec2(lon / TAU + 0.5, 0.5 - lat / PI);

  // Seam-free derivatives (Tarini): pick the parameterisation whose u is
  // continuous at this pixel.
  vec2 uvA = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 dxA = dFdx(uvA), dyA = dFdy(uvA);
  if (abs(dxA.x) + abs(dyA.x) < abs(dx.x) + abs(dy.x)) { dx = dxA; dy = dyA; }
  float fwLat = (abs(dx.y) + abs(dy.y)) * PI;
  float fwLon = (abs(dx.x) + abs(dy.x)) * TAU * cos(lat);
  float pixRad = max(fwLat, fwLon) * 0.7;

  vec3 V = normalize(uEye - vPos);
  float NdotV = max(dot(n, V), 0.0);
  float NdotL = dot(n, uSun);
  float day = smoothstep(-0.12, 0.35, NdotL);

  float sd = (textureGrad(uLand, uv, dx, dy).r * 255.0 - 127.5) / 127.5 * LAND_RANGE;
  float sdW = max(fwidth(sd), 1e-3);
  float land = smoothstep(-sdW, sdW, sd);

  float dayK = uTerminator > 0.5 ? day : 1.0;

  // ── ocean ──
  vec3 col = uOcean;
  float shelf = exp(min(sd, 0.0) * 0.16) * (1.0 - land);
  col += uShelf * shelf;
  // Graticule every 15°.
  vec2 g15 = vec2(lat, lon) / (PI / 12.0);
  vec2 gw = vec2(fwLat, fwLon / max(cos(lat), 0.05)) / (PI / 12.0);
  vec2 gd = abs(fract(g15 + 0.5) - 0.5) / max(gw, vec2(1e-4));
  float grat = 1.0 - smoothstep(0.0, 1.2, min(gd.x, gd.y));
  float eq = 1.0 - smoothstep(0.0, 1.2, abs(lat) / max(gw.x * PI / 12.0, 1e-4));
  col = mix(col, uGrat, (grat * 0.5 + eq * 0.5) * uK2.w * (1.0 - land * 0.85));

  // ── land ──
  col = mix(col, uLandFill, land);
  float rings = uDotRings;
  Cell cell = baseCell(lat, lon, rings);
  float pixCells = pixRad / cell.dLat;            // one pixel, in level-0 cell units
  // Target ~11 px per dot cell: pick the level, split by mitosis in between.
  float Lf = clamp(log2(1.0 / (pixCells * 11.0)), 0.0, 2.0);
  float L0 = floor(Lf), split = smoothstep(0.15, 0.85, Lf - L0);
  float hotA = 0.0, hotB = 0.0;
  float dotR = 0.27;
  float dA = levelDots(cell, L0, dotR * (1.0 - split), lat, pixCells, hotA);
  float dB = split > 0.0 && L0 < 2.0 ? levelDots(cell, L0 + 1.0, dotR * split, lat, pixCells, hotB) : 0.0;
  float dotCov = max(dA, dB);
  float hot = max(hotA * step(0.01, dA), hotB * step(0.01, dB));

  // Country lookup (nearest) and traffic heat.
  ivec2 ci = ivec2(clamp(uv * uCountrySize, vec2(0.0), uCountrySize - 1.0));
  float cid = floor(texelFetch(uCountries, ci, 0).r * 255.0 + 0.5);
  float heat = texelFetch(uHeat, ivec2(int(cid), 0), 0).r * uHeatOn;
  float sel = (uSelCountry > 0.5 && abs(cid - uSelCountry) < 0.5) ? 1.0 : 0.0;
  float hov = (uHoverCountry > 0.5 && abs(cid - uHoverCountry) < 0.5) ? 1.0 : 0.0;

  vec3 dotCol = mix(uDotNight, uDotDay, dayK);
  vec3 heatCol = mix(uHeatLo, uHeatHi, smoothstep(0.3, 1.0, heat));
  float pulse = 0.85 + 0.15 * sin(uTime * 2.0 - cid);
  dotCol = mix(dotCol, heatCol, smoothstep(0.02, 0.9, heat) * pulse);
  dotCol = mix(dotCol, uSelTint, hot * 0.35);
  col = mix(col, dotCol, dotCov);
  col = mix(col, heatCol, heat * land * 0.07);
  col = mix(col, uSelTint, land * (sel * 0.10 + hov * 0.05));

  // Coastline: crisp line plus a soft glow on both sides.
  float coast = 1.0 - smoothstep(0.0, sdW * 1.6 + 0.25, abs(sd));
  col = mix(col, uCoast, coast * uK2.x * mix(0.8, 1.0, dayK));
  col += uCoastGlow * exp(-abs(sd) * 0.35) * 0.22;

  // Land borders.
  float bd = textureGrad(uBorders, uv, dx, dy).r * BORDER_RANGE;
  float bdW = max(fwidth(bd), 1e-3);
  float border = (1.0 - smoothstep(0.25, 0.25 + bdW * 1.5, bd)) * land;
  col = mix(col, uBorder, border * min(1.0, uK2.y + sel * 0.45 + hov * 0.2));

  // ── light ──
  col *= mix(uK.x, 1.0, dayK);
  float lights = textureGrad(uLights, uv, dx, dy).r;
  float night = smoothstep(0.08, -0.22, NdotL) * uTerminator;
  col += uLightsCol * pow(lights, 1.9) * uK.y * night;
  vec3 R = reflect(-uSun, n);
  float spec = pow(max(dot(R, V), 0.0), 220.0) * (1.0 - land) * step(0.0, NdotL) * uTerminator;
  col += vec3(0.5, 0.75, 1.0) * spec * uK2.z;

  // ── home radar: range rings every 10° and a rotating sweep ──
  if (uHasHome > 0.5) {
    float ang = acos(clamp(dot(n, uHome), -1.0, 1.0));
    float rr = ang / (PI / 18.0);
    float rw = max(fwidth(rr), 1e-4);
    float ring = (1.0 - smoothstep(0.0, rw * 1.3, abs(fract(rr + 0.5) - 0.5))) * smoothstep(4.5, 0.8, rr) * step(0.5, rr);
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), uHome) + vec3(1e-5, 0.0, 0.0));
    vec3 north = cross(uHome, east);
    vec3 t = n - uHome * dot(n, uHome);
    float az = atan(dot(t, east), dot(t, north));
    float sweep = mod(uTime * 0.6, TAU) - PI;
    float behind = mod(sweep - az + TAU, TAU);
    float trail = exp(-behind * 2.4) * smoothstep(0.80, 0.05, ang);
    col = mix(col, uRadar, min(1.0, ring * 0.16 + trail * (0.07 + 0.10 * land)));
  }

  // ── alert wash ──
  col = mix(col, uAlertCol, uAlert * 0.06 * land);

  // ── limb: darken towards the edge, then atmosphere rim ──
  col *= mix(uK.z, 1.0, sqrt(NdotV));
  float rim = pow(1.0 - NdotV, 4.0);
  vec3 atmo = mix(uRimNight, uRimDay, smoothstep(-0.25, 0.6, NdotL));
  col += atmo * rim * uK.w;

  outColor = vec4(col, 1.0);
}`;

/** sRGB hex → linear RGB. */
function lin(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
}

// Globe palettes. Dark: a calm indigo-slate night globe. Light: pale land
// dots on a light ocean with soft edges.
const PALETTES = {
  dark: {
    ocean: '#0b0f1b', shelf: '#06090f', grat: '#1c2340', landFill: '#0f1424',
    dotNight: '#27304a', dotDay: '#3c4b74', heatLo: '#5b5fe0', heatHi: '#a78bfa',
    coast: '#5d6ab5', coastGlow: '#0b1030', border: '#2e3858', selTint: '#8b93ff', lightsCol: '#f2b23e',
    radar: '#7b7ff6', rimNight: '#141a40', rimDay: '#4b5cc8', alertCol: '#f2555a',
    k: [0.62, 0.55, 0.62, 0.55], k2: [0.55, 0.55, 0.08, 0.35],
  },
  light: {
    ocean: '#eef2f8', shelf: '#000000', grat: '#dde3ee', landFill: '#e6ebf3',
    dotNight: '#a4afc4', dotDay: '#93a0b8', heatLo: '#7b7ff6', heatHi: '#5b5bd6',
    coast: '#8e9bb5', coastGlow: '#000000', border: '#c3cbdb', selTint: '#5b5bd6', lightsCol: '#d98a1a',
    radar: '#5b5bd6', rimNight: '#dfe6f2', rimDay: '#ffffff', alertCol: '#d93a3f',
    k: [0.93, 0.18, 0.88, 0.55], k2: [0.65, 0.7, 0.0, 0.45],
  },
};

/** The globe: a sphere mesh, its textures and the per-country heat table. */
export class Globe {
  constructor(gl, caps, world) {
    this.gl = gl;
    this.world = world;
    this.prog = createProgram(gl, 'globe', VS, FS);
    this.buildMesh(160, 320);
    const { images } = world;
    this.texLand = textureFromImage(gl, caps, images.land);
    this.texBorders = textureFromImage(gl, caps, images.borders);
    this.texLights = textureFromImage(gl, caps, images.lights);
    this.texCountries = textureFromImage(gl, caps, images.countries, { nearest: true });
    this.countrySize = [images.countries.width, images.countries.height];
    this.heat = new Uint8Array(256);
    this.texHeat = createTexture(gl, {
      width: 256, height: 1, internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE,
      data: this.heat, minFilter: gl.NEAREST, magFilter: gl.NEAREST,
    });
    this.heatDirty = false;
    this.selCountry = 0;
    this.hoverCountry = 0;
    this.terminator = true;
    this.heatOn = true;
    this.setTheme('dark');
  }

  setTheme(mode) {
    const p = PALETTES[mode] || PALETTES.dark;
    this.pal = {};
    for (const [k, v] of Object.entries(p)) this.pal[k] = typeof v === 'string' ? lin(v) : v;
  }

  buildMesh(latSeg, lonSeg) {
    const gl = this.gl;
    const pos = new Float32Array((latSeg + 1) * (lonSeg + 1) * 3);
    let k = 0;
    for (let i = 0; i <= latSeg; i++) {
      const lat = Math.PI / 2 - (i / latSeg) * Math.PI;
      const c = Math.cos(lat), s = Math.sin(lat);
      for (let j = 0; j <= lonSeg; j++) {
        const lon = -Math.PI + (j / lonSeg) * Math.PI * 2;
        pos[k++] = c * Math.sin(lon);
        pos[k++] = s;
        pos[k++] = c * Math.cos(lon);
      }
    }
    const idx = new Uint32Array(latSeg * lonSeg * 6);
    k = 0;
    for (let i = 0; i < latSeg; i++) {
      for (let j = 0; j < lonSeg; j++) {
        const a = i * (lonSeg + 1) + j, b = a + lonSeg + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = a + 1;
        idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1;
      }
    }
    this.count = idx.length;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /** heatById: Map<countryId, 0..1>. */
  setHeat(heatById) {
    this.heat.fill(0);
    for (const [id, h] of heatById) if (id > 0 && id < 256) this.heat[id] = Math.round(Math.min(1, h) * 255);
    this.heatDirty = true;
  }

  draw(frame) {
    const gl = this.gl;
    if (this.heatDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.texHeat);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, this.heat);
      this.heatDirty = false;
    }
    const { prog, u } = this.prog;
    gl.useProgram(prog);
    gl.uniformMatrix4fv(u.uViewProj, false, frame.camera.viewProj);
    gl.uniform3fv(u.uEye, frame.camera.eye);
    gl.uniform3fv(u.uSun, frame.sun);
    gl.uniform3fv(u.uHome, frame.home);
    gl.uniform1f(u.uHasHome, frame.hasHome ? 1 : 0);
    gl.uniform1f(u.uTime, frame.time);
    gl.uniform1f(u.uDotRings, 150);
    gl.uniform1f(u.uSelCountry, this.selCountry);
    gl.uniform1f(u.uHoverCountry, this.hoverCountry);
    gl.uniform1f(u.uAlert, frame.alert);
    gl.uniform2f(u.uCountrySize, this.countrySize[0], this.countrySize[1]);
    const P = this.pal;
    gl.uniform3fv(u.uOcean, P.ocean); gl.uniform3fv(u.uShelf, P.shelf); gl.uniform3fv(u.uGrat, P.grat);
    gl.uniform3fv(u.uLandFill, P.landFill); gl.uniform3fv(u.uDotNight, P.dotNight); gl.uniform3fv(u.uDotDay, P.dotDay);
    gl.uniform3fv(u.uHeatLo, P.heatLo); gl.uniform3fv(u.uHeatHi, P.heatHi); gl.uniform3fv(u.uCoast, P.coast);
    gl.uniform3fv(u.uCoastGlow, P.coastGlow); gl.uniform3fv(u.uBorder, P.border); gl.uniform3fv(u.uSelTint, P.selTint);
    gl.uniform3fv(u.uLightsCol, P.lightsCol); gl.uniform3fv(u.uRadar, P.radar); gl.uniform3fv(u.uRimNight, P.rimNight);
    gl.uniform3fv(u.uRimDay, P.rimDay); gl.uniform3fv(u.uAlertCol, P.alertCol);
    gl.uniform4fv(u.uK, P.k); gl.uniform4fv(u.uK2, P.k2);
    gl.uniform1f(u.uTerminator, this.terminator ? 1 : 0);
    gl.uniform1f(u.uHeatOn, this.heatOn ? 1 : 0);
    const texs = [this.texLand, this.texBorders, this.texLights, this.texCountries, this.texHeat];
    const names = ['uLand', 'uBorders', 'uLights', 'uCountries', 'uHeat'];
    for (let i = 0; i < texs.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texs[i]);
      gl.uniform1i(u[names[i]], i);
    }
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}

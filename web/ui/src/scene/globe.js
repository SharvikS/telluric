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

  // ── ocean ──
  vec3 col = vec3(0.0022, 0.0055, 0.0125);
  float shelf = exp(min(sd, 0.0) * 0.16) * (1.0 - land);
  col += vec3(0.0, 0.010, 0.018) * shelf;
  // Graticule every 15°, finer every 5° when zoomed in.
  vec2 g15 = vec2(lat, lon) / (PI / 12.0);
  vec2 gw = vec2(fwLat, fwLon / max(cos(lat), 0.05)) / (PI / 12.0);
  vec2 gd = abs(fract(g15 + 0.5) - 0.5) / max(gw, vec2(1e-4));
  float grat = 1.0 - smoothstep(0.0, 1.2, min(gd.x, gd.y));
  float eq = 1.0 - smoothstep(0.0, 1.2, abs(lat) / max(gw.x * PI / 12.0, 1e-4));
  col += vec3(0.05, 0.22, 0.32) * (grat * 0.10 + eq * 0.10) * (1.0 - land * 0.85);

  // ── land ──
  col = mix(col, vec3(0.006, 0.022, 0.029), land);
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
  float heat = texelFetch(uHeat, ivec2(int(cid), 0), 0).r;
  float sel = (uSelCountry > 0.5 && abs(cid - uSelCountry) < 0.5) ? 1.0 : 0.0;
  float hov = (uHoverCountry > 0.5 && abs(cid - uHoverCountry) < 0.5) ? 1.0 : 0.0;

  vec3 dotCol = mix(vec3(0.030, 0.17, 0.22), vec3(0.075, 0.36, 0.43), day);
  vec3 heatCol = mix(vec3(0.45, 0.16, 1.0), vec3(1.0, 0.24, 0.66), smoothstep(0.3, 1.0, heat));
  float pulse = 0.8 + 0.2 * sin(uTime * 2.4 - cid);
  dotCol = mix(dotCol, heatCol * 0.9 * pulse, smoothstep(0.02, 0.9, heat));
  dotCol += vec3(0.35, 0.9, 1.0) * hot * 0.55;
  col += dotCol * dotCov;
  col += heatCol * heat * land * 0.06 * pulse;
  col += vec3(0.10, 0.45, 0.6) * land * (sel * 0.16 + hov * 0.08);

  // Coastline: crisp line plus a soft glow on both sides.
  float coast = 1.0 - smoothstep(0.0, sdW * 1.6 + 0.25, abs(sd));
  col += vec3(0.22, 0.80, 1.0) * coast * mix(0.32, 0.62, day);
  col += vec3(0.03, 0.18, 0.26) * exp(-abs(sd) * 0.35) * 0.22;

  // Land borders.
  float bd = textureGrad(uBorders, uv, dx, dy).r * BORDER_RANGE;
  float bdW = max(fwidth(bd), 1e-3);
  float border = (1.0 - smoothstep(0.25, 0.25 + bdW * 1.5, bd)) * land;
  col += vec3(0.30, 0.75, 1.0) * border * (0.16 + sel * 0.5 + hov * 0.25);

  // ── light ──
  col *= mix(0.55, 1.0, day);
  col += vec3(0.0, 0.006, 0.016) * day * (1.0 - land);
  float lights = textureGrad(uLights, uv, dx, dy).r;
  float night = smoothstep(0.08, -0.22, NdotL);
  col += vec3(1.0, 0.52, 0.20) * pow(lights, 1.9) * 1.05 * night;
  float tq = NdotL / 0.035;
  float term = exp(-tq * tq);
  col += vec3(0.85, 0.32, 0.12) * term * 0.010 * (0.4 + 0.6 * land);
  vec3 R = reflect(-uSun, n);
  float spec = pow(max(dot(R, V), 0.0), 90.0) * (1.0 - land) * step(0.0, NdotL);
  col += vec3(0.5, 0.75, 1.0) * spec * 0.22;

  // ── home radar: range rings every 10° and a rotating sweep ──
  if (uHasHome > 0.5) {
    float ang = acos(clamp(dot(n, uHome), -1.0, 1.0));
    float rr = ang / (PI / 18.0);
    float rw = max(fwidth(rr), 1e-4);
    float ring = (1.0 - smoothstep(0.0, rw * 1.3, abs(fract(rr + 0.5) - 0.5))) * smoothstep(4.5, 0.8, rr) * step(0.5, rr);
    col += vec3(0.25, 0.85, 1.0) * ring * 0.07;
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), uHome) + vec3(1e-5, 0.0, 0.0));
    vec3 north = cross(uHome, east);
    vec3 t = n - uHome * dot(n, uHome);
    float az = atan(dot(t, east), dot(t, north));
    float sweep = mod(uTime * 0.8, TAU) - PI;
    float behind = mod(sweep - az + TAU, TAU);
    float trail = exp(-behind * 2.2) * smoothstep(0.80, 0.05, ang);
    col += vec3(0.12, 0.9, 1.0) * trail * (0.05 + 0.10 * land);
  }

  // ── alert wash ──
  col += vec3(0.6, 0.02, 0.06) * uAlert * 0.05 * land;

  // ── limb: darken towards the edge, then atmosphere rim ──
  col *= mix(0.55, 1.0, sqrt(NdotV));
  float rim = pow(1.0 - NdotV, 4.0);
  vec3 atmo = mix(vec3(0.03, 0.09, 0.24), vec3(0.16, 0.50, 1.0), smoothstep(-0.25, 0.6, NdotL));
  col += atmo * rim * 0.62;

  outColor = vec4(col, 1.0);
}`;

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

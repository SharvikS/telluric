// Loads the baked world data produced by tools/geogen: textures plus the
// country table. Also keeps a CPU copy of the country-id map for picking.

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

export async function loadWorld(base = 'assets/') {
  const manifest = await fetch(base + 'world.json').then((r) => {
    if (!r.ok) throw new Error(`world.json: HTTP ${r.status}`);
    return r.json();
  });
  const t = manifest.textures;
  const [land, borders, countries, lights] = await Promise.all([
    loadImage(base + t.land.file),
    loadImage(base + t.borders.file),
    loadImage(base + t.countries.file),
    loadImage(base + t.lights.file),
  ]);

  // CPU copy of country ids for hover/click picking.
  const cw = countries.width, ch = countries.height;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(countries, 0, 0);
  const rgba = ctx.getImageData(0, 0, cw, ch).data;
  const ids = new Uint8Array(cw * ch);
  for (let i = 0; i < ids.length; i++) ids[i] = rgba[i * 4];

  // A small land mask for the 2D minimap.
  const mm = document.createElement('canvas');
  mm.width = 720;
  mm.height = 360;
  const mctx = mm.getContext('2d', { willReadFrequently: true });
  mctx.drawImage(land, 0, 0, mm.width, mm.height);
  const md = mctx.getImageData(0, 0, mm.width, mm.height).data;
  const landMask = new Uint8Array(mm.width * mm.height);
  for (let i = 0; i < landMask.length; i++) landMask[i] = md[i * 4] > 127 ? 1 : 0;

  const byId = new Map();
  const byIso2 = new Map();
  for (const c of manifest.countries) {
    byId.set(c.id, c);
    if (c.iso2) byIso2.set(c.iso2, c);
  }

  return {
    manifest,
    images: { land, borders, countries, lights },
    countryIds: ids,
    countrySize: [cw, ch],
    landMask: { data: landMask, width: mm.width, height: mm.height },
    byId,
    byIso2,
    countryAt(lat, lon) {
      const x = Math.min(cw - 1, Math.max(0, Math.floor(((lon + 180) / 360) * cw)));
      const y = Math.min(ch - 1, Math.max(0, Math.floor(((90 - lat) / 180) * ch)));
      return ids[y * cw + x];
    },
  };
}

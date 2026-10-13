// Command geogen builds the globe's map textures from Natural Earth data.
//
// It downloads three public-domain Natural Earth layers (land, countries and
// populated places), rasterizes them onto an equirectangular grid with its own
// scanline polygon filler, and derives:
//
//	land.png       signed distance to the coastline (land positive)
//	borders.png    distance to the nearest land border between two countries
//	countries.png  country index per texel (sample with NEAREST filtering)
//	lights.png     procedural night lights splatted from city populations
//	world.json     texture encodings plus the country table
//
// Distances are computed with an exact Euclidean distance transform
// (Felzenszwalb & Huttenlocher) whose horizontal metric is scaled by
// cos(latitude) per row, so glows have the same width on the globe at every
// latitude, and which wraps around the antimeridian.
//
// Usage:
//
//	go run ./tools/geogen -out web/ui/assets
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/png"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const neBase = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"

// Texture encodings, mirrored in the shaders (web/ui/src/scene/globe.js).
const (
	landRangePx   = 16.0 // land.png: 127.5 ± landRangePx texels maps to 0..255
	borderRangePx = 8.0  // borders.png: 0..borderRangePx texels maps to 0..255
)

func main() {
	out := flag.String("out", "web/ui/assets", "output directory")
	cache := flag.String("cache", "tools/geogen/.cache", "download cache directory")
	width := flag.Int("width", 4096, "width of the land and border textures (height is width/2)")
	flag.Parse()
	log.SetFlags(0)

	if err := os.MkdirAll(*out, 0o755); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(*cache, 0o755); err != nil {
		log.Fatal(err)
	}

	land := mustLoad(*cache, "ne_50m_land")
	countries := mustLoad(*cache, "ne_50m_admin_0_countries")
	places := mustLoad(*cache, "ne_10m_populated_places_simple")

	W, H := *width, *width/2
	start := time.Now()

	// ── land signed distance field ──────────────────────────────────────────
	landMask := make([]bool, W*H)
	for _, f := range land.Features {
		for _, poly := range f.Polygons {
			fillPolygon(toPixels(poly, W, H), W, H, func(y, x0, x1 int) {
				row := landMask[y*W:]
				for x := x0; x < x1; x++ {
					row[x] = true
				}
			})
		}
	}
	ocean := make([]bool, W*H)
	for i, l := range landMask {
		ocean[i] = !l
	}
	dToOcean := edt(ocean, W, H)   // for land texels: distance to the sea
	dToLand := edt(landMask, W, H) // for sea texels: distance to land
	landImg := image.NewGray(image.Rect(0, 0, W, H))
	for i := range landMask {
		var sd float64
		if landMask[i] {
			sd = float64(dToOcean[i]) - 0.5
		} else {
			sd = -(float64(dToLand[i]) - 0.5)
		}
		landImg.Pix[i] = quantize(127.5 + clamp(sd, -landRangePx, landRangePx)*(127.5/landRangePx))
	}
	writePNG(filepath.Join(*out, "land.png"), landImg)
	log.Printf("land.png      %dx%d  (%s)", W, H, time.Since(start).Round(time.Millisecond))

	// ── country ids and land borders ────────────────────────────────────────
	type country struct {
		ID   int     `json:"id"`
		ISO2 string  `json:"iso2"`
		ISO3 string  `json:"iso3"`
		Name string  `json:"name"`
		Lat  float64 `json:"lat"`
		Lon  float64 `json:"lon"`
	}
	var table []country
	ids := make([]uint8, W*H)
	for i, f := range countries.Features {
		id := i + 1
		if id > 255 {
			log.Fatalf("too many countries for an 8-bit id map: %d", len(countries.Features))
		}
		iso2 := propString(f.Props, "ISO_A2")
		if iso2 == "-99" || iso2 == "" {
			iso2 = propString(f.Props, "ISO_A2_EH")
		}
		if iso2 == "-99" {
			iso2 = ""
		}
		iso3 := propString(f.Props, "ADM0_A3")
		table = append(table, country{
			ID: id, ISO2: iso2, ISO3: iso3,
			Name: propString(f.Props, "NAME"),
			Lat:  round4(propFloat(f.Props, "LABEL_Y")),
			Lon:  round4(propFloat(f.Props, "LABEL_X")),
		})
		for _, poly := range f.Polygons {
			fillPolygon(toPixels(poly, W, H), W, H, func(y, x0, x1 int) {
				row := ids[y*W:]
				for x := x0; x < x1; x++ {
					row[x] = uint8(id)
				}
			})
		}
	}

	border := make([]bool, W*H)
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			a := ids[y*W+x]
			if a == 0 {
				continue
			}
			r := ids[y*W+(x+1)%W]
			if r != 0 && r != a {
				border[y*W+x] = true
			}
			if y+1 < H {
				d := ids[(y+1)*W+x]
				if d != 0 && d != a {
					border[y*W+x] = true
				}
			}
		}
	}
	dBorder := edt(border, W, H)
	borderImg := image.NewGray(image.Rect(0, 0, W, H))
	for i, d := range dBorder {
		borderImg.Pix[i] = quantize(clamp(float64(d), 0, borderRangePx) * (255 / borderRangePx))
	}
	writePNG(filepath.Join(*out, "borders.png"), borderImg)
	log.Printf("borders.png   %dx%d  (%s)", W, H, time.Since(start).Round(time.Millisecond))

	// Country ids at half resolution: plenty for picking and choropleth.
	cw, ch := W/2, H/2
	idImg := image.NewGray(image.Rect(0, 0, cw, ch))
	for y := 0; y < ch; y++ {
		for x := 0; x < cw; x++ {
			idImg.Pix[y*cw+x] = majority4(ids, W, 2*x, 2*y)
		}
	}
	writePNG(filepath.Join(*out, "countries.png"), idImg)
	log.Printf("countries.png %dx%d  (%d countries)", cw, ch, len(table))

	// ── night lights ────────────────────────────────────────────────────────
	lw, lh := W/2, H/2
	acc := make([]float64, lw*lh)
	rng := newRand(0x7e11)
	for _, f := range places.Features {
		lat, lon := propFloat(f.Props, "latitude"), propFloat(f.Props, "longitude")
		pop := math.Max(propFloat(f.Props, "pop_max"), 1000)
		mag := clamp((math.Log10(pop)-3.3)/4.0, 0.04, 1.2)
		sigma := clamp(0.55+0.9*(math.Log10(pop)-4.0), 0.55, 3.6)
		cx, cy := (lon+180)/360*float64(lw), (90-lat)/180*float64(lh)
		splat(acc, lw, lh, cx, cy, sigma, mag)
		// Satellite towns and suburbs: a deterministic scatter around large
		// cities gives the lights an organic, clustered texture.
		n := int(math.Min(pop/180_000, 40))
		for k := 0; k < n; k++ {
			ang := rng.float() * 2 * math.Pi
			r := sigma * (0.6 + 2.6*math.Sqrt(rng.float()))
			ox := math.Cos(ang) * r / math.Max(math.Cos(lat*math.Pi/180), 0.2)
			oy := math.Sin(ang) * r
			splat(acc, lw, lh, cx+ox, cy+oy, 0.5+0.4*rng.float(), mag*(0.15+0.25*rng.float()))
		}
	}
	lightsImg := image.NewGray(image.Rect(0, 0, lw, lh))
	for y := 0; y < lh; y++ {
		for x := 0; x < lw; x++ {
			v := 1 - math.Exp(-acc[y*lw+x]*1.6)
			// Fade lights that spill far out over the sea.
			if !landMask[(2*y)*W+2*x] {
				v *= 0.35
			}
			lightsImg.Pix[y*lw+x] = quantize(math.Pow(v, 0.8) * 255)
		}
	}
	writePNG(filepath.Join(*out, "lights.png"), lightsImg)
	log.Printf("lights.png    %dx%d  (%d places)", lw, lh, len(places.Features))

	// ── manifest ────────────────────────────────────────────────────────────
	manifest := map[string]any{
		"version":    1,
		"source":     "Natural Earth (public domain) — ne_50m_land, ne_50m_admin_0_countries, ne_10m_populated_places_simple",
		"projection": "equirectangular: u = (lon + 180) / 360, v = (90 - lat) / 180",
		"textures": map[string]any{
			"land":      map[string]any{"file": "land.png", "width": W, "height": H, "encoding": "signed distance to coast in texels: (value - 127.5) / 127.5 * rangePx, land positive", "rangePx": landRangePx},
			"borders":   map[string]any{"file": "borders.png", "width": W, "height": H, "encoding": "distance to nearest land border in texels: value / 255 * rangePx", "rangePx": borderRangePx},
			"countries": map[string]any{"file": "countries.png", "width": cw, "height": ch, "encoding": "country id (0 = none); sample with NEAREST"},
			"lights":    map[string]any{"file": "lights.png", "width": lw, "height": lh, "encoding": "night light intensity, 0..255"},
		},
		"countries": table,
	}
	b, err := json.Marshal(manifest)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(*out, "world.json"), b, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("world.json    %d bytes; total %s", len(b), time.Since(start).Round(time.Millisecond))
}

// ── GeoJSON ─────────────────────────────────────────────────────────────────

type feature struct {
	Props    map[string]any
	Polygons [][][][2]float64 // polygon → ring → point (lon, lat)
}

type collection struct{ Features []feature }

func mustLoad(cacheDir, name string) collection {
	path := filepath.Join(cacheDir, name+".geojson")
	if _, err := os.Stat(path); err != nil {
		log.Printf("downloading %s…", name)
		if err := download(neBase+name+".geojson", path); err != nil {
			log.Fatalf("download %s: %v", name, err)
		}
	}
	f, err := os.Open(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	var raw struct {
		Features []struct {
			Properties map[string]any `json:"properties"`
			Geometry   *struct {
				Type        string          `json:"type"`
				Coordinates json.RawMessage `json:"coordinates"`
			} `json:"geometry"`
		} `json:"features"`
	}
	if err := json.NewDecoder(f).Decode(&raw); err != nil {
		log.Fatalf("%s: %v", name, err)
	}
	var c collection
	for _, rf := range raw.Features {
		ft := feature{Props: rf.Properties}
		if g := rf.Geometry; g != nil {
			switch g.Type {
			case "Polygon":
				var p [][][]float64
				if err := json.Unmarshal(g.Coordinates, &p); err != nil {
					log.Fatalf("%s: %v", name, err)
				}
				ft.Polygons = append(ft.Polygons, rings(p))
			case "MultiPolygon":
				var mp [][][][]float64
				if err := json.Unmarshal(g.Coordinates, &mp); err != nil {
					log.Fatalf("%s: %v", name, err)
				}
				for _, p := range mp {
					ft.Polygons = append(ft.Polygons, rings(p))
				}
			}
		}
		c.Features = append(c.Features, ft)
	}
	return c
}

func rings(p [][][]float64) [][][2]float64 {
	out := make([][][2]float64, 0, len(p))
	for _, ring := range p {
		r := make([][2]float64, 0, len(ring))
		for _, pt := range ring {
			if len(pt) >= 2 {
				r = append(r, [2]float64{pt[0], pt[1]})
			}
		}
		out = append(out, r)
	}
	return out
}

func download(url, path string) error {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "telluric-geogen (+https://github.com/SharvikS/telluric)")
	resp, err := (&http.Client{Timeout: 2 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %s", resp.Status)
	}
	tmp := path + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func propString(p map[string]any, k string) string {
	if v, ok := p[k].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func propFloat(p map[string]any, k string) float64 {
	switch v := p[k].(type) {
	case float64:
		return v
	case string:
		var f float64
		fmt.Sscan(v, &f)
		return f
	}
	return 0
}

// ── rasterization ───────────────────────────────────────────────────────────

type pt struct{ x, y float64 }

func toPixels(poly [][][2]float64, W, H int) [][]pt {
	out := make([][]pt, len(poly))
	for i, ring := range poly {
		r := make([]pt, len(ring))
		for j, c := range ring {
			r[j] = pt{(c[0] + 180) / 360 * float64(W), (90 - c[1]) / 180 * float64(H)}
		}
		out[i] = r
	}
	return out
}

type edge struct {
	yMin, yMax float64 // yMin < yMax
	x, dxdy    float64 // x at yMin, slope
}

// fillPolygon rasterizes a polygon (outer ring plus holes) with the even-odd
// rule, sampling at texel centers. It calls span(y, x0, x1) for every run of
// covered texels [x0, x1) on row y. It maintains an active edge table, so the
// cost is proportional to edges crossing each scanline, not all edges.
func fillPolygon(rings [][]pt, W, H int, span func(y, x0, x1 int)) {
	var edges []edge
	for _, r := range rings {
		n := len(r)
		for i := 0; i < n; i++ {
			a, b := r[i], r[(i+1)%n]
			if a.y == b.y {
				continue
			}
			if a.y > b.y {
				a, b = b, a
			}
			edges = append(edges, edge{yMin: a.y, yMax: b.y, x: a.x, dxdy: (b.x - a.x) / (b.y - a.y)})
		}
	}
	if len(edges) == 0 {
		return
	}
	sort.Slice(edges, func(i, j int) bool { return edges[i].yMin < edges[j].yMin })
	y0 := int(math.Max(0, math.Floor(edges[0].yMin)))
	var active []int
	next := 0
	xs := make([]float64, 0, 64)
	for y := y0; y < H; y++ {
		yc := float64(y) + 0.5
		for next < len(edges) && edges[next].yMin <= yc {
			active = append(active, next)
			next++
		}
		// Drop finished edges.
		k := 0
		for _, e := range active {
			if edges[e].yMax > yc {
				active[k] = e
				k++
			}
		}
		active = active[:k]
		if len(active) == 0 {
			if next >= len(edges) {
				return
			}
			continue
		}
		xs = xs[:0]
		for _, e := range active {
			ed := &edges[e]
			if ed.yMin <= yc && yc < ed.yMax {
				xs = append(xs, ed.x+(yc-ed.yMin)*ed.dxdy)
			}
		}
		sort.Float64s(xs)
		for i := 0; i+1 < len(xs); i += 2 {
			x0 := int(math.Ceil(xs[i] - 0.5))
			x1 := int(math.Ceil(xs[i+1] - 0.5))
			if x0 < 0 {
				x0 = 0
			}
			if x1 > W {
				x1 = W
			}
			if x1 > x0 {
				span(y, x0, x1)
			}
		}
	}
}

func majority4(ids []uint8, W, x, y int) uint8 {
	c := [4]uint8{ids[y*W+x], ids[y*W+x+1], ids[(y+1)*W+x], ids[(y+1)*W+x+1]}
	best, bestN := c[0], 0
	for i := 0; i < 4; i++ {
		n := 0
		for j := 0; j < 4; j++ {
			if c[j] == c[i] {
				n++
			}
		}
		if n > bestN || (n == bestN && best == 0 && c[i] != 0) {
			best, bestN = c[i], n
		}
	}
	return best
}

// ── distance transform ──────────────────────────────────────────────────────

const inf = 1e20

// edt returns, for every texel, the Euclidean distance (in texel-height units)
// to the nearest feature texel. Horizontal distances are scaled by the cosine
// of the row's latitude, and rows wrap around the antimeridian.
func edt(feature []bool, W, H int) []float32 {
	g := make([]float64, W*H) // column pass result, stored row-major

	// Pass 1: columns (pure latitude distance).
	f := make([]float64, H)
	d := make([]float64, H)
	v := make([]int, H)
	z := make([]float64, H+1)
	for x := 0; x < W; x++ {
		for y := 0; y < H; y++ {
			if feature[y*W+x] {
				f[y] = 0
			} else {
				f[y] = inf
			}
		}
		dt1(f, d, v, z, 1)
		for y := 0; y < H; y++ {
			g[y*W+x] = d[y]
		}
	}

	// Pass 2: rows, with the per-row horizontal metric and wrap-around.
	const pad = 96
	n := W + 2*pad
	fr := make([]float64, n)
	dr := make([]float64, n)
	vr := make([]int, n)
	zr := make([]float64, n+1)
	out := make([]float32, W*H)
	for y := 0; y < H; y++ {
		lat := (0.5 - (float64(y)+0.5)/float64(H)) * math.Pi
		c := math.Max(math.Cos(lat), 1e-3)
		row := g[y*W : (y+1)*W]
		for i := 0; i < n; i++ {
			fr[i] = row[((i-pad)%W+W)%W]
		}
		dt1(fr, dr, vr, zr, c*c)
		for x := 0; x < W; x++ {
			out[y*W+x] = float32(math.Sqrt(math.Min(dr[x+pad], inf)))
		}
	}
	return out
}

// dt1 is the 1-D squared distance transform of Felzenszwalb & Huttenlocher:
// d[q] = min_p ( w2·(q−p)² + f[p] ), computed as the lower envelope of
// parabolas in O(n).
func dt1(f, d []float64, v []int, z []float64, w2 float64) {
	n := len(f)
	k := 0
	v[0] = 0
	z[0] = math.Inf(-1)
	z[1] = math.Inf(1)
	for q := 1; q < n; q++ {
		fq := f[q] + w2*float64(q*q)
		s := (fq - (f[v[k]] + w2*float64(v[k]*v[k]))) / (2 * w2 * float64(q-v[k]))
		for s <= z[k] {
			k--
			s = (fq - (f[v[k]] + w2*float64(v[k]*v[k]))) / (2 * w2 * float64(q-v[k]))
		}
		k++
		v[k] = q
		z[k] = s
		z[k+1] = math.Inf(1)
	}
	k = 0
	for q := 0; q < n; q++ {
		for z[k+1] < float64(q) {
			k++
		}
		dq := float64(q - v[k])
		d[q] = w2*dq*dq + f[v[k]]
	}
}

// ── lights ──────────────────────────────────────────────────────────────────

func splat(acc []float64, W, H int, cx, cy, sigma, mag float64) {
	r := int(math.Ceil(sigma * 3))
	inv := 1 / (2 * sigma * sigma)
	for dy := -r; dy <= r; dy++ {
		y := int(math.Floor(cy)) + dy
		if y < 0 || y >= H {
			continue
		}
		fy := float64(y) + 0.5 - cy
		for dx := -r; dx <= r; dx++ {
			xi := int(math.Floor(cx)) + dx
			fx := float64(xi) + 0.5 - cx
			x := ((xi % W) + W) % W
			acc[y*W+x] += mag * math.Exp(-(fx*fx+fy*fy)*inv)
		}
	}
}

type xorshift struct{ s uint64 }

func newRand(seed uint64) *xorshift { return &xorshift{seed} }

func (r *xorshift) float() float64 {
	r.s ^= r.s << 13
	r.s ^= r.s >> 7
	r.s ^= r.s << 17
	return float64(r.s>>11) / float64(1<<53)
}

// ── helpers ─────────────────────────────────────────────────────────────────

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

func quantize(v float64) uint8 { return uint8(clamp(math.Round(v), 0, 255)) }

func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }

func writePNG(path string, img image.Image) {
	f, err := os.Create(path)
	if err != nil {
		log.Fatal(err)
	}
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(f, img); err != nil {
		log.Fatal(err)
	}
	if err := f.Close(); err != nil {
		log.Fatal(err)
	}
}

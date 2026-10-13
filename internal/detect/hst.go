package detect

import (
	"math"
	"math/rand/v2"
	"slices"

	"github.com/SharvikS/telluric/internal/event"
)

// hsTrees is a streaming anomaly detector: Half-Space Trees (Tan, Ting &
// Liu, "Fast Anomaly Detection for Streaming Data", IJCAI 2011).
//
// Each tree recursively halves a randomly perturbed copy of the unit
// feature cube along random dimensions, without looking at any data. Data
// only ever updates mass counters: the "latest" window counts where new
// points fall, and when a window fills it becomes the "reference" profile.
// A point's score is the reference mass of the deepest node it reaches,
// scaled by 2^depth; points in sparse regions score low. Memory and time
// per point are constant — ideal for a capture loop that never ends.
type hsTrees struct {
	trees   []hsTree
	depth   int
	window  int
	seen    int // points in the current window
	windows int // completed windows
	limit   float32
	history []float64 // recent raw scores, to turn a score into a rank
	hpos    int
}

type hsTree struct {
	dim   []uint8   // split dimension per internal node
	split []float64 // split point per internal node
	ref   []float32 // reference mass per node (internal and leaves)
	lat   []float32 // latest-window mass per node
}

func newHSTrees(nTrees, depth, window, dims int, seed uint64) *hsTrees {
	rng := rand.New(rand.NewPCG(seed, seed*0x9e3779b97f4a7c15))
	h := &hsTrees{depth: depth, window: window, limit: float32(window) / 64}
	internal := 1<<depth - 1
	nodes := 1<<(depth+1) - 1
	for range nTrees {
		t := hsTree{
			dim: make([]uint8, internal), split: make([]float64, internal),
			ref: make([]float32, nodes), lat: make([]float32, nodes),
		}
		// Work space: each dimension's range is a random window around
		// [0, 1] (the paper's perturbation), so trees disagree usefully.
		lo, hi := make([]float64, dims), make([]float64, dims)
		for q := range dims {
			s := rng.Float64()
			r := 2 * math.Max(s, 1-s)
			lo[q], hi[q] = s-r, s+r
		}
		var build func(node int, lo, hi []float64)
		build = func(node int, lo, hi []float64) {
			if node >= internal {
				return
			}
			q := rng.IntN(dims)
			mid := (lo[q] + hi[q]) / 2
			t.dim[node], t.split[node] = uint8(q), mid
			l, r := slices.Clone(hi), slices.Clone(lo)
			l[q], r[q] = mid, mid
			build(2*node+1, lo, l)
			build(2*node+2, r, hi)
		}
		build(0, lo, hi)
		h.trees = append(h.trees, t)
	}
	return h
}

// update scores x against the reference profile, then records it. It
// returns the fraction of recent points that looked more normal than x
// (1 = the strangest thing seen lately) once the model has a reference.
func (h *hsTrees) update(x []float64) (float64, bool) {
	var raw float64
	internal := len(h.trees[0].dim)
	for i := range h.trees {
		t := &h.trees[i]
		node, depth, scored := 0, 0, false
		for {
			t.lat[node]++
			if !scored && (node >= internal || t.ref[node] < h.limit && h.windows > 0) {
				raw += float64(t.ref[node]) * math.Exp2(float64(depth))
				scored = true
			}
			if node >= internal {
				break
			}
			if x[t.dim[node]] < t.split[node] {
				node = 2*node + 1
			} else {
				node = 2*node + 2
			}
			depth++
		}
	}
	if h.seen++; h.seen >= h.window {
		for i := range h.trees {
			t := &h.trees[i]
			copy(t.ref, t.lat)
			clear(t.lat)
		}
		h.seen = 0
		h.windows++
	}
	if h.windows < 2 {
		return 0, false
	}
	rank := 0
	for _, s := range h.history {
		if s > raw {
			rank++
		}
	}
	n := len(h.history)
	if n < 512 {
		h.history = append(h.history, raw)
	} else {
		h.history[h.hpos] = raw
		h.hpos = (h.hpos + 1) % n
	}
	if n < 128 {
		return 0, false
	}
	return float64(rank) / float64(n), true
}

// flowFeatures maps a finished flow into the unit cube.
func flowFeatures(f *event.Flow) []float64 {
	lg := func(v float64) float64 { return math.Log10(1 + v) }
	clamp := func(v float64) float64 { return math.Max(0, math.Min(1, v)) }
	out, in := float64(f.BytesOut), float64(f.BytesIn)
	avgOut := 0.0
	if f.PktsOut > 0 {
		avgOut = out / float64(f.PktsOut)
	}
	port := float64(f.Remote.Port())
	portClass := 0.9
	switch {
	case port == 443 || port == 80:
		portClass = 0.1
	case port < 1024:
		portClass = 0.35
	case port < 49152:
		portClass = 0.65
	}
	return []float64{
		clamp(lg(out) / 10),
		clamp(lg(in) / 10),
		clamp(lg(float64(f.Last-f.First)/1e9) / 5),
		clamp((lg(out) - lg(in) + 10) / 20),
		portClass,
		clamp(avgOut / 1600),
		clamp(f.RTT / 600),
	}
}

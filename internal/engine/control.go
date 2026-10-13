package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"sort"
	"syscall"
	"time"

	"github.com/SharvikS/telluric/internal/buildinfo"
	"github.com/SharvikS/telluric/internal/wire"
)

// Control queues a client command (alert workflow). It never blocks.
func (e *Engine) Control(c wire.Command) {
	select {
	case e.controlCh <- c:
	default:
	}
}

// applyControl runs a client command on the engine goroutine.
func (e *Engine) applyControl(c wire.Command) {
	i := e.alertIndex(c.ID)
	if i < 0 {
		return
	}
	a := &e.alerts[i]
	key := e.alertKeyOf(a.ID)
	now := e.now / 1e6
	switch c.T {
	case "alert.ack":
		if a.State != wire.AlertOpen {
			return
		}
		a.State = wire.AlertAcknowledged
	case "alert.resolve":
		a.State = wire.AlertResolved
	case "alert.reopen":
		a.State = wire.AlertOpen
	case "alert.mute":
		if key == "" || a.Muted {
			return
		}
		a.Muted = true
		e.mutes.set(key, now)
	case "alert.unmute":
		if !a.Muted {
			return
		}
		a.Muted = false
		e.mutes.remove(key)
	default:
		return
	}
	a.StateTS = now
	e.alertQ = append(e.alertQ, *a)
}

func (e *Engine) alertKeyOf(id uint32) string {
	for k, ref := range e.alertKeys {
		if ref.id == id {
			return k
		}
	}
	return ""
}

// muteStore remembers muted alert keys, optionally persisted as JSON so
// suppressions survive restarts.
type muteStore struct {
	path string
	keys map[string]int64 // key → muted at (Unix ms)
}

func newMuteStore(path string) *muteStore {
	m := &muteStore{path: path, keys: map[string]int64{}}
	if path != "" {
		if b, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(b, &m.keys)
		}
	}
	return m
}

func (m *muteStore) has(key string) bool {
	_, ok := m.keys[key]
	return ok && key != ""
}

func (m *muteStore) set(key string, at int64) {
	m.keys[key] = at
	m.save()
}

func (m *muteStore) remove(key string) {
	delete(m.keys, key)
	m.save()
}

func (m *muteStore) save() {
	if m.path == "" {
		return
	}
	b, err := json.MarshalIndent(m.keys, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(m.path), 0o755)
	tmp := m.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, m.path)
	}
}

// statusSampler measures the engine process between status reports.
type statusSampler struct {
	lastWall   time.Time
	lastCPU    time.Duration
	lastFrames uint64
	cpu        float64
	framesPS   float64
}

func cpuTime() time.Duration {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
}

func (s *statusSampler) sample(frames uint64) {
	now, cpu := time.Now(), cpuTime()
	if !s.lastWall.IsZero() {
		if wall := now.Sub(s.lastWall); wall > 0 {
			s.cpu = 100 * float64(cpu-s.lastCPU) / float64(wall)
			s.framesPS = float64(frames-s.lastFrames) / wall.Seconds()
		}
	}
	s.lastWall, s.lastCPU, s.lastFrames = now, cpu, frames
}

var heapSample = []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}

func heapMB() float64 {
	metrics.Read(heapSample)
	if heapSample[0].Value.Kind() == metrics.KindUint64 {
		return float64(heapSample[0].Value.Uint64()) / (1 << 20)
	}
	return 0
}

// status assembles the engine's health report.
func (e *Engine) status() wire.Status {
	e.sampler.sample(e.frames.Load())
	cs := e.cfg.Source.Stats()
	st := wire.Status{
		TS:      e.now / 1e6,
		Version: buildinfo.Version,
		Mode:    e.cfg.Mode,
		Started: e.started.UnixMilli(),
		Uptime:  round(time.Since(e.started).Seconds(), 1),
		Capture: wire.CaptureStatus{Source: e.cfg.Source.Name(), Received: cs.Received, Dropped: cs.Dropped, PPS: round(e.stats.pps, 0)},
		Engine: wire.EngineStatus{
			CPU: round(e.sampler.cpu, 1), HeapMB: round(heapMB(), 1), Goroutines: runtime.NumGoroutine(),
			Flows: len(e.flows), Endpoints: len(e.eps), Procs: len(e.procs), FramesPS: round(e.sampler.framesPS, 0),
		},
		Clients: len(e.clients),
		Mutes:   len(e.mutes.keys),
		Sources: []wire.DataSource{},
	}
	if e.cfg.Sources != nil {
		st.Sources = e.cfg.Sources()
	}
	sort.Slice(st.Sources, func(i, j int) bool { return st.Sources[i].Kind < st.Sources[j].Kind })
	for _, src := range st.Sources {
		if !src.OK {
			st.Warnings = append(st.Warnings, src.Name+": "+src.Detail)
		}
	}
	if cs.Dropped > e.lastDrops {
		st.Warnings = append(st.Warnings, "the capture is dropping packets: the engine cannot keep up")
	}
	e.lastDrops = cs.Dropped
	return st
}

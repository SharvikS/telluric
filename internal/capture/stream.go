package capture

import (
	"io"
	"sync"
	"sync/atomic"
	"time"
)

// StreamOptions control how a pcap/pcapng stream is delivered.
type StreamOptions struct {
	// Name labels the source ("replay:file.pcap", "helper", "dumpcap").
	Name string
	// Realtime paces frames by their capture timestamps (for replays).
	Realtime bool
	// Speed multiplies the pacing rate; 0 means 1.
	Speed float64
	// Rebase shifts timestamps so the first frame happened "now", which
	// makes a replay indistinguishable from live traffic downstream.
	Rebase bool
	// Closer is closed by Close, e.g. the helper process's stdout.
	Closer io.Closer
}

// Stream is a Source fed by a pcap or pcapng byte stream. A goroutine
// decodes records into batches; Read hands whole batches to the consumer.
type Stream struct {
	opt     StreamOptions
	rd      *Reader
	batches chan *batch
	free    chan *batch
	done    chan struct{}
	once    sync.Once
	timer   *time.Timer

	mu  sync.Mutex
	err error

	received atomic.Uint64
	dropped  atomic.Uint64
	skipped  atomic.Uint64
}

type batch struct {
	frames []Frame
	ends   []int
	arena  []byte
}

const (
	batchFrames = 512
	batchBytes  = 1 << 20
	batchDepth  = 8
)

// NewStream starts decoding r in the background.
func NewStream(r io.Reader, opt StreamOptions) (*Stream, error) {
	rd, err := NewReader(r)
	if err != nil {
		return nil, err
	}
	if opt.Speed <= 0 {
		opt.Speed = 1
	}
	s := &Stream{
		opt:     opt,
		rd:      rd,
		batches: make(chan *batch, batchDepth),
		free:    make(chan *batch, batchDepth+2),
		done:    make(chan struct{}),
		timer:   time.NewTimer(time.Hour),
	}
	s.timer.Stop()
	go s.pump()
	return s, nil
}

// Name implements Source.
func (s *Stream) Name() string { return s.opt.Name }

// LinkType returns the link type of the underlying stream.
func (s *Stream) LinkType() uint32 { return s.rd.LinkType() }

func (s *Stream) getBatch() *batch {
	select {
	case b := <-s.free:
		b.frames, b.ends, b.arena = b.frames[:0], b.ends[:0], b.arena[:0]
		return b
	default:
		return &batch{
			frames: make([]Frame, 0, batchFrames),
			ends:   make([]int, 0, batchFrames),
			arena:  make([]byte, 0, batchBytes),
		}
	}
}

// send seals b (pointing every frame at its bytes in the arena) and queues it.
func (s *Stream) send(b *batch) bool {
	start := 0
	for i := range b.frames {
		b.frames[i].Data = b.arena[start:b.ends[i]:b.ends[i]]
		start = b.ends[i]
	}
	select {
	case s.batches <- b:
		return true
	case <-s.done:
		return false
	}
}

func (s *Stream) pump() {
	defer close(s.batches)
	var (
		f        Frame
		b        = s.getBatch()
		first    int64 // capture time of the first frame
		wallBase time.Time
		shift    int64
	)
	for {
		if len(b.frames) > 0 && (len(b.frames) >= batchFrames || len(b.arena) >= batchBytes || !s.rd.BufferedRecord()) {
			if !s.send(b) {
				return
			}
			b = s.getBatch()
		}
		if err := s.rd.Next(&f); err != nil {
			s.mu.Lock()
			s.err = err
			s.mu.Unlock()
			if len(b.frames) > 0 {
				s.send(b)
			}
			return
		}
		if first == 0 {
			first, wallBase = f.TS, time.Now()
			if s.opt.Rebase {
				shift = wallBase.UnixNano() - first
			}
		}
		if s.opt.Realtime {
			due := wallBase.Add(time.Duration(float64(f.TS-first) / s.opt.Speed))
			if wait := time.Until(due); wait > time.Millisecond {
				if len(b.frames) > 0 { // don't sit on frames while we sleep
					if !s.send(b) {
						return
					}
					b = s.getBatch()
				}
				select {
				case <-time.After(wait):
				case <-s.done:
					return
				}
			}
		}
		f.TS += shift
		b.arena = append(b.arena, f.Data...)
		f.Data = nil
		b.frames = append(b.frames, f)
		b.ends = append(b.ends, len(b.arena))
		if s.rd.IfDrop > s.dropped.Load() {
			s.dropped.Store(s.rd.IfDrop)
		}
		s.skipped.Store(s.rd.Skipped)
	}
}

// Read implements Source.
func (s *Stream) Read(timeout time.Duration, fn func(*Frame)) error {
	var b *batch
	var ok bool
	select {
	case b, ok = <-s.batches:
	default:
		s.timer.Reset(timeout)
		select {
		case b, ok = <-s.batches:
			s.timer.Stop()
		case <-s.timer.C:
			return nil
		case <-s.done:
			s.timer.Stop()
			return ErrClosed
		}
	}
	if !ok {
		select {
		case <-s.done:
			return ErrClosed
		default:
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.err
	}
	for i := range b.frames {
		fn(&b.frames[i])
	}
	s.received.Add(uint64(len(b.frames)))
	select {
	case s.free <- b:
	default:
	}
	return nil
}

// Stats implements Source.
func (s *Stream) Stats() Stats {
	return Stats{Received: s.received.Load(), Dropped: s.dropped.Load()}
}

// Skipped returns the number of records the reader could not use.
func (s *Stream) Skipped() uint64 { return s.skipped.Load() }

// Close implements Source.
func (s *Stream) Close() error {
	var err error
	s.once.Do(func() {
		close(s.done)
		if s.opt.Closer != nil {
			err = s.opt.Closer.Close()
		}
	})
	return err
}

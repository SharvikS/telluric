package engine

import "github.com/SharvikS/telluric/internal/wire"

// shotBatch collects packet shots for one 50 ms frame. Each flow gets a
// few individual shots per direction; beyond that, packets merge into the
// flow's last shot, so a gigabit download costs the browser the same as a
// trickle while still looking busier.
type shotBatch struct {
	base  int64 // ns
	shots []wire.Shot
	flows []*flow
}

const (
	maxShotsPerFlowDir = 4
	maxShotsPerBatch   = 2048
)

func (b *shotBatch) reset() {
	for _, fl := range b.flows {
		fl.shotIdx = [2]int32{-1, -1}
		fl.shotCnt = [2]uint8{}
	}
	clear(b.flows)
	b.flows = b.flows[:0]
	b.shots = b.shots[:0]
	b.base = 0
}

func (b *shotBatch) add(fl *flow, bytes uint32, inbound bool, ts int64) {
	d := 0
	if inbound {
		d = 1
	}
	if len(b.shots) == 0 {
		b.base = ts
	}
	if fl.shotIdx[0] < 0 && fl.shotIdx[1] < 0 {
		b.flows = append(b.flows, fl)
	}
	if fl.shotCnt[d] >= maxShotsPerFlowDir || len(b.shots) >= maxShotsPerBatch {
		if i := fl.shotIdx[d]; i >= 0 {
			s := &b.shots[i]
			s.Bytes = uint32(min(uint64(s.Bytes)+uint64(bytes), 1<<32-1))
			if s.Pkts < 255 {
				s.Pkts++
			}
			return
		}
		if len(b.shots) >= maxShotsPerBatch {
			return
		}
	}
	dt := max(0, min((ts-b.base)/1e6, 65535))
	fl.shotIdx[d] = int32(len(b.shots))
	fl.shotCnt[d]++
	b.shots = append(b.shots, wire.Shot{Flow: fl.id, Bytes: bytes, DT: uint16(dt), Pkts: 1, Inbound: inbound})
}

func (e *Engine) flushShots() {
	if len(e.shots.shots) == 0 {
		return
	}
	// A fresh buffer each time: client writers hold on to the frame.
	frame := wire.AppendPkts(make([]byte, 0, wire.PktsHeaderSize+wire.PktsRecordSize*len(e.shots.shots)),
		float64(e.shots.base)/1e6, e.shots.shots)
	e.broadcast(frame, false, true)
	e.shots.reset()
}

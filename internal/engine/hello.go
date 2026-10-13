package engine

import (
	"sync"

	"github.com/SharvikS/telluric/internal/decode"
)

// helloState accumulates the start of a flow until its ClientHello parses.
type helloState struct {
	asm      *decode.Assembler
	base     uint32 // TCP sequence number of stream offset 0
	haveBase bool
	keys     *decode.InitialKeys
	scratch  []byte
	plain    []byte
	tries    int
}

const maxHelloTries = 8

var asmPool = sync.Pool{New: func() any { return decode.NewAssembler(16 << 10) }}

func (e *Engine) releaseHello(fl *flow) {
	if fl.hello != nil {
		asmPool.Put(fl.hello.asm)
		fl.hello = nil
	}
}

// feedHello adds one client payload to the flow's ClientHello reassembly.
func (e *Engine) feedHello(fl *flow, p *decode.Packet) {
	h := fl.hello
	if h == nil {
		h = &helloState{asm: asmPool.Get().(*decode.Assembler)}
		h.asm.Reset()
		fl.hello = h
	}
	h.tries++
	if fl.key.proto == decode.ProtoTCP {
		if !h.haveBase {
			// Anchor at the true stream start when the handshake was seen;
			// otherwise at the first payload, rebasing if earlier data shows up.
			h.base, h.haveBase = p.Seq, true
			if fl.haveISN {
				h.base = fl.isn + 1
			}
		}
		off := int(int32(p.Seq - h.base))
		if off < 0 { // an earlier segment than the first we saw: rebase
			old := append([]byte(nil), h.asm.Prefix()...)
			h.asm.Reset()
			h.base = p.Seq
			h.asm.Add(-off, old)
			off = 0
		}
		h.asm.Add(off, p.Payload)
		hs, scratch, err := decode.TLSHandshake(h.asm.Prefix(), h.scratch)
		h.scratch = scratch
		switch err {
		case nil:
			e.hello.QUIC = false
			if e.hello.Parse(hs) == nil {
				e.onHello(fl)
			}
			e.releaseHello(fl)
		case decode.ErrTruncated:
			if h.tries >= maxHelloTries || h.asm.Full() {
				e.releaseHello(fl)
			}
		default:
			// Not TLS — certain when we know where the stream starts; without
			// the handshake we may just be looking at a middle segment.
			if fl.haveISN || h.tries >= maxHelloTries {
				e.releaseHello(fl)
			}
		}
		return
	}

	// QUIC: decrypt Initial packets with keys derived from the client's
	// first Destination Connection ID, collect CRYPTO frames.
	if h.keys == nil {
		hdr, err := decode.ParseQUICLongHeader(p.Payload)
		if err != nil || hdr.Type != 0 {
			if h.tries >= 4 {
				e.releaseHello(fl)
			}
			return
		}
		if h.keys, err = decode.NewInitialKeys(hdr.Version, hdr.DCID); err != nil {
			e.releaseHello(fl)
			return
		}
	}
	plain, _, _, err := h.keys.Open(h.plain[:0], p.Payload)
	if err != nil {
		if h.tries >= 4 {
			e.releaseHello(fl)
		}
		return
	}
	h.plain = plain
	_ = decode.QUICCryptoFrames(plain, func(off uint64, data []byte) {
		if off < 1<<20 {
			h.asm.Add(int(off), data)
		}
	})
	prefix := h.asm.Prefix()
	if n := decode.HandshakeLen(prefix); n > 0 && len(prefix) >= n {
		e.hello.QUIC = true
		if e.hello.Parse(prefix[:n]) == nil {
			e.onHello(fl)
		}
		e.releaseHello(fl)
	} else if h.tries >= maxHelloTries {
		e.releaseHello(fl)
	}
}

func (e *Engine) onHello(fl *flow) {
	ch := &e.hello
	fl.sni = string(ch.SNI)
	fl.alpn = string(ch.ALPN)
	fl.tlsv = ch.Version
	fl.ja4 = ch.JA4()
	fl.ech = ch.ECH
	fl.pq = ch.PQ
	fl.dirty = true
	if dohNames[fl.sni] {
		fl.app = AppDoH
	}
	if fl.sni != "" {
		src := nameSNI
		if ch.ECH {
			src = nameRDNS // with ECH the visible SNI is only the provider's public name
		}
		e.setName(fl.ep, fl.sni, src)
	}
	if e.cfg.Observer != nil {
		e.cfg.Observer.FlowUpdate(e.now, e.view(fl))
	}
}

package decode

// Assembler rebuilds the first bytes of a byte stream from pieces that may
// arrive out of order, overlap or repeat: the TCP segments of a ClientHello,
// or the CRYPTO frames that browsers deliberately split and shuffle inside
// QUIC Initial packets. Only the first Limit bytes are kept.
type Assembler struct {
	buf    []byte
	filled []uint64 // bitmap of bytes received
	prefix int      // length of the contiguous prefix
	limit  int
}

// NewAssembler returns an assembler keeping at most limit bytes.
func NewAssembler(limit int) *Assembler {
	return &Assembler{limit: limit, filled: make([]uint64, (limit+63)/64)}
}

// Reset empties the assembler for reuse.
func (a *Assembler) Reset() {
	a.buf = a.buf[:0]
	clear(a.filled)
	a.prefix = 0
}

// Add places data at stream offset off. Bytes beyond the limit are dropped.
func (a *Assembler) Add(off int, data []byte) {
	if off < 0 || off >= a.limit || len(data) == 0 {
		return
	}
	end := min(off+len(data), a.limit)
	if end > len(a.buf) {
		if end > cap(a.buf) {
			nb := make([]byte, end, min(a.limit, max(2*cap(a.buf), end, 2048)))
			copy(nb, a.buf)
			a.buf = nb
		} else {
			a.buf = a.buf[:end]
		}
	}
	copy(a.buf[off:end], data)
	for i := off; i < end; i++ {
		a.filled[i>>6] |= 1 << (i & 63)
	}
	for a.prefix < len(a.buf) && a.filled[a.prefix>>6]&(1<<(a.prefix&63)) != 0 {
		a.prefix++
	}
}

// Prefix returns the contiguous bytes received so far, starting at offset 0.
func (a *Assembler) Prefix() []byte { return a.buf[:a.prefix] }

// Full reports whether the limit has been reached.
func (a *Assembler) Full() bool { return a.prefix >= a.limit }

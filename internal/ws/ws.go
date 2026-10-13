// Package ws is a small RFC 6455 WebSocket server: the opening handshake,
// framing (with fragmentation and masking), ping/pong and the closing
// handshake. Writes go through a per-connection queue with two lanes:
// state frames are never dropped, while droppable frames (animation data)
// are shed when a client falls behind.
package ws

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Opcodes.
const (
	OpContinuation = 0x0
	OpText         = 0x1
	OpBinary       = 0x2
	OpClose        = 0x8
	OpPing         = 0x9
	OpPong         = 0xa
)

// Close status codes.
const (
	CloseNormal         = 1000
	CloseGoingAway      = 1001
	CloseProtocolError  = 1002
	CloseUnsupported    = 1003
	CloseTooBig         = 1009
	ClosePolicyViolated = 1008
)

const acceptGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

var (
	// ErrHandshake means the request was not a valid WebSocket upgrade.
	ErrHandshake = errors.New("ws: bad handshake")
	// ErrClosed is returned after the connection closed.
	ErrClosed   = errors.New("ws: connection closed")
	errProtocol = errors.New("ws: protocol error")
)

// AcceptKey computes Sec-WebSocket-Accept for a Sec-WebSocket-Key.
func AcceptKey(key string) string {
	h := sha1.Sum([]byte(key + acceptGUID))
	return base64.StdEncoding.EncodeToString(h[:])
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for t := range strings.SplitSeq(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return true
			}
		}
	}
	return false
}

// Options configure a connection.
type Options struct {
	MaxMessage   int64         // largest accepted client message (default 64 KiB)
	QueueState   int           // state-lane depth before the client is considered dead (default 4096)
	QueueDrop    int           // droppable-lane depth (default 64)
	WriteTimeout time.Duration // per-frame write deadline (default 10 s)
	PingEvery    time.Duration // keepalive interval (default 20 s)
}

// Conn is a server-side WebSocket connection.
type Conn struct {
	opt  Options
	nc   net.Conn
	br   *bufio.Reader
	bw   *bufio.Writer
	wmu  sync.Mutex // serializes frame writes
	once sync.Once
	done chan struct{}

	qmu     sync.Mutex
	state   [][]byte
	stateT  []bool
	drop    [][]byte
	dropT   []bool
	signal  chan struct{}
	dropped uint64
}

// Upgrade performs the server side of the opening handshake (RFC 6455 §4.2).
// The caller is responsible for authorization and Origin checks first.
func Upgrade(w http.ResponseWriter, r *http.Request, opt Options) (*Conn, error) {
	if r.Method != http.MethodGet ||
		!headerHasToken(r.Header, "Connection", "upgrade") ||
		!headerHasToken(r.Header, "Upgrade", "websocket") ||
		r.Header.Get("Sec-WebSocket-Version") != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		http.Error(w, "websocket upgrade required", http.StatusUpgradeRequired)
		return nil, ErrHandshake
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if raw, err := base64.StdEncoding.DecodeString(key); err != nil || len(raw) != 16 {
		http.Error(w, "bad Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, ErrHandshake
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "cannot hijack", http.StatusInternalServerError)
		return nil, ErrHandshake
	}
	nc, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + AcceptKey(key) + "\r\n\r\n"
	if _, err := rw.WriteString(resp); err != nil {
		nc.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		nc.Close()
		return nil, err
	}
	return newConn(nc, rw.Reader, opt), nil
}

func newConn(nc net.Conn, br *bufio.Reader, opt Options) *Conn {
	if opt.MaxMessage == 0 {
		opt.MaxMessage = 64 << 10
	}
	if opt.QueueState == 0 {
		opt.QueueState = 4096
	}
	if opt.QueueDrop == 0 {
		opt.QueueDrop = 64
	}
	if opt.WriteTimeout == 0 {
		opt.WriteTimeout = 10 * time.Second
	}
	if opt.PingEvery == 0 {
		opt.PingEvery = 20 * time.Second
	}
	c := &Conn{
		opt:    opt,
		nc:     nc,
		br:     br,
		bw:     bufio.NewWriterSize(nc, 64<<10),
		done:   make(chan struct{}),
		signal: make(chan struct{}, 1),
	}
	go c.writeLoop()
	return c
}

// Done is closed when the connection ends.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Dropped returns how many droppable frames were shed.
func (c *Conn) Dropped() uint64 {
	c.qmu.Lock()
	defer c.qmu.Unlock()
	return c.dropped
}

// Send queues a message without blocking. It returns false once the
// connection is closed, or when the state lane overflows (the client is
// hopelessly behind and is disconnected so it can resynchronize).
func (c *Conn) Send(msg []byte, text, droppable bool) bool {
	select {
	case <-c.done:
		return false
	default:
	}
	c.qmu.Lock()
	if droppable {
		if len(c.drop) >= c.opt.QueueDrop {
			c.drop, c.dropT = c.drop[1:], c.dropT[1:] // shed the oldest animation frame
			c.dropped++
		}
		c.drop = append(c.drop, msg)
		c.dropT = append(c.dropT, text)
	} else {
		if len(c.state) >= c.opt.QueueState {
			c.qmu.Unlock()
			c.closeWith(CloseGoingAway, "client too slow")
			return false
		}
		c.state = append(c.state, msg)
		c.stateT = append(c.stateT, text)
	}
	c.qmu.Unlock()
	select {
	case c.signal <- struct{}{}:
	default:
	}
	return true
}

func (c *Conn) writeLoop() {
	ping := time.NewTicker(c.opt.PingEvery)
	defer ping.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ping.C:
			if c.writeFrame(OpPing, nil, true) != nil {
				c.shutdown()
				return
			}
		case <-c.signal:
			for {
				c.qmu.Lock()
				var msg []byte
				var text bool
				switch {
				case len(c.state) > 0: // state first: it is what correctness needs
					msg, text = c.state[0], c.stateT[0]
					c.state[0] = nil
					c.state, c.stateT = c.state[1:], c.stateT[1:]
				case len(c.drop) > 0:
					msg, text = c.drop[0], c.dropT[0]
					c.drop[0] = nil
					c.drop, c.dropT = c.drop[1:], c.dropT[1:]
				}
				more := len(c.state)+len(c.drop) > 0
				c.qmu.Unlock()
				if msg == nil {
					break
				}
				op := byte(OpBinary)
				if text {
					op = OpText
				}
				if c.writeFrame(op, msg, !more) != nil {
					c.shutdown()
					return
				}
			}
		}
	}
}

// writeFrame writes one unfragmented, unmasked frame (servers never mask).
func (c *Conn) writeFrame(op byte, payload []byte, flush bool) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	var hdr [10]byte
	hdr[0] = 0x80 | op
	n := 2
	switch l := len(payload); {
	case l < 126:
		hdr[1] = byte(l)
	case l <= 0xffff:
		hdr[1] = 126
		binary.BigEndian.PutUint16(hdr[2:], uint16(l))
		n = 4
	default:
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:], uint64(l))
		n = 10
	}
	c.nc.SetWriteDeadline(time.Now().Add(c.opt.WriteTimeout))
	if _, err := c.bw.Write(hdr[:n]); err != nil {
		return err
	}
	if _, err := c.bw.Write(payload); err != nil {
		return err
	}
	if flush {
		return c.bw.Flush()
	}
	return nil
}

// ReadMessage returns the next complete data message, answering pings and
// the closing handshake along the way.
func (c *Conn) ReadMessage() (op byte, msg []byte, err error) {
	var buf []byte
	var msgOp byte
	for {
		fin, opcode, payload, err := c.readFrame()
		if err != nil {
			c.shutdown()
			return 0, nil, err
		}
		switch opcode {
		case OpPing:
			if err := c.writeFrame(OpPong, payload, true); err != nil {
				c.shutdown()
				return 0, nil, err
			}
			continue
		case OpPong:
			continue
		case OpClose:
			code := uint16(CloseNormal)
			if len(payload) >= 2 {
				code = binary.BigEndian.Uint16(payload)
			}
			c.closeWith(code, "")
			return 0, nil, ErrClosed
		case OpText, OpBinary:
			if buf != nil {
				c.closeWith(CloseProtocolError, "expected continuation")
				return 0, nil, errProtocol
			}
			msgOp = opcode
			buf = append([]byte{}, payload...)
		case OpContinuation:
			if buf == nil {
				c.closeWith(CloseProtocolError, "unexpected continuation")
				return 0, nil, errProtocol
			}
			buf = append(buf, payload...)
		default:
			c.closeWith(CloseProtocolError, "unknown opcode")
			return 0, nil, errProtocol
		}
		if int64(len(buf)) > c.opt.MaxMessage {
			c.closeWith(CloseTooBig, "message too big")
			return 0, nil, errProtocol
		}
		if fin {
			return msgOp, buf, nil
		}
	}
}

func (c *Conn) readFrame() (fin bool, op byte, payload []byte, err error) {
	var h [2]byte
	if _, err = io.ReadFull(c.br, h[:]); err != nil {
		return
	}
	fin = h[0]&0x80 != 0
	if h[0]&0x70 != 0 { // no extensions negotiated: RSV bits must be zero
		c.closeWith(CloseProtocolError, "reserved bits set")
		return false, 0, nil, errProtocol
	}
	op = h[0] & 0x0f
	if h[1]&0x80 == 0 { // clients must mask (RFC 6455 §5.1)
		c.closeWith(CloseProtocolError, "unmasked client frame")
		return false, 0, nil, errProtocol
	}
	length := int64(h[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	if op >= 0x8 && (length > 125 || !fin) { // control frames: small and unfragmented
		c.closeWith(CloseProtocolError, "bad control frame")
		return false, 0, nil, errProtocol
	}
	if length < 0 || length > c.opt.MaxMessage {
		c.closeWith(CloseTooBig, "frame too big")
		return false, 0, nil, errProtocol
	}
	var mask [4]byte
	if _, err = io.ReadFull(c.br, mask[:]); err != nil {
		return
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return
	}
	for i := range payload {
		payload[i] ^= mask[i&3]
	}
	return fin, op, payload, nil
}

// Close starts the closing handshake with a normal status.
func (c *Conn) Close() error {
	c.closeWith(CloseNormal, "")
	return nil
}

func (c *Conn) closeWith(code uint16, reason string) {
	c.once.Do(func() {
		body := binary.BigEndian.AppendUint16(nil, code)
		body = append(body, reason[:min(len(reason), 120)]...)
		_ = c.writeFrame(OpClose, body, true)
		close(c.done)
		c.nc.Close()
	})
}

func (c *Conn) shutdown() {
	c.once.Do(func() {
		close(c.done)
		c.nc.Close()
	})
}

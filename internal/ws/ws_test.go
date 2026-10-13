package ws

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAcceptKeyRFCExample(t *testing.T) {
	// RFC 6455 §1.3.
	if got := AcceptKey("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("got %s", got)
	}
}

// testClient speaks just enough WebSocket to drive the server.
type testClient struct {
	nc net.Conn
	br *bufio.Reader
}

func dial(t *testing.T, srv *httptest.Server) *testClient {
	t.Helper()
	nc, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	req := "GET /ws HTTP/1.1\r\nHost: " + strings.TrimPrefix(srv.URL, "http://") + "\r\n" +
		"Upgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
	nc.Write([]byte(req))
	br := bufio.NewReader(nc)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 101 || resp.Header.Get("Sec-WebSocket-Accept") != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("handshake: %d %v", resp.StatusCode, resp.Header)
	}
	nc.SetDeadline(time.Now().Add(5 * time.Second))
	return &testClient{nc, br}
}

func (c *testClient) send(fin bool, op byte, payload []byte, masked bool) {
	b := []byte{op}
	if fin {
		b[0] |= 0x80
	}
	mbit := byte(0)
	if masked {
		mbit = 0x80
	}
	switch {
	case len(payload) < 126:
		b = append(b, mbit|byte(len(payload)))
	default:
		b = append(b, mbit|126)
		b = binary.BigEndian.AppendUint16(b, uint16(len(payload)))
	}
	if masked {
		var key [4]byte
		rand.Read(key[:])
		b = append(b, key[:]...)
		for i, x := range payload {
			b = append(b, x^key[i&3])
		}
	} else {
		b = append(b, payload...)
	}
	c.nc.Write(b)
}

func (c *testClient) recv(t *testing.T) (byte, []byte) {
	t.Helper()
	var h [2]byte
	if _, err := io.ReadFull(c.br, h[:]); err != nil {
		t.Fatal(err)
	}
	if h[1]&0x80 != 0 {
		t.Fatal("server frames must not be masked")
	}
	n := int(h[1] & 0x7f)
	switch n {
	case 126:
		var e [2]byte
		io.ReadFull(c.br, e[:])
		n = int(binary.BigEndian.Uint16(e[:]))
	case 127:
		var e [8]byte
		io.ReadFull(c.br, e[:])
		n = int(binary.BigEndian.Uint64(e[:]))
	}
	p := make([]byte, n)
	io.ReadFull(c.br, p)
	return h[0] & 0x0f, p
}

// echoServer echoes every message back with the same type.
func echoServer(t *testing.T, opt Options, onConn func(*Conn)) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Upgrade(w, r, opt)
		if err != nil {
			return
		}
		if onConn != nil {
			onConn(c)
		}
		for {
			op, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			c.Send(msg, op == OpText, false)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestEchoFragmentationPingClose(t *testing.T) {
	c := dial(t, echoServer(t, Options{}, nil))

	c.send(true, OpText, []byte("hello"), true)
	if op, p := c.recv(t); op != OpText || string(p) != "hello" {
		t.Fatalf("echo: op=%d %q", op, p)
	}

	big := []byte(strings.Repeat("telluric", 1000)) // 16-bit length
	c.send(false, OpBinary, big[:3000], true)
	c.send(true, OpPing, []byte("are you there"), true) // control frames may interleave
	c.send(true, OpContinuation, big[3000:], true)
	if op, p := c.recv(t); op != OpPong || string(p) != "are you there" {
		t.Fatalf("pong: op=%d %q", op, p)
	}
	if op, p := c.recv(t); op != OpBinary || string(p) != string(big) {
		t.Fatalf("reassembled: op=%d len=%d", op, len(p))
	}

	c.send(true, OpClose, binary.BigEndian.AppendUint16(nil, CloseNormal), true)
	if op, p := c.recv(t); op != OpClose || binary.BigEndian.Uint16(p) != CloseNormal {
		t.Fatalf("close: op=%d %x", op, p)
	}
}

func TestUnmaskedClientFrameIsRejected(t *testing.T) {
	c := dial(t, echoServer(t, Options{}, nil))
	c.send(true, OpText, []byte("naked"), false)
	if op, p := c.recv(t); op != OpClose || binary.BigEndian.Uint16(p) != CloseProtocolError {
		t.Fatalf("op=%d %x", op, p)
	}
}

func TestOversizedMessageIsRejected(t *testing.T) {
	c := dial(t, echoServer(t, Options{MaxMessage: 100}, nil))
	c.send(true, OpText, make([]byte, 200), true)
	if op, p := c.recv(t); op != OpClose || binary.BigEndian.Uint16(p) != CloseTooBig {
		t.Fatalf("op=%d %x", op, p)
	}
}

func TestBadHandshake(t *testing.T) {
	srv := echoServer(t, Options{}, nil)
	resp, err := http.Get(srv.URL + "/ws")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("plain GET: %d", resp.StatusCode)
	}
}

func TestDroppableLaneShedsOldest(t *testing.T) {
	ready := make(chan *Conn, 1)
	srv := echoServer(t, Options{QueueDrop: 4}, func(c *Conn) { ready <- c })
	cl := dial(t, srv)
	conn := <-ready
	// Don't read: let the socket buffers fill, then flood the droppable lane.
	big := make([]byte, 60000)
	for range 400 {
		conn.Send(big, false, true)
	}
	conn.Send([]byte("state survives"), true, false)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		op, p := cl.recv(t)
		if op == OpText {
			if string(p) != "state survives" {
				t.Fatalf("got %q", p)
			}
			if conn.Dropped() == 0 {
				t.Fatal("nothing was shed under backpressure")
			}
			return
		}
	}
	t.Fatal("state frame never arrived")
}

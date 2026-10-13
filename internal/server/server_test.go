package server

import (
	"bufio"
	"net"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/SharvikS/telluric/internal/ws"
)

func start(t *testing.T) (*Server, string, chan *ws.Conn) {
	t.Helper()
	conns := make(chan *ws.Conn, 4)
	s := New(Config{
		Listen:    "127.0.0.1:0",
		UI:        fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>t</title>")}},
		Token:     "s3cret",
		Subscribe: func(c *ws.Conn) { conns <- c; c.Send([]byte(`{"t":"hello"}`), true, false) },
	})
	url, err := s.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Shutdown(t.Context()) })
	if !strings.HasSuffix(url, "/?token=s3cret") {
		t.Fatalf("url %s", url)
	}
	return s, s.ln.Addr().String(), conns
}

// handshake sends a raw upgrade request and returns the status line.
func handshake(t *testing.T, addr, path, host, origin, cookie string) int {
	t.Helper()
	nc, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	nc.SetDeadline(time.Now().Add(3 * time.Second))
	req := "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
	if origin != "" {
		req += "Origin: " + origin + "\r\n"
	}
	if cookie != "" {
		req += "Cookie: " + cookie + "\r\n"
	}
	nc.Write([]byte(req + "\r\n"))
	resp, err := http.ReadResponse(bufio.NewReader(nc), nil)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode
}

func TestWebSocketGuards(t *testing.T) {
	_, addr, conns := start(t)
	for _, tc := range []struct {
		name                       string
		path, host, origin, cookie string
		want                       int
	}{
		{"no token", "/ws", addr, "http://" + addr, "", http.StatusUnauthorized},
		{"wrong token", "/ws?token=nope", addr, "http://" + addr, "", http.StatusUnauthorized},
		{"cross-site origin", "/ws?token=s3cret", addr, "https://evil.example", "", http.StatusForbidden},
		{"DNS rebinding host", "/ws?token=s3cret", "evil.example:7777", "http://evil.example:7777", "", http.StatusForbidden},
		{"query token", "/ws?token=s3cret", addr, "http://" + addr, "", http.StatusSwitchingProtocols},
		{"cookie", "/ws", addr, "http://" + addr, "telluric_session=s3cret", http.StatusSwitchingProtocols},
		{"localhost name", "/ws?token=s3cret", "localhost:1", "http://localhost:1", "", http.StatusSwitchingProtocols},
	} {
		if got := handshake(t, addr, tc.path, tc.host, tc.origin, tc.cookie); got != tc.want {
			t.Errorf("%s: status %d, want %d", tc.name, got, tc.want)
		}
	}
	// The 101 response precedes the hand-off to the engine.
	for i := range 3 {
		select {
		case <-conns:
		case <-time.After(time.Second):
			t.Fatalf("only %d clients reached the engine, want 3", i)
		}
	}
	select {
	case <-conns:
		t.Fatal("a rejected client reached the engine")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestStaticSetsSessionCookieAndHeaders(t *testing.T) {
	_, addr, _ := start(t)
	resp, err := http.Get("http://" + addr + "/?token=s3cret")
	if err != nil {
		t.Fatal(err)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == cookieName {
			cookie = c
		}
	}
	if cookie == nil || cookie.Value != "s3cret" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie %+v", cookie)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("CSP %q", csp)
	}
	resp, _ = http.Get("http://" + addr + "/?token=wrong")
	if len(resp.Cookies()) != 0 {
		t.Fatal("a wrong token set a cookie")
	}
}

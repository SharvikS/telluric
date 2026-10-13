// Package server serves the UI and the engine's WebSocket stream.
//
// The stream reveals every connection this machine makes, so it is guarded:
// a random session token (cookie or query), an Origin check against
// cross-site WebSocket hijacking, and a Host check against DNS rebinding when
// listening on loopback.
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/SharvikS/telluric/internal/wire"
	"github.com/SharvikS/telluric/internal/ws"
)

// Config configures the server.
type Config struct {
	Listen string // host:port
	UI     fs.FS
	Logf   func(string, ...any)
	// Subscribe hands a new client to the engine.
	Subscribe func(c *ws.Conn)
	// Command forwards an authenticated client's request (alert workflow).
	Command func(wire.Command)
	// Token is the session secret; empty means a random one.
	Token string
}

// Server is the HTTP front door.
type Server struct {
	cfg      Config
	token    string
	srv      *http.Server
	ln       net.Listener
	loopback bool
}

const cookieName = "telluric_session"

func init() {
	_ = mime.AddExtensionType(".woff2", "font/woff2")
	_ = mime.AddExtensionType(".mjs", "text/javascript; charset=utf-8")
	_ = mime.AddExtensionType(".bin", "application/octet-stream")
}

// New prepares a server.
func New(cfg Config) *Server {
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	tok := cfg.Token
	if tok == "" {
		var b [16]byte
		rand.Read(b[:])
		tok = hex.EncodeToString(b[:])
	}
	return &Server{cfg: cfg, token: tok}
}

// Start listens and serves in the background. It returns the URL to open,
// token included.
func (s *Server) Start() (string, error) {
	ln, err := net.Listen("tcp", s.cfg.Listen)
	if err != nil {
		return "", err
	}
	s.ln = ln
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	ip := net.ParseIP(host)
	s.loopback = ip != nil && ip.IsLoopback()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	mux.Handle("GET /", s.static())
	s.srv = &http.Server{
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	go func() {
		if err := s.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.cfg.Logf("server: %v", err)
		}
	}()
	shown := host
	if ip != nil && ip.IsUnspecified() {
		shown = "127.0.0.1"
	}
	return fmt.Sprintf("http://%s/?token=%s", net.JoinHostPort(shown, port), s.token), nil
}

// Shutdown stops the server gracefully.
func (s *Server) Shutdown(ctx context.Context) error {
	if s.srv == nil {
		return nil
	}
	return s.srv.Shutdown(ctx)
}

func securityHeaders(h http.Handler) http.Handler {
	const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; " +
		"worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("Content-Security-Policy", csp)
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "no-referrer")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

// static serves the UI. A request carrying the token sets the session
// cookie; the page itself strips the token from the address bar.
func (s *Server) static() http.Handler {
	files := http.FileServerFS(s.cfg.UI)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.hostAllowed(r) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if t := r.URL.Query().Get("token"); t != "" && s.tokenOK(t) {
			http.SetCookie(w, &http.Cookie{
				Name: cookieName, Value: s.token, Path: "/",
				HttpOnly: true, SameSite: http.SameSiteStrictMode,
			})
		}
		files.ServeHTTP(w, r)
	})
}

func (s *Server) tokenOK(t string) bool {
	return subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
}

func (s *Server) authorized(r *http.Request) bool {
	if c, err := r.Cookie(cookieName); err == nil && s.tokenOK(c.Value) {
		return true
	}
	return s.tokenOK(r.URL.Query().Get("token"))
}

// hostAllowed defeats DNS rebinding: on loopback, only loopback names may
// address us.
func (s *Server) hostAllowed(r *http.Request) bool {
	if !s.loopback {
		return true
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// originAllowed defeats cross-site WebSocket hijacking: browsers always
// send Origin on WebSocket handshakes, and it must be this very server.
func originAllowed(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true // not a browser (curl, tests); still needs the token
	}
	u, err := url.Parse(o)
	return err == nil && strings.EqualFold(u.Host, r.Host)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	switch {
	case !s.hostAllowed(r):
		http.Error(w, "forbidden host", http.StatusForbidden)
		return
	case !originAllowed(r):
		http.Error(w, "cross-origin WebSocket refused", http.StatusForbidden)
		return
	case !s.authorized(r):
		http.Error(w, "missing or bad session token", http.StatusUnauthorized)
		return
	}
	conn, err := ws.Upgrade(w, r, ws.Options{})
	if err != nil {
		return
	}
	s.cfg.Logf("client connected from %s", r.RemoteAddr)
	s.cfg.Subscribe(conn)
	go func() {
		defer conn.Close()
		for {
			op, msg, err := conn.ReadMessage()
			if err != nil {
				s.cfg.Logf("client %s left", r.RemoteAddr)
				return
			}
			if op != ws.OpText {
				continue
			}
			var m wire.Command
			if json.Unmarshal(msg, &m) != nil {
				continue
			}
			switch {
			case m.T == "ping":
				conn.Send(wire.Pong, true, false)
			case strings.HasPrefix(m.T, "alert.") && s.cfg.Command != nil:
				s.cfg.Command(m)
			}
		}
	}()
}

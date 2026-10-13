package decode

import (
	"bytes"
	"encoding/binary"
)

// HTTPRequest is the start of a cleartext HTTP/1.x request.
type HTTPRequest struct {
	Method    []byte
	Host      []byte
	UserAgent []byte
	BasicAuth bool // an Authorization: Basic header — a password in clear text
}

var httpMethods = [][]byte{
	[]byte("GET "), []byte("POST "), []byte("HEAD "), []byte("PUT "), []byte("DELETE "),
	[]byte("OPTIONS "), []byte("PATCH "), []byte("CONNECT "),
}

// ParseHTTPRequest reports whether b starts like an HTTP/1.x request and
// extracts the headers Telluric cares about from whatever part is present.
func ParseHTTPRequest(b []byte) (HTTPRequest, bool) {
	var r HTTPRequest
	for _, m := range httpMethods {
		if bytes.HasPrefix(b, m) {
			r.Method = m[:len(m)-1]
			break
		}
	}
	if r.Method == nil {
		return r, false
	}
	eol := bytes.Index(b, []byte("\r\n"))
	if eol < 0 || !bytes.Contains(b[:eol], []byte(" HTTP/1.")) {
		return r, eol < 0 && len(b) < 64 // a request line still in flight
	}
	for rest := b[eol+2:]; len(rest) > 0; {
		end := bytes.Index(rest, []byte("\r\n"))
		if end <= 0 {
			break
		}
		line := rest[:end]
		rest = rest[end+2:]
		colon := bytes.IndexByte(line, ':')
		if colon <= 0 {
			continue
		}
		name, val := line[:colon], bytes.TrimSpace(line[colon+1:])
		switch {
		case bytes.EqualFold(name, []byte("host")):
			r.Host = val
		case bytes.EqualFold(name, []byte("user-agent")):
			r.UserAgent = val
		case bytes.EqualFold(name, []byte("authorization")) && len(val) > 6 && bytes.EqualFold(val[:6], []byte("basic ")):
			r.BasicAuth = true
		}
	}
	return r, true
}

// IsSSHBanner reports whether b starts with an SSH identification string.
func IsSSHBanner(b []byte) bool { return bytes.HasPrefix(b, []byte("SSH-")) }

// IsSTUN reports whether b is a STUN message (RFC 5389), the signaling of
// WebRTC calls and NAT traversal.
func IsSTUN(b []byte) bool {
	return len(b) >= 20 && b[0]&0xc0 == 0 &&
		binary.BigEndian.Uint32(b[4:8]) == 0x2112a442 &&
		int(binary.BigEndian.Uint16(b[2:4]))+20 == len(b)
}

// IsWireGuard reports whether b looks like a WireGuard message: a type byte
// 1–4, three reserved zero bytes, and the fixed sizes of the handshake
// messages.
func IsWireGuard(b []byte) bool {
	if len(b) < 32 || b[1] != 0 || b[2] != 0 || b[3] != 0 {
		return false
	}
	switch b[0] {
	case 1:
		return len(b) == 148
	case 2:
		return len(b) == 92
	case 3:
		return len(b) == 64
	case 4:
		return len(b)%16 == 0
	}
	return false
}

// IsBitTorrent reports whether b is a BitTorrent peer handshake or a
// Mainline DHT query or response.
func IsBitTorrent(b []byte) bool {
	if bytes.HasPrefix(b, []byte("\x13BitTorrent protocol")) {
		return true
	}
	return len(b) > 12 && (bytes.HasPrefix(b, []byte("d1:ad2:id20:")) || bytes.HasPrefix(b, []byte("d1:rd2:id20:")))
}

// IsStratum reports whether b is a cryptocurrency mining pool handshake
// (Stratum, as spoken by XMRig and most miners).
func IsStratum(b []byte) bool {
	if len(b) < 16 || b[0] != '{' {
		return false
	}
	return bytes.Contains(b, []byte(`"mining.subscribe"`)) ||
		bytes.Contains(b, []byte(`"mining.authorize"`)) ||
		(bytes.Contains(b, []byte(`"method":"login"`)) && bytes.Contains(b, []byte(`"agent"`)))
}

// CleartextLogin reports whether a client→server payload sends a password
// in clear text for the classic plaintext protocols, keyed by server port.
func CleartextLogin(port uint16, b []byte) bool {
	upper := func(n int) []byte {
		n = min(n, len(b))
		return bytes.ToUpper(b[:n])
	}
	switch port {
	case 21, 110: // FTP, POP3
		return bytes.HasPrefix(upper(5), []byte("PASS "))
	case 143: // IMAP: "<tag> LOGIN user pass"
		if sp := bytes.IndexByte(b, ' '); sp > 0 && sp < 16 {
			rest := b[sp+1:]
			return len(rest) > 6 && bytes.EqualFold(rest[:6], []byte("LOGIN "))
		}
	case 25, 587: // SMTP AUTH before STARTTLS
		return bytes.HasPrefix(upper(10), []byte("AUTH PLAIN")) || bytes.HasPrefix(upper(10), []byte("AUTH LOGIN"))
	}
	return false
}

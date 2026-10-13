package engine

import (
	"net"
	"net/netip"
	"strings"
)

// localAddrs is the set of this machine's addresses.
type localAddrs struct {
	set     map[netip.Addr]bool
	learned map[netip.Addr]bool
}

func (l *localAddrs) has(a netip.Addr) bool {
	a = a.Unmap()
	return l.set[a] || l.learned[a]
}

func (l *localAddrs) learn(a netip.Addr) {
	a = a.Unmap()
	if l.set[a] || l.learned[a] || len(l.learned) > 256 {
		return
	}
	if l.learned == nil {
		l.learned = map[netip.Addr]bool{}
	}
	l.learned[a] = true
}

func (e *Engine) refreshLocal(now int64) {
	e.lastLocal = now
	if e.cfg.LocalAddrs == nil {
		return
	}
	set := map[netip.Addr]bool{}
	for _, a := range e.cfg.LocalAddrs() {
		set[a.Unmap()] = true
	}
	e.local.set = set
}

// InterfaceAddrs returns the addresses of this machine's interfaces.
func InterfaceAddrs() []netip.Addr {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		s := a.String()
		if i := strings.IndexByte(s, '/'); i >= 0 {
			s = s[:i]
		}
		if ip, err := netip.ParseAddr(s); err == nil {
			out = append(out, ip)
		}
	}
	return out
}

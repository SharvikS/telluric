package procmap

import (
	"net"
	"net/netip"
	"os"
	"testing"
)

// TestResolveOwnSocket attributes a real socket of this test process.
func TestResolveOwnSocket(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	defer ln.Close()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	local := netip.MustParseAddrPort(c.LocalAddr().String())
	remote := netip.MustParseAddrPort(c.RemoteAddr().String())
	got := New("/proc").Resolve([]Socket{{Proto: 6, Local: local, Remote: remote}})
	if got[0] == nil || got[0].PID != os.Getpid() {
		t.Fatalf("own socket resolved to %+v, want pid %d", got[0], os.Getpid())
	}
	t.Logf("resolved to %s (pid %d, unit %q, user %s)", got[0].Name, got[0].PID, got[0].Unit, got[0].User)
}

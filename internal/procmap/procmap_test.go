package procmap

import (
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestParseHexAddr(t *testing.T) {
	for in, want := range map[string]string{
		"0100007F:0277":                         "127.0.0.1:631",
		"231DA8C0:C822":                         "192.168.29.35:51234",
		"00000000000000000000000001000000:0277": "[::1]:631",
		"0000000000000000FFFF0000231DA8C0:01BB": "192.168.29.35:443", // v4-mapped in tcp6
		"01020524000000001151D10000350000:01BB": "[2405:201::d1:5111:0:3500]:443",
	} {
		got, ok := parseHexAddr(in)
		if !ok || got.String() != want {
			t.Errorf("%s → %v (ok=%v), want %s", in, got, ok, want)
		}
	}
}

func TestParseCgroup(t *testing.T) {
	unit, ctr, app := parseCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-org.mozilla.firefox-31337.scope\n")
	if unit != "app-flatpak-org.mozilla.firefox-31337.scope" || app != "org.mozilla.firefox" || ctr != "" {
		t.Errorf("flatpak: %q %q %q", unit, ctr, app)
	}
	unit, ctr, _ = parseCgroup("0::/system.slice/docker-4f2a9c0de81b77a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234abcd.scope")
	if ctr != "4f2a9c0de81b" || unit != "docker-4f2a9c0de81b77a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234abcd.scope" {
		t.Errorf("docker: %q %q", unit, ctr)
	}
	unit, _, _ = parseCgroup("0::/system.slice/systemd-resolved.service")
	if unit != "systemd-resolved.service" {
		t.Errorf("service: %q", unit)
	}
}

// fakeProc builds a miniature /proc with one TCP connection and one UDP
// socket owned by pid 4242.
func fakeProc(t *testing.T) string {
	root := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "net"), 0o755))
	hdr := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	must(os.WriteFile(filepath.Join(root, "net", "tcp"), []byte(hdr+
		"   0: 231DA8C0:C822 0EB7FA8E:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 777001 1 0 20 4 30 10 -1\n"+
		"   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 777002 1 0 100 0 0 10 0\n"), 0o644))
	must(os.WriteFile(filepath.Join(root, "net", "udp"), []byte(hdr+
		"  10: 00000000:9C40 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 777003 2 0 0\n"), 0o644))
	for _, f := range []string{"tcp6", "udp6"} {
		must(os.WriteFile(filepath.Join(root, "net", f), []byte(hdr), 0o644))
	}
	pid := filepath.Join(root, "4242")
	must(os.MkdirAll(filepath.Join(pid, "fd"), 0o755))
	for i, ino := range []int{777001, 777003} {
		must(os.Symlink("socket:["+strconv.Itoa(ino)+"]", filepath.Join(pid, "fd", strconv.Itoa(10+i))))
	}
	must(os.Symlink("/dev/null", filepath.Join(pid, "fd", "0")))
	must(os.WriteFile(filepath.Join(pid, "stat"), []byte("4242 (Socket Process) S 4200 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 30 0 987654 0 0\n"), 0o644))
	must(os.WriteFile(filepath.Join(pid, "comm"), []byte("Socket Process\n"), 0o644))
	must(os.WriteFile(filepath.Join(pid, "cmdline"), []byte("/usr/lib/firefox/firefox\x00-contentproc\x00"), 0o644))
	must(os.WriteFile(filepath.Join(pid, "status"), []byte("Name:\tSocket Process\nPPid:\t4200\nUid:\t1000\t1000\t1000\t1000\n"), 0o644))
	must(os.WriteFile(filepath.Join(pid, "cgroup"), []byte("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-hyprland-firefox-4200.scope\n"), 0o644))
	must(os.Symlink("/usr/lib/firefox/firefox", filepath.Join(pid, "exe")))
	return root
}

func TestResolve(t *testing.T) {
	r := New(fakeProc(t))
	me := netip.MustParseAddr("192.168.29.35")
	got := r.Resolve([]Socket{
		{Proto: 6, Local: netip.AddrPortFrom(me, 51234), Remote: netip.MustParseAddrPort("142.250.183.14:443")},
		{Proto: 17, Local: netip.AddrPortFrom(me, 40000), Remote: netip.MustParseAddrPort("142.250.183.14:443")}, // unconnected wildcard UDP
		{Proto: 6, Local: netip.AddrPortFrom(me, 22), Remote: netip.MustParseAddrPort("10.0.0.9:50000")},         // only a listener matches
	})
	if got[0] == nil || got[0].PID != 4242 || got[0].Name != "firefox" || got[0].Unit != "app-hyprland-firefox-4200.scope" ||
		got[0].PPID != 4200 || got[0].Key.Start != 987654 || got[0].Cmd != "/usr/lib/firefox/firefox -contentproc" {
		t.Fatalf("tcp: %+v", got[0])
	}
	if got[1] == nil || got[1] != got[0] {
		t.Fatalf("udp: %+v", got[1])
	}
	if got[2] != nil {
		t.Fatalf("listener matched a connection: %+v", got[2])
	}
}

func TestInterpreterNamesAreKept(t *testing.T) {
	for _, n := range []string{"python3", "python3.14", "node", "bash", "java"} {
		if !interpreter(n) {
			t.Errorf("%s not treated as interpreter", n)
		}
	}
	for _, n := range []string{"firefox", "pythonista", "nodejs-app", "steam"} {
		if interpreter(n) {
			t.Errorf("%s treated as interpreter", n)
		}
	}
}

//go:build linux

package capture

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/SharvikS/telluric/internal/decode"
)

// The ring needs CAP_NET_RAW. Rather than demanding root, these tests
// re-run themselves inside an unprivileged user + network namespace
// (unshare -Urn), where the test process holds CAP_NET_RAW over a private
// loopback interface — and exercise the real kernel ring, the real capture
// helper and its real privilege drop.

const netnsEnv = "TELLURIC_IN_NETNS"

// inNamespace re-executes the named test inside a fresh namespace and
// reports its output. It returns false (after skipping) when namespaces are
// unavailable, e.g. on hosts that restrict unprivileged user namespaces.
func inNamespace(t *testing.T, name string) {
	t.Helper()
	if os.Getenv(netnsEnv) == "1" {
		return
	}
	unshare, err := exec.LookPath("unshare")
	if err != nil {
		t.Skip("unshare not available")
	}
	if err := exec.Command(unshare, "-Urn", "true").Run(); err != nil {
		t.Skipf("unprivileged user namespaces unavailable: %v", err)
	}
	cmd := exec.Command(unshare, "-Urn", os.Args[0], "-test.run", "^"+name+"$", "-test.v", "-test.count=1")
	cmd.Env = append(os.Environ(), netnsEnv+"=1")
	out, err := cmd.CombinedOutput()
	t.Logf("namespace run:\n%s", out)
	if err != nil {
		t.Fatalf("test failed inside the namespace: %v", err)
	}
	if !bytes.Contains(out, []byte("--- PASS: "+name)) {
		t.Fatalf("%s did not pass inside the namespace", name)
	}
	t.SkipNow() // the outer invocation has nothing more to do
}

func loopbackUp(t *testing.T) {
	t.Helper()
	if out, err := exec.Command("ip", "link", "set", "lo", "up").CombinedOutput(); err != nil {
		t.Fatalf("ip link set lo up: %v %s", err, out)
	}
}

// sendUDP sends n datagrams to 127.0.0.1:port from a fresh socket after a
// short delay, reporting the outcome on the returned channel.
func sendUDP(port, n int) <-chan error {
	errc := make(chan error, 1)
	// A listener, so the kernel doesn't answer with port-unreachable (which
	// makes the next write on a connected socket fail).
	sink, err := net.ListenPacket("udp4", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		errc <- err
		return errc
	}
	go func() {
		defer sink.Close()
		time.Sleep(50 * time.Millisecond)
		c, err := net.Dial("udp4", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			errc <- err
			return
		}
		defer c.Close()
		for i := range n {
			if _, err := c.Write([]byte("telluric-probe-" + strconv.Itoa(i))); err != nil {
				errc <- err
				return
			}
		}
		errc <- nil
	}()
	return errc
}

func TestRingCapturesLoopback(t *testing.T) {
	inNamespace(t, "TestRingCapturesLoopback")
	loopbackUp(t)
	r, err := OpenRing(RingOptions{Interface: "lo", BlockSize: 1 << 16, Blocks: 8, Retire: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	const n = 200
	sent := sendUDP(9999, n)
	lo, _ := net.InterfaceByName("lo")
	var p decode.Packet
	seen := map[string]bool{}
	deadline := time.Now().Add(5 * time.Second)
	for len(seen) < n && time.Now().Before(deadline) {
		err := r.Read(50*time.Millisecond, func(f *Frame) {
			if p.Decode(f.Proto, f.Data) != nil || !p.Has(decode.LayerUDP) || p.DstPort != 9999 {
				return
			}
			if f.Ifindex != int32(lo.Index) || f.HAType != ARPHRDLoopback || f.PktType == PacketOutgoing {
				t.Errorf("metadata: ifindex=%d hatype=%d pkttype=%d", f.Ifindex, f.HAType, f.PktType)
			}
			if p.Src != netip.MustParseAddr("127.0.0.1") || f.WireLen != uint32(p.IPLen) {
				t.Errorf("decoded src=%v wire=%d iplen=%d", p.Src, f.WireLen, p.IPLen)
			}
			key := string(p.Payload)
			if seen[key] {
				t.Errorf("duplicate frame %q: loopback's outgoing copy leaked through", key)
			}
			seen[key] = true
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	if len(seen) != n {
		t.Fatalf("captured %d of %d datagrams", len(seen), n)
	}
	st := r.Stats()
	if st.Received < n || st.Dropped != 0 {
		t.Fatalf("stats %+v", st)
	}
}

func TestRingCloseUnblocksRead(t *testing.T) {
	inNamespace(t, "TestRingCloseUnblocksRead")
	loopbackUp(t)
	r, err := OpenRing(RingOptions{Interface: "lo", BlockSize: 1 << 16, Blocks: 4})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- r.Read(time.Hour, func(*Frame) {}) }()
	time.Sleep(50 * time.Millisecond)
	r.Close()
	select {
	case err := <-done:
		if err != ErrClosed && err != nil {
			t.Fatalf("Read returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close did not interrupt a blocked Read")
	}
}

// TestHelperDropsPrivileges builds the real capture helper, runs it, reads
// its pcapng stream, and checks from /proc that it holds no capabilities
// once capturing.
func TestHelperDropsPrivileges(t *testing.T) {
	inNamespace(t, "TestHelperDropsPrivileges")
	loopbackUp(t)
	bin := filepath.Join(t.TempDir(), "telluric-capture")
	_, here, _, _ := runtime.Caller(0)
	pkg := filepath.Join(filepath.Dir(here), "..", "..", "cmd", "telluric-capture")
	build := exec.Command("go", "build", "-o", bin, pkg)
	build.Env = append(os.Environ(), "CGO_ENABLED="+os.Getenv("HELPER_CGO"))
	if out, err := build.CombinedOutput(); err != nil {
		t.Skipf("cannot build helper here: %v %s", err, out)
	}
	cmd := exec.Command(bin, "-i", "lo")
	stdout, _ := cmd.StdoutPipe()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()

	s, err := NewStream(bufio.NewReader(stdout), StreamOptions{Name: "helper"})
	if err != nil {
		t.Fatalf("helper stream: %v (%s)", err, stderr.String())
	}
	// By the time the stream header arrived, the helper has dropped privileges.
	status, err := os.ReadFile("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/status")
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"CapEff", "CapPrm", "CapAmb"} {
		for line := range strings.SplitSeq(string(status), "\n") {
			if strings.HasPrefix(line, field+":") && strings.TrimSpace(line[len(field)+1:]) != "0000000000000000" {
				t.Errorf("helper still holds capabilities: %s", line)
			}
		}
		if !strings.Contains(string(status), "NoNewPrivs:\t1") {
			t.Error("helper did not set no_new_privs")
		}
	}

	sent := sendUDP(9998, 50)
	var p decode.Packet
	got := 0
	deadline := time.Now().Add(5 * time.Second)
	for got < 50 && time.Now().Before(deadline) {
		err := s.Read(100*time.Millisecond, func(f *Frame) {
			if p.Decode(f.Proto, f.Data) == nil && p.Has(decode.LayerUDP) && p.DstPort == 9998 {
				got++
			}
		})
		if err != nil && err != io.EOF {
			t.Fatal(err)
		}
	}
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	if got != 50 {
		t.Fatalf("received %d of 50 datagrams through the helper", got)
	}
	s.Close()
}

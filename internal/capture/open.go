package capture

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Options select and configure a live capture source.
type Options struct {
	// Method is "auto" (default), "ring", "helper" or "dumpcap".
	Method    string
	Interface string
	Snaplen   int
	// HelperPath overrides where telluric-capture is looked up.
	HelperPath string
}

// Open opens a live capture source. In auto mode it prefers the in-process
// ring (when this process has CAP_NET_RAW), then the privileged helper, then
// Wireshark's dumpcap, and explains how to fix things when none works.
func Open(o Options) (Source, error) {
	if o.Snaplen == 0 {
		o.Snaplen = 4096
	}
	switch o.Method {
	case "ring":
		return OpenRing(RingOptions{Interface: o.Interface, Snaplen: o.Snaplen})
	case "helper":
		return OpenHelper(o)
	case "dumpcap":
		return OpenDumpcap(o)
	case "", "auto":
	default:
		return nil, fmt.Errorf("capture: unknown method %q", o.Method)
	}

	if CanCapture() {
		return OpenRing(RingOptions{Interface: o.Interface, Snaplen: o.Snaplen})
	}
	var reasons []string
	s, err := OpenHelper(o)
	if err == nil {
		return s, nil
	}
	reasons = append(reasons, "helper: "+err.Error())
	if s, err = OpenDumpcap(o); err == nil {
		return s, nil
	}
	reasons = append(reasons, "dumpcap: "+err.Error())
	return nil, fmt.Errorf("%w\n  tried: %s\n  fix:   sudo setcap cap_net_raw,cap_net_admin=ep %s   (one time)\n     or: run with sudo, or try --demo",
		ErrPermission, strings.Join(reasons, "; "), helperPath(o))
}

// OpenFile replays a pcap or pcapng file. With realtime set, frames are
// paced by their timestamps (scaled by speed) and rebased to the present.
func OpenFile(path string, realtime bool, speed float64) (*Stream, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	s, err := NewStream(f, StreamOptions{
		Name:     "replay:" + filepath.Base(path),
		Realtime: realtime, Speed: speed, Rebase: realtime,
		Closer: f,
	})
	if err != nil {
		f.Close()
		return nil, err
	}
	return s, nil
}

func helperPath(o Options) string {
	if o.HelperPath != "" {
		return o.HelperPath
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "telluric-capture")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if p, err := exec.LookPath("telluric-capture"); err == nil {
		return p
	}
	return "telluric-capture"
}

// OpenHelper runs telluric-capture and reads its pcapng stream.
func OpenHelper(o Options) (*Stream, error) {
	iface := o.Interface
	if iface == "" {
		iface = "any"
	}
	return openCommand("helper", helperPath(o), "-i", iface, "-s", strconv.Itoa(max(o.Snaplen, 256)))
}

// OpenDumpcap runs Wireshark's dumpcap, which members of the wireshark
// group may run without root.
func OpenDumpcap(o Options) (*Stream, error) {
	path, err := exec.LookPath("dumpcap")
	if err != nil {
		return nil, err
	}
	iface := o.Interface
	if iface == "" {
		iface = "any"
	}
	return openCommand("dumpcap", path, "-i", iface, "-s", strconv.Itoa(max(o.Snaplen, 256)), "-q", "-w", "-")
}

func openCommand(name, path string, args ...string) (*Stream, error) {
	cmd := exec.Command(path, args...)
	stderr := &tailBuffer{max: 4096}
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM, Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	pc := &procCloser{cmd: cmd, stdout: stdout}
	s, err := NewStream(stdout, StreamOptions{Name: name, Closer: pc})
	if err != nil {
		pc.Close()
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, errors.New(msg)
		}
		return nil, err
	}
	return s, nil
}

type procCloser struct {
	cmd    *exec.Cmd
	stdout io.Closer
	once   sync.Once
}

func (p *procCloser) Close() error {
	p.once.Do(func() {
		_ = p.cmd.Process.Signal(syscall.SIGTERM)
		_ = p.stdout.Close()
		done := make(chan struct{})
		go func() { _ = p.cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			_ = p.cmd.Process.Kill()
			<-done
		}
	})
	return nil
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf.Write(p)
	if over := t.buf.Len() - t.max; over > 0 {
		t.buf.Next(over)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.buf.String()
}

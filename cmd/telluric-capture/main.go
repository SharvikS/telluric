// Command telluric-capture is Telluric's privileged capture helper.
//
// It is the only part of Telluric that needs CAP_NET_RAW, and it holds it
// only long enough to open a TPACKET_V3 ring: right after that it drops every
// capability on every thread and sets no_new_privs. From then on it just
// copies frames to stdout as a pcapng stream (LINKTYPE_LINUX_SLL2 with
// direction flags, plus an interface statistics block every second carrying
// kernel drop counters). The engine, which parses those untrusted bytes, runs
// without privileges.
//
//	sudo setcap cap_net_raw,cap_net_admin=ep ./telluric-capture
//	./telluric-capture -i any | wireshark -k -i -
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"

	"github.com/SharvikS/telluric/internal/capture"
)

func main() {
	iface := flag.String("i", "any", "interface to capture on (any = all)")
	snaplen := flag.Int("s", 4096, "truncate frames to this many bytes in the kernel")
	blocks := flag.Int("B", 64, "ring size in 1 MiB blocks")
	flag.Parse()

	// Die with the engine instead of capturing into the void.
	_ = unix.Prctl(unix.PR_SET_PDEATHSIG, uintptr(unix.SIGTERM), 0, 0, 0)
	if os.Getppid() == 1 {
		os.Exit(0)
	}

	ring, err := capture.OpenRing(capture.RingOptions{Interface: *iface, Snaplen: *snaplen, Blocks: *blocks})
	if errors.Is(err, capture.ErrPermission) {
		exe, _ := os.Executable()
		fatal(fmt.Errorf("no CAP_NET_RAW; grant it once with:\n  sudo setcap cap_net_raw,cap_net_admin=ep %s", exe))
	}
	if err != nil {
		fatal(err)
	}
	if err := dropPrivileges(); err != nil {
		fatal(fmt.Errorf("dropping privileges: %w", err))
	}

	out, err := capture.NewNGWriter(os.Stdout, uint32(*snaplen))
	if err != nil {
		fatal(err)
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM, syscall.SIGPIPE)

	var writeErr error
	lastStats := time.Now()
	for {
		select {
		case <-stop:
			ring.Close()
			out.Flush()
			return
		default:
		}
		err := ring.Read(100*time.Millisecond, func(f *capture.Frame) {
			if writeErr == nil {
				writeErr = out.WriteFrame(f)
			}
		})
		if err != nil {
			fatal(err)
		}
		if now := time.Now(); now.Sub(lastStats) >= time.Second {
			st := ring.Stats()
			if writeErr == nil {
				writeErr = out.WriteStats(now.UnixNano(), st.Received, st.Dropped)
			}
			lastStats = now
		}
		if writeErr == nil {
			writeErr = out.Flush()
		}
		if writeErr != nil {
			if errors.Is(writeErr, syscall.EPIPE) {
				return // the engine went away
			}
			fatal(writeErr)
		}
	}
}

// dropPrivileges clears every capability set on every OS thread of the
// process (capabilities are per-thread on Linux, and the Go runtime has
// several) and forbids regaining privileges through execve.
func dropPrivileges() error {
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return err
	}
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var data [2]unix.CapUserData
	_, _, errno := syscall.AllThreadsSyscall(syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data[0])), 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "telluric-capture:", err)
	os.Exit(1)
}

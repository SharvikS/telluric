// Command telluric-capture is Telluric's privileged capture helper.
//
// It is the only part of Telluric that needs CAP_NET_RAW, and it needs it
// for exactly one thing: opening and configuring a TPACKET_V3 ring. The
// moment the ring exists, the helper sets no_new_privs and re-executes
// itself, handing the ring's socket to the new process image. Under
// no_new_privs the kernel ignores file capabilities on execve, so the
// process that actually reads packets is born without any privilege, on
// every thread — no reliance on per-thread capset calls (which Go cannot
// apply to all threads in cgo builds). The new image verifies that, then
// streams frames to stdout as pcapng (LINKTYPE_LINUX_SLL2 with direction
// flags, plus an interface statistics block every second with kernel drop
// counters). The engine, which parses those untrusted bytes, never runs
// privileged either.
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
	"runtime"
	"strconv"
	"strings"
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
	ringFD := flag.Int("ring-fd", -1, "internal: adopt the ring on this inherited socket")
	blockSize := flag.Int("ring-block", 0, "internal: block size of the adopted ring")
	flag.Parse()

	// Die with the engine instead of capturing into the void.
	_ = unix.Prctl(unix.PR_SET_PDEATHSIG, uintptr(unix.SIGTERM), 0, 0, 0)
	if os.Getppid() == 1 {
		os.Exit(0)
	}
	if *ringFD >= 0 {
		capture2(*ringFD, capture.RingOptions{Interface: *iface, Snaplen: *snaplen, Blocks: *blocks, BlockSize: *blockSize})
		return
	}

	// Stage 1, privileged: open and configure the ring, then shed every
	// privilege by re-executing under no_new_privs with the socket inherited.
	ring, err := capture.OpenRing(capture.RingOptions{Interface: *iface, Snaplen: *snaplen, Blocks: *blocks})
	if errors.Is(err, capture.ErrPermission) {
		exe, _ := os.Executable()
		fatal(fmt.Errorf("no CAP_NET_RAW; grant it once with:\n  sudo setcap cap_net_raw,cap_net_admin=ep %s", exe))
	}
	if err != nil {
		fatal(err)
	}
	fd, opt := ring.FD(), ring.Options()
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, 0); err != nil { // keep it open across exec
		fatal(err)
	}
	// execve builds the new image from the credentials of the calling
	// thread alone, so preparing this one locked thread is enough — no
	// matter how many threads the Go runtime (or cgo) started:
	//   - clear ambient capabilities, which would otherwise survive exec;
	//   - for uid 0, set SECBIT_NOROOT so exec doesn't grant root's
	//     capabilities (needs CAP_SETPCAP; harmless to fail for non-root);
	//   - set no_new_privs, so file capabilities are ignored on exec.
	runtime.LockOSThread()
	_ = unix.Prctl(unix.PR_CAP_AMBIENT, unix.PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)
	if os.Geteuid() == 0 {
		const secbitNoRoot, secbitNoRootLocked = 1 << 0, 1 << 1
		if err := unix.Prctl(unix.PR_SET_SECUREBITS, secbitNoRoot|secbitNoRootLocked, 0, 0, 0); err != nil {
			fatal(fmt.Errorf("securebits: %w", err))
		}
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fatal(fmt.Errorf("no_new_privs: %w", err))
	}
	args := []string{os.Args[0],
		"-i", *iface, "-s", strconv.Itoa(opt.Snaplen), "-B", strconv.Itoa(opt.Blocks),
		"--ring-block", strconv.Itoa(opt.BlockSize), "--ring-fd", strconv.Itoa(fd)}
	err = unix.Exec("/proc/self/exe", args, os.Environ())
	fatal(fmt.Errorf("re-exec: %w", err)) // only reached if exec failed
}

// capture2 is stage 2: born without privileges, it adopts the ring and
// streams it.
func capture2(fd int, opt capture.RingOptions) {
	if err := ensureUnprivileged(); err != nil {
		fatal(err)
	}
	ring, err := capture.AdoptRing(fd, opt, "ring:"+opt.Interface)
	if err != nil {
		fatal(err)
	}
	out, err := capture.NewNGWriter(os.Stdout, uint32(opt.Snaplen))
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

// ensureUnprivileged verifies the re-executed image holds no capabilities.
// Stage 1 arranged for exec to grant none; should any remain anyway (an
// unusual kernel or security module), it clears them on every thread where
// the Go runtime allows it, and otherwise refuses to go on.
func ensureUnprivileged() error {
	if heldCaps() == "" {
		return nil
	}
	hdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}
	var data [2]unix.CapUserData
	_, _, errno := syscall.AllThreadsSyscall(syscall.SYS_CAPSET,
		uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data[0])), 0)
	if errno != 0 {
		return fmt.Errorf("still privileged after re-exec (%s) and cannot drop: %v — refusing to capture", heldCaps(), errno)
	}
	if held := heldCaps(); held != "" {
		return fmt.Errorf("still privileged (%s) — refusing to capture", held)
	}
	return nil
}

// heldCaps lists the non-empty capability sets of this process.
func heldCaps() string {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return "unknown"
	}
	var held []string
	for line := range strings.SplitSeq(string(b), "\n") {
		for _, set := range []string{"CapPrm:", "CapEff:", "CapAmb:"} {
			if strings.HasPrefix(line, set) && strings.Trim(strings.TrimSpace(line[len(set):]), "0") != "" {
				held = append(held, strings.TrimSuffix(set, ":"))
			}
		}
	}
	return strings.Join(held, ",")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "telluric-capture:", err)
	os.Exit(1)
}

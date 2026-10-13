// Package procmap attributes sockets to the processes that own them, the way
// ss -p and netstat -p do: /proc/net/{tcp,tcp6,udp,udp6} map socket tuples
// to inode numbers, and /proc/<pid>/fd/* links name the inodes each process
// holds. cgroup paths add context: the systemd unit, Flatpak app or
// container a process belongs to.
package procmap

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"net/netip"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Socket identifies a local socket from the network's point of view.
type Socket struct {
	Proto  uint8 // 6 TCP, 17 UDP
	Local  netip.AddrPort
	Remote netip.AddrPort
}

// Key identifies a process instance: PIDs are reused, start times are not.
type Key struct {
	PID   int
	Start uint64 // clock ticks after boot
}

// Process describes a process that owns sockets.
type Process struct {
	Key       Key
	PID       int
	PPID      int
	Name      string
	Exe       string
	Cmd       string
	UID       int
	User      string
	Unit      string // systemd unit or scope
	Container string // short container ID (Docker, Podman)
	App       string // Flatpak application ID
}

// Resolver resolves sockets to processes. It is not safe for concurrent
// use; the engine drives it from a single worker goroutine.
type Resolver struct {
	root     string
	owners   map[uint64]Key // socket inode → owner
	procs    map[Key]*Process
	lastScan time.Time
	lastFull time.Time
	users    map[int]string
}

// New returns a resolver reading the given proc root (normally "/proc").
func New(root string) *Resolver {
	return &Resolver{root: root, owners: map[uint64]Key{}, procs: map[Key]*Process{}, users: map[int]string{}}
}

// Scans of /proc/*/fd are the expensive part (~4 ms for ~500 processes).
// A targeted scan for unknown sockets runs at most every minRescan and stops
// as soon as it found them; a full rebuild (which also forgets dead
// processes) runs every fullRescan.
const (
	minRescan  = 20 * time.Millisecond
	fullRescan = 5 * time.Second
)

type entry struct {
	local, remote netip.AddrPort
	inode         uint64
}

// Resolve returns the owning process of each socket, or nil where unknown.
func (r *Resolver) Resolve(socks []Socket) []*Process {
	tables := map[uint8][]entry{}
	for _, s := range socks {
		if _, ok := tables[s.Proto]; ok {
			continue
		}
		switch s.Proto {
		case 6:
			tables[6] = append(r.readTable("tcp"), r.readTable("tcp6")...)
		case 17:
			tables[17] = append(r.readTable("udp"), r.readTable("udp6")...)
		}
	}

	inodes := make([]uint64, len(socks))
	want := map[uint64]bool{}
	for i, s := range socks {
		inodes[i] = match(tables[s.Proto], s)
		if inodes[i] != 0 {
			if _, ok := r.owners[inodes[i]]; !ok {
				want[inodes[i]] = true
			}
		}
	}
	switch {
	case time.Since(r.lastFull) >= fullRescan:
		r.scan(nil)
	case len(want) > 0 && time.Since(r.lastScan) >= minRescan:
		r.scan(want)
	}
	out := make([]*Process, len(socks))
	for i, ino := range inodes {
		if ino == 0 {
			continue
		}
		if key, ok := r.owners[ino]; ok {
			out[i] = r.procs[key]
		}
	}
	return out
}

// match finds the inode of s: an exact 4-tuple first, then (for UDP) an
// unconnected socket bound to the local address or to the wildcard.
func match(table []entry, s Socket) uint64 {
	local := netip.AddrPortFrom(s.Local.Addr().Unmap(), s.Local.Port())
	remote := netip.AddrPortFrom(s.Remote.Addr().Unmap(), s.Remote.Port())
	var bound, wildcard uint64
	for _, e := range table {
		if e.local.Port() != local.Port() {
			continue
		}
		if e.local == local && e.remote == remote {
			return e.inode
		}
		if e.remote.Port() == 0 && e.remote.Addr().IsUnspecified() {
			switch {
			case e.local.Addr() == local.Addr():
				bound = e.inode
			case e.local.Addr().IsUnspecified():
				wildcard = e.inode
			}
		}
	}
	if s.Proto == 17 {
		if bound != 0 {
			return bound
		}
		return wildcard
	}
	return 0 // TCP: only the exact connection counts, never the listener
}

func (r *Resolver) readTable(name string) []entry {
	f, err := os.Open(filepath.Join(r.root, "net", name))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []entry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	sc.Scan() // header
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 {
			continue
		}
		local, ok1 := parseHexAddr(fields[1])
		remote, ok2 := parseHexAddr(fields[2])
		inode, err := strconv.ParseUint(fields[9], 10, 64)
		if !ok1 || !ok2 || err != nil || inode == 0 {
			continue
		}
		out = append(out, entry{local, remote, inode})
	}
	return out
}

// parseHexAddr parses the kernel's "0100007F:0277" notation: addresses are
// 32-bit words printed in host (little-endian) order, ports big-endian.
func parseHexAddr(s string) (netip.AddrPort, bool) {
	ipHex, portHex, ok := strings.Cut(s, ":")
	if !ok {
		return netip.AddrPort{}, false
	}
	port, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil {
		return netip.AddrPort{}, false
	}
	raw, err := hex.DecodeString(ipHex)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return netip.AddrPort{}, false
	}
	for i := 0; i+4 <= len(raw); i += 4 {
		raw[i], raw[i+1], raw[i+2], raw[i+3] = raw[i+3], raw[i+2], raw[i+1], raw[i]
	}
	var addr netip.Addr
	if len(raw) == 4 {
		addr = netip.AddrFrom4([4]byte(raw))
	} else {
		addr = netip.AddrFrom16([16]byte(raw)).Unmap()
	}
	return netip.AddrPortFrom(addr, uint16(port)), true
}

var socketLink = []byte("socket:[")

// scan indexes socket inodes from /proc/*/fd. With want == nil it rebuilds
// the whole index; otherwise it visits the newest processes first — a
// short-lived client like curl is almost always among them — and stops as
// soon as every wanted inode is found, so it can catch processes that live
// only a few milliseconds.
func (r *Resolver) scan(want map[uint64]bool) {
	now := time.Now()
	r.lastScan = now
	dirs, err := os.ReadDir(r.root)
	if err != nil {
		return
	}
	pids := make([]int, 0, len(dirs))
	for _, d := range dirs {
		if pid, err := strconv.Atoi(d.Name()); err == nil {
			pids = append(pids, pid)
		}
	}
	slices.Sort(pids)
	slices.Reverse(pids)

	full := want == nil
	owners := r.owners
	alive := map[Key]bool{}
	if full {
		owners = make(map[uint64]Key, len(r.owners))
		r.lastFull = now
	}
	buf := make([]byte, 64)
	for _, pid := range pids {
		fdDir := filepath.Join(r.root, strconv.Itoa(pid), "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil || len(fds) == 0 {
			continue // kernel thread, or another user's process when unprivileged
		}
		var key Key
		known := false
		for _, fd := range fds {
			n, err := readlink(filepath.Join(fdDir, fd.Name()), buf)
			if err != nil || n < len(socketLink)+2 || !bytes.HasPrefix(buf[:n], socketLink) {
				continue
			}
			ino, err := strconv.ParseUint(string(buf[len(socketLink):n-1]), 10, 64)
			if err != nil {
				continue
			}
			if !known {
				key, known = r.keyOf(pid), true
				if key.PID == 0 {
					break
				}
				alive[key] = true
				if _, ok := r.procs[key]; !ok {
					r.procs[key] = r.describe(pid, key)
				}
			}
			owners[ino] = key
			delete(want, ino)
		}
		if !full && len(want) == 0 {
			break
		}
	}
	r.owners = owners
	if full {
		for k := range r.procs {
			if !alive[k] {
				delete(r.procs, k)
			}
		}
	}
}

func readlink(path string, buf []byte) (int, error) {
	s, err := os.Readlink(path)
	if err != nil {
		return 0, err
	}
	return copy(buf, s), nil
}

// keyOf reads the process start time (field 22 of /proc/<pid>/stat).
func (r *Resolver) keyOf(pid int) Key {
	b, err := os.ReadFile(filepath.Join(r.root, strconv.Itoa(pid), "stat"))
	if err != nil {
		return Key{}
	}
	// comm (field 2) may contain spaces and parentheses: split after the last ')'.
	i := bytes.LastIndexByte(b, ')')
	if i < 0 {
		return Key{}
	}
	fields := strings.Fields(string(b[i+1:]))
	if len(fields) < 20 {
		return Key{}
	}
	start, _ := strconv.ParseUint(fields[19], 10, 64)
	return Key{PID: pid, Start: start}
}

func (r *Resolver) describe(pid int, key Key) *Process {
	dir := filepath.Join(r.root, strconv.Itoa(pid))
	p := &Process{Key: key, PID: pid, UID: -1}
	if b, err := os.ReadFile(filepath.Join(dir, "comm")); err == nil {
		p.Name = strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile(filepath.Join(dir, "cmdline")); err == nil {
		cmd := strings.TrimSpace(strings.ReplaceAll(string(b), "\x00", " "))
		if len(cmd) > 300 {
			cmd = cmd[:300] + "…"
		}
		p.Cmd = cmd
	}
	if exe, err := os.Readlink(filepath.Join(dir, "exe")); err == nil {
		p.Exe = strings.TrimSuffix(exe, " (deleted)")
	}
	if b, err := os.ReadFile(filepath.Join(dir, "status")); err == nil {
		for line := range strings.SplitSeq(string(b), "\n") {
			switch {
			case strings.HasPrefix(line, "PPid:"):
				p.PPID, _ = strconv.Atoi(strings.TrimSpace(line[5:]))
			case strings.HasPrefix(line, "Uid:"):
				if f := strings.Fields(line[4:]); len(f) > 0 {
					p.UID, _ = strconv.Atoi(f[0])
				}
			}
		}
	}
	if p.UID >= 0 {
		p.User = r.username(p.UID)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "cgroup")); err == nil {
		p.Unit, p.Container, p.App = parseCgroup(string(b))
	}
	// Prefer the executable's name: comm is truncated to 15 bytes and
	// processes rename themselves ("Socket Process", "Isolated Web Co").
	// Interpreters are the exception: "python3" says less than the comm a
	// script may set.
	if base := filepath.Base(p.Exe); p.Exe != "" && !interpreter(base) {
		p.Name = base
	}
	return p
}

func interpreter(name string) bool {
	for _, i := range []string{"python", "node", "java", "ruby", "perl", "bash", "sh", "zsh", "fish", "dotnet", "deno", "bun", "php"} {
		if name == i || strings.HasPrefix(name, i) && strings.Trim(name[len(i):], "0123456789.") == "" {
			return true
		}
	}
	return false
}

func (r *Resolver) username(uid int) string {
	if u, ok := r.users[uid]; ok {
		return u
	}
	name := strconv.Itoa(uid)
	if u, err := user.LookupId(name); err == nil {
		name = u.Username
	}
	r.users[uid] = name
	return name
}

var (
	containerRe = regexp.MustCompile(`(?:docker|libpod|cri-containerd|crio)-([0-9a-f]{12,64})\.scope|/docker/([0-9a-f]{12,64})`)
	flatpakRe   = regexp.MustCompile(`app-flatpak-([A-Za-z0-9._-]+?)-\d+\.scope`)
)

// parseCgroup extracts the systemd unit, container and Flatpak app from a
// /proc/<pid>/cgroup file.
func parseCgroup(s string) (unit, container, app string) {
	for line := range strings.SplitSeq(strings.TrimSpace(s), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		path := parts[2]
		if m := containerRe.FindStringSubmatch(path); m != nil {
			id := m[1] + m[2]
			container = id[:12]
		}
		if m := flatpakRe.FindStringSubmatch(path); m != nil {
			app = m[1]
		}
		segs := strings.Split(path, "/")
		for i := len(segs) - 1; i >= 0; i-- {
			if strings.HasSuffix(segs[i], ".service") || strings.HasSuffix(segs[i], ".scope") {
				unit = segs[i]
				break
			}
		}
	}
	return unit, container, app
}

// Worker runs a Resolver on its own goroutine so /proc scans never stall
// the capture loop.
type Worker struct {
	reqs chan []Socket
	res  chan WorkerResult
	once sync.Once
	stop chan struct{}
}

// WorkerResult pairs a request with its answers.
type WorkerResult struct {
	Sockets []Socket
	Procs   []*Process
}

// StartWorker starts resolving on a background goroutine.
func StartWorker(root string) *Worker {
	w := &Worker{reqs: make(chan []Socket, 1), res: make(chan WorkerResult, 4), stop: make(chan struct{})}
	go func() {
		r := New(root)
		for {
			select {
			case socks := <-w.reqs:
				procs := r.Resolve(socks)
				select {
				case w.res <- WorkerResult{socks, procs}:
				case <-w.stop:
					return
				}
			case <-w.stop:
				return
			}
		}
	}()
	return w
}

// Submit queues a request; it returns false if the worker is still busy
// with the previous one.
func (w *Worker) Submit(socks []Socket) bool {
	select {
	case w.reqs <- socks:
		return true
	default:
		return false
	}
}

// Results delivers answers.
func (w *Worker) Results() <-chan WorkerResult { return w.res }

// Stop ends the worker.
func (w *Worker) Stop() { w.once.Do(func() { close(w.stop) }) }

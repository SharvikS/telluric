// Command telluric renders this machine's live network traffic on a 3D globe.
//
//	telluric                 live capture (needs the capture helper or root)
//	telluric --demo          a synthetic world; no privileges needed
//	telluric --replay x.pcap replay a capture in real time
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/SharvikS/telluric/internal/buildinfo"
	"github.com/SharvikS/telluric/internal/capture"
	"github.com/SharvikS/telluric/internal/detect"
	"github.com/SharvikS/telluric/internal/engine"
	"github.com/SharvikS/telluric/internal/event"
	"github.com/SharvikS/telluric/internal/geo"
	"github.com/SharvikS/telluric/internal/intel"
	"github.com/SharvikS/telluric/internal/procmap"
	"github.com/SharvikS/telluric/internal/server"
	"github.com/SharvikS/telluric/internal/synth"
	"github.com/SharvikS/telluric/internal/ws"
	"github.com/SharvikS/telluric/web"
)

type options struct {
	demo      bool
	replay    string
	speed     float64
	iface     string
	method    string
	listen    string
	home      string
	noSTUN    bool
	dataDir   string
	noUpdate  bool
	updateGeo bool
	open      bool
	uiDir     string
	noProcs   bool
	noDetect  bool
	verbose   bool
	version   bool
}

func main() {
	var o options
	flag.BoolVar(&o.demo, "demo", false, "run a synthetic world instead of capturing (no privileges needed)")
	flag.StringVar(&o.replay, "replay", "", "replay a pcap/pcapng `file` in real time")
	flag.Float64Var(&o.speed, "speed", 1, "replay speed multiplier")
	flag.StringVar(&o.iface, "i", "any", "capture `interface` (any = all)")
	flag.StringVar(&o.method, "capture", "auto", "capture method: auto, ring, helper, dumpcap")
	flag.StringVar(&o.listen, "listen", "127.0.0.1:7777", "UI address (keep it on loopback unless you know why)")
	flag.StringVar(&o.home, "home", "", "home location as `lat,lon` (default: STUN + geolocation, else time zone)")
	flag.BoolVar(&o.noSTUN, "no-stun", false, "don't ask a STUN server for the public address")
	flag.StringVar(&o.dataDir, "data-dir", "", "where geolocation databases live (default ~/.local/share/telluric)")
	flag.BoolVar(&o.noUpdate, "no-update", false, "don't download or refresh the geolocation databases")
	flag.BoolVar(&o.updateGeo, "update-geo", false, "download the geolocation databases and exit")
	flag.BoolVar(&o.open, "open", false, "open the UI in the default browser")
	flag.StringVar(&o.uiDir, "ui-dir", "", "serve the UI from this `directory` instead of the embedded copy (development)")
	flag.BoolVar(&o.noProcs, "no-procs", false, "don't attribute traffic to processes")
	flag.BoolVar(&o.noDetect, "no-detect", false, "disable threat detection and feed downloads")
	flag.BoolVar(&o.verbose, "v", false, "verbose logging")
	flag.BoolVar(&o.version, "version", false, "print the version and exit")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "telluric %s — your network traffic, live on a 3D globe\n\nusage: telluric [flags]\n\n", buildinfo.Version)
		flag.PrintDefaults()
	}
	flag.Parse()
	if o.version {
		fmt.Println("telluric", buildinfo.Version)
		return
	}
	if err := run(o); err != nil {
		var pe *capture.PrivilegeError
		if errors.As(err, &pe) {
			explainPrivileges(pe)
		} else {
			fmt.Fprintln(os.Stderr, "telluric:", err)
		}
		os.Exit(1)
	}
}

func explainPrivileges(pe *capture.PrivilegeError) {
	const bold, dim, cyan, reset = "\033[1m", "\033[2m", "\033[36m", "\033[0m"
	fmt.Fprintf(os.Stderr, `
%stelluric can't see packets yet%s — capturing needs CAP_NET_RAW.

  Grant it to the tiny capture helper, once:

      %ssudo setcap cap_net_raw,cap_net_admin=ep %s%s

  %sThe helper drops every capability right after opening its socket;
  the engine that parses packets never runs privileged.%s

  Or run Telluric with sudo, join the wireshark group to use dumpcap,
  or explore a synthetic world right now:  %stelluric --demo%s

`, bold, reset, cyan, pe.Helper, reset, dim, reset, cyan, reset)
	for _, t := range pe.Tried {
		fmt.Fprintf(os.Stderr, "  %stried %s%s\n", dim, t, reset)
	}
	fmt.Fprintln(os.Stderr)
}

func run(o options) error {
	logger := log.New(os.Stderr, "", log.Ltime)
	logf := func(format string, args ...any) { logger.Printf(format, args...) }
	vlogf := func(string, ...any) {}
	if o.verbose {
		vlogf = logf
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dataDir := o.dataDir
	if dataDir == "" {
		dataDir = defaultDataDir()
	}
	if o.updateGeo {
		return geo.Update(ctx, dataDir, func(s string) { logf("%s", s) })
	}

	// Pick the packet source.
	var (
		src   capture.Source
		mode  = "live"
		procs engine.ProcAttributor
		loc   engine.Locator
		home  geo.Home
	)
	locator := geo.NewLocator()
	switch {
	case o.demo:
		demo := synth.New(uint64(time.Now().UnixNano()))
		src, mode, procs, loc, home = demo, "demo", demo.Attributor(), synth.NewLocator(), synth.Home
	case o.replay != "":
		s, err := capture.OpenFile(o.replay, true, o.speed)
		if err != nil {
			return err
		}
		src, mode, loc = s, "replay", locator
	default:
		s, err := capture.Open(capture.Options{Method: o.method, Interface: o.iface})
		if err != nil {
			return err
		}
		src, loc = s, locator
		if !o.noProcs {
			w := procmap.StartWorker("/proc")
			defer w.Stop()
			procs = w
		}
	}
	defer src.Close()
	logf("capture: %s", src.Name())

	// Geolocation: use what's on disk now, refresh in the background.
	if mode != "demo" {
		if err := locator.OpenDir(dataDir); err != nil {
			logf("geolocation databases not ready yet (%s)", dataDir)
		}
		defer locator.Close()
	}

	// Detection: threat-intel feeds plus the behavioural detectors.
	intelSet := intel.NewSet()
	intelDir := filepath.Join(dataDir, "intel")
	if mode == "demo" {
		for ip, src := range synth.IntelIPs() {
			intelSet.AddIP(ip, intel.Hit{Kind: intel.KindC2, Source: src})
		}
	} else if err := intelSet.Load(intelDir); err == nil {
		vlogf("threat intel: %d entries", intelSet.Size())
	}
	var observer event.Observer
	if !o.noDetect {
		observer = detect.New(intelSet)
	}
	var localAddrs func() []netip.Addr
	if mode == "live" {
		localAddrs = engine.InterfaceAddrs
	}

	eng := engine.New(engine.Config{
		Source:        src,
		Mode:          mode,
		Locator:       loc,
		Home:          home,
		Procs:         procs,
		Observer:      observer,
		Hostname:      hostname(mode),
		Credits:       credits(mode),
		Logf:          vlogf,
		LocalAddrs:    localAddrs,
		AllInterfaces: o.iface == "" || o.iface == "any",
	})

	if mode != "demo" {
		go func() {
			if !o.noUpdate && (geo.Stale(dataDir, geo.CityFile) || geo.Stale(dataDir, geo.ASNFile)) {
				logf("fetching DB-IP Lite geolocation databases into %s …", dataDir)
				if err := geo.Update(ctx, dataDir, func(s string) { vlogf("%s", s) }); err != nil {
					logf("geolocation update failed: %v", err)
				} else if err := locator.OpenDir(dataDir); err == nil {
					logf("geolocation ready")
					eng.GeoUpdated()
					chownToSudoUser(dataDir)
				}
			}
			h := geo.Resolve(ctx, o.home, !o.noSTUN, locator)
			vlogf("home: %+v", h)
			eng.SetHome(h)
			if !o.noUpdate && !o.noDetect && intel.Stale(intelDir, 6*time.Hour) {
				if err := intel.Update(ctx, intelDir); err != nil {
					logf("threat feed update failed: %v", err)
				} else if err := intelSet.Load(intelDir); err == nil {
					logf("threat intel: %d indicators loaded", intelSet.Size())
					chownToSudoUser(intelDir)
				}
			}
		}()
	} else if o.home != "" {
		if lat, lon, err := geo.ParseLatLon(o.home); err == nil {
			eng.SetHome(geo.Home{Lat: lat, Lon: lon, Known: true, Src: "flag"})
		}
	}

	// The UI.
	var ui fs.FS = web.UI()
	if o.uiDir != "" {
		ui = os.DirFS(o.uiDir)
	}
	srv := server.New(server.Config{
		Listen:    o.listen,
		UI:        ui,
		Logf:      vlogf,
		Subscribe: func(c *ws.Conn) { eng.Subscribe(c) },
	})
	url, err := srv.Start()
	if err != nil {
		return err
	}
	banner(url, mode, src.Name())
	if o.open {
		openBrowser(url)
	}

	errc := make(chan error, 1)
	go func() { errc <- eng.Run(ctx) }()
	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	stop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
	fmt.Fprintf(os.Stderr, "\n%d frames processed. Bye.\n", eng.Frames())
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func banner(url, mode, source string) {
	const cyan, dim, bold, reset = "\033[36m", "\033[2m", "\033[1m", "\033[0m"
	fmt.Fprintf(os.Stderr, "\n%s%s  ╔╦╗╔═╗╦  ╦  ╦ ╦╦═╗╦╔═╗\n   ║ ║╣ ║  ║  ║ ║╠╦╝║║  \n   ╩ ╚═╝╩═╝╩═╝╚═╝╩╚═╩╚═╝%s  %s%s%s\n\n",
		bold, cyan, reset, dim, buildinfo.Version, reset)
	fmt.Fprintf(os.Stderr, "  mode    %s (%s)\n  globe   %s%s%s\n\n", mode, source, bold, url, reset)
}

func openBrowser(url string) {
	if os.Geteuid() == 0 {
		return // never launch a browser as root
	}
	_ = exec.Command("xdg-open", url).Start()
}

func hostname(mode string) string {
	if mode == "demo" {
		return "demo-workstation"
	}
	h, _ := os.Hostname()
	return h
}

func credits(mode string) []string {
	c := []string{"Map data: Natural Earth (public domain)"}
	if mode != "demo" {
		c = append(c, geo.Credit, intel.Credit())
	}
	return c
}

// defaultDataDir is ~/.local/share/telluric of the invoking user, even
// under sudo.
func defaultDataDir() string {
	home, _ := os.UserHomeDir()
	if sudo := os.Getenv("SUDO_USER"); sudo != "" && os.Geteuid() == 0 {
		if u, err := user.Lookup(sudo); err == nil {
			home = u.HomeDir
		}
	} else if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "telluric")
	}
	return filepath.Join(home, ".local", "share", "telluric")
}

// chownToSudoUser hands files we downloaded as root back to the user who ran sudo.
func chownToSudoUser(dir string) {
	uid, err1 := strconv.Atoi(os.Getenv("SUDO_UID"))
	gid, err2 := strconv.Atoi(os.Getenv("SUDO_GID"))
	if os.Geteuid() != 0 || err1 != nil || err2 != nil {
		return
	}
	_ = filepath.WalkDir(dir, func(p string, _ fs.DirEntry, err error) error {
		if err == nil {
			_ = os.Chown(p, uid, gid)
		}
		return nil
	})
}

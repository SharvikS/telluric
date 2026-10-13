package geo

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/SharvikS/telluric/internal/buildinfo"
)

// maxAge is how old a database may get before we fetch the next release.
// DB-IP publishes the Lite databases monthly.
const maxAge = 35 * 24 * time.Hour

// Stale reports whether the database file in dir is missing or older than
// a month.
func Stale(dir, file string) bool {
	st, err := os.Stat(filepath.Join(dir, file))
	return err != nil || time.Since(st.ModTime()) > maxAge
}

// Update downloads the current DB-IP Lite release of the city and ASN
// databases into dir, skipping files that are fresh. Each file is written
// to a temporary name and renamed into place, so an interrupted download
// never leaves a corrupt database behind.
func Update(ctx context.Context, dir string, progress func(string)) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, kind := range []struct{ file, name string }{{ASNFile, "asn"}, {CityFile, "city"}} {
		if !Stale(dir, kind.file) {
			continue
		}
		if err := download(ctx, dir, kind.file, kind.name, progress); err != nil {
			return err
		}
	}
	return nil
}

func download(ctx context.Context, dir, file, kind string, progress func(string)) error {
	now := time.Now().UTC()
	var lastErr error
	// The new month's file appears a little after the 1st; fall back to the
	// previous release.
	for _, month := range []time.Time{now, now.AddDate(0, -1, 0)} {
		url := fmt.Sprintf("https://download.db-ip.com/free/dbip-%s-lite-%s.mmdb.gz", kind, month.Format("2006-01"))
		if progress != nil {
			progress("downloading " + url)
		}
		err := fetchGzip(ctx, url, filepath.Join(dir, file))
		if err == nil {
			return nil
		}
		lastErr = err
	}
	return lastErr
}

func fetchGzip(ctx context.Context, url, dst string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", buildinfo.UserAgent())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("geo: %s: %s", url, resp.Status)
	}
	zr, err := gzip.NewReader(resp.Body)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, io.LimitReader(zr, 2<<30)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

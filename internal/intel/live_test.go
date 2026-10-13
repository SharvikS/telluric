package intel

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestLiveFeeds(t *testing.T) {
	if os.Getenv("TELLURIC_NET_TESTS") == "" {
		t.Skip("set TELLURIC_NET_TESTS=1 to download the real feeds")
	}
	dir := filepath.Join("..", "..", "data", "intel")
	if err := Update(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	s := NewSet()
	if err := s.Load(dir); err != nil {
		t.Fatal(err)
	}
	t.Logf("loaded %d entries", s.Size())
	for _, f := range feeds {
		st, err := os.Stat(filepath.Join(dir, f.file))
		if err != nil {
			t.Errorf("%s: %v", f.source, err)
			continue
		}
		t.Logf("%-24s %8d bytes", f.source, st.Size())
	}
	if s.Size() < 1000 {
		t.Fatalf("suspiciously few entries: %d", s.Size())
	}
}

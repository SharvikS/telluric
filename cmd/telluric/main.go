// Command telluric renders this machine's live network traffic on a 3D globe.
package main

import (
	"fmt"
	"os"

	"github.com/SharvikS/telluric/internal/buildinfo"
)

func main() {
	fmt.Fprintf(os.Stderr, "telluric %s — engine under construction\n", buildinfo.Version)
}

// Command telluric-capture is Telluric's privileged capture helper. It is the
// only component that needs CAP_NET_RAW; it streams captured frames to stdout
// as a standard pcap stream.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "telluric-capture: under construction")
	os.Exit(1)
}

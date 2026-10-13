// Package buildinfo carries version information stamped in at link time.
package buildinfo

// Version is set with -ldflags "-X github.com/SharvikS/telluric/internal/buildinfo.Version=…".
var Version = "dev"

// UserAgent identifies Telluric in outbound HTTP requests (database and feed downloads).
func UserAgent() string { return "telluric/" + Version + " (+https://github.com/SharvikS/telluric)" }

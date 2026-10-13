// Package web embeds the Telluric browser UI into the binary.
package web

import (
	"embed"
	"io/fs"
)

//go:embed ui
var embedded embed.FS

// UI returns the UI file tree rooted at web/ui.
func UI() fs.FS {
	sub, err := fs.Sub(embedded, "ui")
	if err != nil {
		panic(err) // the directory is embedded at compile time; this cannot fail
	}
	return sub
}

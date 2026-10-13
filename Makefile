GO      ?= go
BIN     := bin
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/SharvikS/telluric/internal/buildinfo.Version=$(VERSION)
GOBUILD := CGO_ENABLED=0 $(GO) build -trimpath -ldflags '$(LDFLAGS)'

# The capture helper carries file capabilities (setcap). Rebuilding it replaces
# the file and drops them, so it is a real file target that only rebuilds when
# its own sources change.
HELPER_SRC := $(shell find cmd/telluric-capture internal/capture -name '*.go' -not -name '*_test.go' 2>/dev/null)

.PHONY: all build engine test race fuzz bench vet run demo setcap assets clean

all: build

build: engine $(BIN)/telluric-capture

engine:
	$(GOBUILD) -o $(BIN)/telluric ./cmd/telluric

$(BIN)/telluric-capture: $(HELPER_SRC)
	$(GOBUILD) -o $@ ./cmd/telluric-capture
	@echo "note: re-run 'make setcap' — rebuilding the helper drops its capabilities"

# One-time: let the helper (and only the helper) open raw sockets.
setcap: $(BIN)/telluric-capture
	sudo setcap cap_net_raw=ep $(BIN)/telluric-capture
	getcap $(BIN)/telluric-capture

test:
	$(GO) test ./...

race:
	$(GO) test -race ./...

vet:
	$(GO) vet ./...

# Run every fuzz target for FUZZTIME each (default 20s).
FUZZTIME ?= 20s
fuzz:
	@for pkg in $$($(GO) list ./...); do \
	  for f in $$($(GO) test -list '^Fuzz' $$pkg 2>/dev/null | grep '^Fuzz'); do \
	    echo "== $$pkg $$f"; $(GO) test -run '^$$' -fuzz "^$$f$$" -fuzztime $(FUZZTIME) $$pkg || exit 1; \
	  done; \
	done

bench:
	$(GO) test -run '^$$' -bench . -benchmem ./internal/...

run: build
	./$(BIN)/telluric

demo: engine
	./$(BIN)/telluric --demo

assets:
	$(GO) run ./tools/geogen -out web/ui/assets

clean:
	rm -rf $(BIN)

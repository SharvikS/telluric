package engine

import (
	"math"
	"slices"
	"time"

	"github.com/SharvikS/telluric/internal/decode"
	"github.com/SharvikS/telluric/internal/event"
	"github.com/SharvikS/telluric/internal/wire"
)

type globalStats struct {
	rxAcc, txAcc, pktAcc uint64
	rx, tx, pps          float64
	appAccs              [numApps]uint64
	appRates             [numApps]float64
	totals               wire.Totals
	defcon               int
}

func (s *globalStats) appAcc(a App, n uint64) { s.appAccs[a] += n }

const (
	rateTau       = 2.0 // seconds
	maxHistory    = 300
	maxAlertLog   = 200
	maxSnapshot   = 5000
	maxDeltaBatch = 1000
)

func round(v float64, places int) float64 {
	p := math.Pow10(places)
	return math.Round(v*p) / p
}

// ewma folds the bytes accumulated over dt seconds into a smoothed rate and
// reports whether the published value changed.
func ewma(rate *float64, acc *uint64, dt, alpha float64) bool {
	inst := float64(*acc) / dt
	*acc = 0
	old := *rate
	*rate += alpha * (inst - *rate)
	if *rate < 1 {
		*rate = 0
	}
	return math.Round(*rate) != math.Round(old)
}

func (e *Engine) updateRates() {
	dt := float64(e.now-e.lastRates) / 1e9
	e.lastRates = e.now
	if dt <= 0 || dt > 5 {
		dt = rateEvery.Seconds()
	}
	alpha := 1 - math.Exp(-dt/rateTau)
	for _, fl := range e.flows {
		a := ewma(&fl.rateIn, &fl.accIn, dt, alpha)
		b := ewma(&fl.rateOut, &fl.accOut, dt, alpha)
		if a || b {
			fl.dirty = true
		}
	}
	for _, ep := range e.eps {
		a := ewma(&ep.rateIn, &ep.accIn, dt, alpha)
		b := ewma(&ep.rateOut, &ep.accOut, dt, alpha)
		if a || b {
			ep.dirty = true
		}
	}
	for _, pr := range e.procs {
		a := ewma(&pr.rateIn, &pr.accIn, dt, alpha)
		b := ewma(&pr.rateOut, &pr.accOut, dt, alpha)
		if a || b {
			pr.dirty = true
		}
	}
	s := &e.stats
	ewma(&s.rx, &s.rxAcc, dt, alpha)
	ewma(&s.tx, &s.txAcc, dt, alpha)
	ewma(&s.pps, &s.pktAcc, dt, alpha)
	for i := range s.appAccs {
		ewma(&s.appRates[i], &s.appAccs[i], dt, alpha)
	}
}

func (e *Engine) flushDeltas() {
	var eps []wire.Endpoint
	for _, ep := range e.eps {
		if ep.dirty {
			ep.dirty = false
			eps = append(eps, e.wireEP(ep))
		}
	}
	var procs []wire.Proc
	for _, pr := range e.procs {
		if pr.dirty {
			pr.dirty = false
			procs = append(procs, wireProc(pr))
		}
	}
	var flows []wire.Flow
	for _, fl := range e.flows {
		if fl.dirty {
			fl.dirty = false
			flows = append(flows, wireFlow(fl))
		}
	}
	// Endpoints and processes before the flows that reference them.
	for b := range slices.Chunk(eps, maxDeltaBatch) {
		e.broadcast(wire.EncodeEndpoints(b), true, false)
	}
	for b := range slices.Chunk(procs, maxDeltaBatch) {
		e.broadcast(wire.EncodeProcs(b), true, false)
	}
	for b := range slices.Chunk(flows, maxDeltaBatch) {
		e.broadcast(wire.EncodeFlows(b), true, false)
	}
	if len(e.dnsOut) > 0 {
		e.broadcast(wire.EncodeDNS(e.dnsOut), true, false)
		e.dnsOut = nil
	}
	e.flushAlerts()
	if len(e.gone.Flows)+len(e.gone.EPs)+len(e.gone.Procs) > 0 {
		e.broadcast(wire.EncodeGone(e.gone), true, false)
		e.gone = wire.Gone{}
	}
}

func (e *Engine) flushAlerts() {
	if len(e.alertQ) > 0 {
		e.broadcast(wire.EncodeAlerts(e.alertQ), true, false)
		e.alertQ = nil
	}
}

// flowTTL is how long a flow may stay idle before it expires.
func flowTTL(fl *flow) time.Duration {
	switch {
	case fl.state == tcpClosed || fl.state == tcpRst:
		return 3 * time.Second
	case fl.state == tcpFin:
		return 15 * time.Second
	case fl.isTCP() && fl.state == tcpSyn:
		return 20 * time.Second
	case fl.isTCP():
		return 5 * time.Minute
	case fl.app == AppDNS || fl.app == AppMDNS || fl.app == AppICMP:
		return 10 * time.Second
	}
	return 60 * time.Second
}

func (e *Engine) sweep() {
	for k, fl := range e.flows {
		if e.now-fl.last <= int64(flowTTL(fl)) {
			continue
		}
		delete(e.flows, k)
		e.releaseHello(fl)
		e.gone.Flows = append(e.gone.Flows, fl.id)
		if fl.state != tcpClosed && fl.state != tcpRst {
			e.flowEnded(fl)
		}
		ep := fl.ep
		if ep.flows--; ep.flows == 0 {
			ep.idleSince = e.now
		}
		ep.dirty = true
		if pr := fl.proc; pr != nil {
			if pr.flows--; pr.flows == 0 {
				pr.idleSince = e.now
			}
			pr.dirty = true
		}
	}
	for ip, ep := range e.eps {
		if ep.flows == 0 && e.now-ep.idleSince > int64(30*time.Second) {
			delete(e.eps, ip)
			e.gone.EPs = append(e.gone.EPs, ep.id)
		}
	}
	for k, pr := range e.procs {
		if pr.flows == 0 && e.now-pr.idleSince > int64(60*time.Second) {
			delete(e.procs, k)
			e.gone.Procs = append(e.gone.Procs, pr.id)
		}
	}
	e.pdns.sweep(e.now)
	for k, a := range e.alertKeys {
		if e.now-a.ts > int64(10*time.Minute) {
			delete(e.alertKeys, k)
		}
	}
}

func (e *Engine) statsMsg() wire.Stats {
	countries := map[string]struct{}{}
	for _, ep := range e.eps {
		if ep.flows > 0 && ep.loc.CC != "" {
			countries[ep.loc.CC] = struct{}{}
		}
	}
	apps := map[string]float64{}
	for i, r := range e.stats.appRates {
		if r >= 1 {
			apps[App(i).String()] = math.Round(r)
		}
	}
	defcon := e.stats.defcon
	if defcon == 0 {
		defcon = 5
	}
	return wire.Stats{
		TS:        e.now / 1e6,
		RX:        math.Round(e.stats.rx),
		TX:        math.Round(e.stats.tx),
		PPS:       math.Round(e.stats.pps),
		Flows:     len(e.flows),
		EPs:       len(e.eps),
		Countries: len(countries),
		Procs:     len(e.procs),
		Drops:     e.cfg.Source.Stats().Dropped,
		Defcon:    defcon,
		Apps:      apps,
		Totals:    e.stats.totals,
	}
}

func (e *Engine) pushHistory() {
	s := e.statsMsg()
	s.Apps = nil
	e.history = append(e.history, s)
	if len(e.history) > maxHistory {
		e.history = slices.Clone(e.history[len(e.history)-maxHistory:])
	}
}

func (e *Engine) snapshot() wire.Snapshot {
	s := wire.Snapshot{
		Endpoints: []wire.Endpoint{},
		Flows:     []wire.Flow{},
		Procs:     []wire.Proc{},
		Alerts:    slices.Clone(e.alerts),
		DNS:       slices.Clone(e.dnsLog),
		Stats:     e.statsMsg(),
		History:   slices.Clone(e.history),
	}
	flows := make([]*flow, 0, len(e.flows))
	for _, fl := range e.flows {
		flows = append(flows, fl)
	}
	if len(flows) > maxSnapshot {
		slices.SortFunc(flows, func(a, b *flow) int { return int(b.last - a.last) })
		flows = flows[:maxSnapshot]
	}
	seen := map[*endpoint]bool{}
	for _, fl := range flows {
		s.Flows = append(s.Flows, wireFlow(fl))
		if !seen[fl.ep] {
			seen[fl.ep] = true
			s.Endpoints = append(s.Endpoints, e.wireEP(fl.ep))
		}
	}
	for _, pr := range e.procs {
		s.Procs = append(s.Procs, wireProc(pr))
	}
	if s.Alerts == nil {
		s.Alerts = []wire.Alert{}
	}
	if s.DNS == nil {
		s.DNS = []wire.DNSEvent{}
	}
	if s.History == nil {
		s.History = []wire.Stats{}
	}
	return s
}

func wireFlow(fl *flow) wire.Flow {
	w := wire.Flow{
		ID:       fl.id,
		EP:       fl.ep.id,
		Proto:    protoName(fl.key.proto),
		App:      fl.app.String(),
		LPort:    fl.key.local.Port(),
		RPort:    fl.key.remote.Port(),
		Dir:      "in",
		State:    tcpStateNames[fl.state],
		SNI:      fl.sni,
		ALPN:     fl.alpn,
		TLSv:     decode.TLSVersionName(fl.tlsv),
		JA4:      fl.ja4,
		ECH:      fl.ech,
		PQ:       fl.pq,
		BytesIn:  fl.bytesIn,
		BytesOut: fl.bytesOut,
		PktsIn:   fl.pktsIn,
		PktsOut:  fl.pktsOut,
		RateIn:   math.Round(fl.rateIn),
		RateOut:  math.Round(fl.rateOut),
		Start:    fl.first / 1e6,
		Last:     fl.last / 1e6,
		Threat:   fl.threat,
	}
	if fl.out {
		w.Dir = "out"
	}
	if !fl.isTCP() {
		w.State = "active"
	}
	if fl.proc != nil {
		w.Proc = fl.proc.id
	}
	if fl.rtt > 0 {
		w.RTT = wire.Float(round(fl.rtt, 2))
	}
	return w
}

func protoName(p uint8) string {
	switch p {
	case decode.ProtoTCP:
		return "tcp"
	case decode.ProtoUDP:
		return "udp"
	case decode.ProtoICMP, decode.ProtoICMPv6:
		return "icmp"
	}
	return "other"
}

func (e *Engine) wireEP(ep *endpoint) wire.Endpoint {
	w := wire.Endpoint{
		ID:       ep.id,
		IP:       ep.ip.String(),
		Name:     ep.name,
		Names:    ep.names,
		Scope:    ep.scope,
		City:     ep.loc.City,
		Region:   ep.loc.Region,
		CC:       ep.loc.CC,
		Country:  ep.loc.Country,
		ASN:      ep.loc.ASN,
		Org:      ep.loc.Org,
		Svc:      ep.svc,
		Threat:   ep.threat,
		Tags:     ep.tags,
		First:    ep.first / 1e6,
		Last:     ep.last / 1e6,
		BytesIn:  ep.bytesIn,
		BytesOut: ep.bytesOut,
		RateIn:   math.Round(ep.rateIn),
		RateOut:  math.Round(ep.rateOut),
		Flows:    ep.flows,
	}
	if ep.located && ep.loc.HasCoord {
		w.Lat, w.Lon = wire.Float(round(ep.loc.Lat, 4)), wire.Float(round(ep.loc.Lon, 4))
	}
	return w
}

func wireProc(pr *proc) wire.Proc {
	w := wire.Proc{
		ID:       pr.id,
		PID:      pr.info.PID,
		Name:     pr.info.Name,
		Exe:      pr.info.Exe,
		Cmd:      pr.info.Cmd,
		User:     pr.info.User,
		Unit:     pr.info.Unit,
		BytesIn:  pr.bytesIn,
		BytesOut: pr.bytesOut,
		RateIn:   math.Round(pr.rateIn),
		RateOut:  math.Round(pr.rateOut),
		Flows:    pr.flows,
	}
	if pr.info.Container != "" {
		c := pr.info.Container
		w.Container = &c
	}
	if pr.info.App != "" && w.Unit == "" {
		w.Unit = pr.info.App
	}
	return w
}

// view fills the reusable observer view of fl.
func (e *Engine) view(fl *flow) *event.Flow {
	v := &e.fv
	*v = event.Flow{
		ID: fl.id, EP: fl.ep.id, Proto: fl.key.proto, Local: fl.key.local, Remote: fl.key.remote,
		Out: fl.out, App: fl.app.String(), State: tcpStateNames[fl.state], SNI: fl.sni, HTTPHost: fl.httpHost,
		JA4: fl.ja4, Name: fl.ep.name, Scope: fl.ep.scope, Located: fl.ep.located, CC: fl.ep.loc.CC,
		Org: fl.ep.loc.Org, ASN: fl.ep.loc.ASN, First: fl.first, Last: fl.last,
		BytesIn: fl.bytesIn, BytesOut: fl.bytesOut, PktsIn: fl.pktsIn, PktsOut: fl.pktsOut, RTT: fl.rtt,
	}
	if fl.proc != nil {
		v.Proc, v.ProcName, v.PID = fl.proc.id, fl.proc.info.Name, fl.proc.info.PID
	}
	return v
}

type alertRef struct {
	id uint32
	ts int64
}

// Raise implements event.Sink.
func (e *Engine) Raise(a event.Alert) {
	ep := e.eps[a.Remote]
	if ep == nil && a.EP != 0 {
		for _, x := range e.eps {
			if x.id == a.EP {
				ep = x
				break
			}
		}
	}
	w := wire.Alert{
		TS: e.now / 1e6, Sev: a.Sev.String(), Kind: a.Kind, Title: a.Title, Detail: a.Detail,
		Flow: a.Flow, Proc: a.Proc, Score: a.Score, Evidence: a.Evidence,
	}
	if ep != nil {
		w.EP = ep.id
		if a.Score > ep.threat {
			ep.threat = a.Score
		}
		if !slices.Contains(ep.tags, a.Kind) {
			ep.tags = append(ep.tags, a.Kind)
		}
		ep.dirty = true
		for _, fl := range e.flows {
			if fl.ep == ep && a.Score > fl.threat && (a.Flow == 0 || a.Flow == fl.id) {
				fl.threat, fl.dirty = a.Score, true
			}
		}
	}
	if e.alertKeys == nil {
		e.alertKeys = map[string]alertRef{}
	}
	if ref, ok := e.alertKeys[a.Key]; ok && a.Key != "" {
		w.ID = ref.id
		for i := range e.alerts {
			if e.alerts[i].ID == ref.id {
				e.alerts[i] = w
			}
		}
		e.alertKeys[a.Key] = alertRef{id: ref.id, ts: e.now}
	} else {
		e.nextAlert++
		w.ID = e.nextAlert
		e.alerts = append(e.alerts, w)
		if len(e.alerts) > maxAlertLog {
			e.alerts = slices.Clone(e.alerts[len(e.alerts)-maxAlertLog:])
		}
		if a.Key != "" {
			e.alertKeys[a.Key] = alertRef{id: w.ID, ts: e.now}
		}
	}
	e.alertQ = append(e.alertQ, w)
}

// SetDefcon implements event.Sink.
func (e *Engine) SetDefcon(level int) { e.stats.defcon = max(1, min(5, level)) }

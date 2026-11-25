//go:build unix

package gate

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"runtime"
	"runtime/debug"
	"runtime/metrics"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/manifest"
	"github.com/smojon/md-runbook/apps/gate/internal/names"
	"github.com/smojon/md-runbook/apps/gate/internal/procs"
	"github.com/smojon/md-runbook/apps/gate/internal/proto"
	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// ---- the cells' shells ----
// One for each signed runbook of the session: functions, aliases, traps, options and variables
// of another runbook don't carry over (security review, 2026-11-16). The cells of one runbook
// share theirs, as in a plain session, also when the session goes back to it after a call into
// another runbook (security review round 3). Up to 6 at a time: a 7th runbook ends the shell
// least recently used.
//
// Each shell reads a pipe only this gate holds: an anonymous pipe (no name anyone could open; the
// shell gate needed a FIFO removed once open). A process running as the account at the same time
// can still reach it through /proc: kill_leftovers ends those that outlived their session, at the
// start and end of each session.
//
// A watcher waits for each shell. When it ends by itself (`exit` in a cell), the session ends, as
// in a plain session; when it ends, its process group goes too (TERM, then KILL), and its scope
// (isolation.go). Each shell has a process group (and session) of its own, so that its blocks'
// background programs end with it.

const nSlots = 6

// slot: a place for a shell. hash: its runbook's manifest hash ("" for the session's first
// shell before a load); dirty: it ran unsigned text; used: when it was last switched to.
type slot struct {
	sh    *shell
	hash  string
	dirty bool
	used  int
}

// shell: leader is what the gate started (the shell itself, or the wrapper it runs under; for a
// Job's shell, kubectl, set under mu once it starts); pid and pgid are the shell's own (0 until
// found under a wrapper), cg its scope's cgroup folder.
type shell struct {
	n       int
	leader  int
	w       *os.File
	done    chan struct{}
	retired atomic.Bool

	mu        sync.Mutex
	pid, pgid int
	cg        string

	// In a Kubernetes Job (job.go): the pipe's read end until kubectl takes it, and whether it
	// started, was dropped before, or was sent anything.
	r                *os.File
	abort            chan struct{}
	abortOnce        sync.Once
	started, aborted bool
	sent             atomic.Bool
}

func (sh *shell) info() (pid, pgid int, cg string) {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	return sh.pid, sh.pgid, sh.cg
}

// session runs a session; the gate's exit code.
func (g *Gate) session() int {
	// Separated mode: in /tmp, which the cells' account can enter (TMPDIR may be the gate's own).
	base := tmpDir()
	if g.separated() {
		base = "/tmp"
	}
	work, err := os.MkdirTemp(base, "md-runbook-gate.")
	if err != nil {
		g.fatal("can't create a work folder")
	}
	g.work = work
	g.live = map[*shell]bool{}
	g.endCh = make(chan struct{}, 1)
	g.params = map[string]string{}
	g.rbManifest = map[string]*manifest.Manifest{}
	g.rbSigner = map[string]string{}
	g.started.Store(true)
	// The session's number: what its hello answers and a stop request names. 1 and 14 digits: a
	// whole number the app reads exactly (below 2^53).
	n, err := rand.Int(rand.Reader, big.NewInt(100000000000000))
	if err != nil {
		g.fatal("can't read /dev/urandom")
	}
	g.token = fmt.Sprintf("1%014d", n)
	g.skey = sha256Hex([]byte(g.token))

	// The shell the cells run in: bash --noprofile --norc, else sh, found in gate.conf's path. It
	// reads only what this gate writes; the cells themselves read /dev/null. Its environment: the
	// names in names.CellsEnv from the gate's own, SHELL, PATH, LANG and KUBECONFIG from
	// gate.conf, and MD_RUNBOOK_GATE_WHO (the key). During a signed run MD_RUNBOOK_GATE_RUN (its
	// id) lets tools log against it (md-runbook-probe on the ops host).
	if b := inPath(g.cfg.Path, "bash"); b != "" {
		g.cellsBin, g.cellsArgs = b, []string{"--noprofile", "--norc"}
	} else if s := inPath(g.cfg.Path, "sh"); s != "" {
		g.cellsBin = s
	} else {
		g.fatal("no bash or sh in path = " + g.cfg.Path)
	}
	// How the shells start: separated mode (checked before anything runs), then the isolation.
	g.plan = g.basePlan()
	g.unitID = randHex(6)
	if g.separated() {
		g.setupSeparated()
	}
	// A Kubernetes Job: its pod is the isolation (job.go).
	if g.jobMode() {
		g.setupJob()
		g.plan.iso = "pod"
	} else {
		g.resolveIsolation()
	}
	kv := []string{"event", "session", "unsigned", g.cfg.Unsigned, "scopes", g.cfg.Scopes, "key_scopes", g.keyScopes, "gate_mode", g.mode(), "isolation", g.plan.iso}
	if g.plan.iso == "none" && g.isoWhy != "" {
		kv = append(kv, "isolation_off", strings.TrimSuffix(g.isoWhy, "; "))
	}
	if g.separated() {
		kv = append(kv, "cells", g.cells.name)
	}
	if g.jobMode() {
		kv = append(kv, "cells_runner", g.cfg.CellsRunner, "job", g.job.name, "cells", g.job.sa)
	}
	kv = append(kv, g.certLog()...)
	g.log.Event(kv...)
	if g.reportProblem != "" {
		g.log.Event("event", "report", "status", "off", "reason", g.reportProblem)
	}
	if g.cfg.AllowNoGroupKill != "" {
		g.log.Event("event", "notice", "reason", "allow_no_group_kill in "+g.configPath+" is obsolete and ignored: each shell always has a process group of its own")
	}
	if g.reportOn && !g.apart() {
		if f, err := os.OpenFile(g.work+"/report-exits", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); err == nil {
			f.Close()
		}
	}
	// Before the first shell: no leftover of an earlier session finds it. (Separated mode: the
	// leased cells account has no process left already: leaseCells.)
	g.sweep("start")
	g.serve()
	g.cleanup()
	if g.signalled.Load() {
		return 1
	}
	// The cells' pod never came: the session failed (its reason is on stderr and in the log).
	if g.job != nil {
		g.job.mu.Lock()
		failed := g.job.err != ""
		g.job.mu.Unlock()
		if failed {
			return 2
		}
	}
	g.log.Event("event", "end-session")
	return 0
}

func tmpDir() string {
	if t := os.Getenv("TMPDIR"); t != "" {
		return t
	}
	return "/tmp"
}

// inPath: the first executable regular file NAME in the colon-separated folders.
func inPath(path, name string) string {
	for _, d := range strings.Split(path, ":") {
		f := d + "/" + name
		if st, err := os.Stat(f); err == nil && st.Mode().IsRegular() && executable(f) {
			return f
		}
	}
	return ""
}

// cellsEnv: the shell's environment. In separated mode HOME, USER and LOGNAME are the cells'
// account's, and TMPDIR is left out (the gate's may be its own): programs use /tmp.
func (g *Gate) cellsEnv() []string {
	env := []string{"SHELL=" + g.cellsBin, "PATH=" + g.cfg.Path, "LANG=" + g.cfg.Locale, "MD_RUNBOOK_GATE_WHO=" + g.who}
	if g.cfg.Kubeconfig != "" {
		env = append(env, "KUBECONFIG="+g.cfg.Kubeconfig)
	}
	sep := g.separated()
	if sep {
		home := g.cells.home
		if home == "" {
			home = "/"
		}
		env = append(env, "HOME="+home, "USER="+g.cells.name, "LOGNAME="+g.cells.name)
	}
	for _, n := range names.CellsEnv {
		if sep && (n == "HOME" || n == "USER" || n == "LOGNAME" || n == "TMPDIR") {
			continue
		}
		if v, ok := os.LookupEnv(n); ok {
			env = append(env, n+"="+v)
		}
	}
	return env
}

// cellsDir: where the shell starts. Shared mode: where the gate runs (the account's home). Separated
// mode: the cells' account's home, else / (the gate's home is out of its reach).
func (g *Gate) cellsDir() string {
	if !g.separated() {
		return ""
	}
	if g.cells.home != "" {
		return g.cells.home
	}
	return "/"
}

func (g *Gate) startShell(i int) {
	if g.jobMode() {
		g.startJobShell(i)
		return
	}
	g.shells++
	r, w, err := os.Pipe()
	if err != nil {
		say("can't create a pipe")
		g.exit(2)
	}
	unit := "md-runbook-gate-" + g.unitID + "-" + itoa(g.shells) + ".scope"
	l := g.plan.shell(append([]string{g.cellsBin}, g.cellsArgs...), g.cellsEnv(), g.cellsDir(), unit)
	cmd := exec.Command(l.argv[0], l.argv[1:]...)
	cmd.Env = l.env
	cmd.Stdin = r
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// A process group (and session) of its own: its blocks' background programs end with it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		r.Close()
		w.Close()
		say("can't start " + l.argv[0])
		g.exit(2)
	}
	r.Close()
	pid := cmd.Process.Pid
	sh := &shell{n: g.shells, leader: pid, pid: pid, pgid: pid, w: w, done: make(chan struct{})}
	if l.header != nil {
		// What the cells' mode reads first; then the cells. (A wrapper that already ended: the
		// write fails, and the watcher ends the session.)
		sh.pid, sh.pgid = 0, 0
		w.Write(l.header)
	}
	g.liveMu.Lock()
	g.live[sh] = true
	g.liveMu.Unlock()
	go func() {
		cmd.Wait()
		g.stopShells(sh)
		g.liveMu.Lock()
		delete(g.live, sh)
		g.liveMu.Unlock()
		if !sh.retired.Load() {
			// It ended by itself: so does the session.
			select {
			case g.endCh <- struct{}{}:
			default:
			}
		}
		close(sh.done)
	}()
	if l.header != nil {
		// Shared mode in a scope: the shell is the wrapper's own pid (systemd-run and the cells'
		// mode exec it).
		if g.plan.account == "" && g.plan.iso != "bwrap" {
			sh.mu.Lock()
			sh.pid, sh.pgid = pid, pid
			sh.mu.Unlock()
		}
		g.locate(sh, unit)
	}
	s := &g.slots[i]
	s.sh, s.hash, s.dirty = sh, "", false
}

// useSlot: the shell the next requests go to.
func (g *Gate) useSlot(i int) {
	g.cur = i
	g.uses++
	g.slots[i].used = g.uses
	g.pidShown = false
}

// showPID: the current shell's pid, for stop requests (a second connection): published once per
// switch.
func (g *Gate) showPID() {
	if g.pidShown {
		return
	}
	sh := g.slots[g.cur].sh
	if sh == nil {
		return
	}
	select {
	case <-sh.done:
		return
	default:
	}
	pid, _, _ := sh.info()
	content := itoa(pid)
	// A Job's shell: its namespace, Job and number (jobStopRequest finds the pod).
	if g.jobMode() {
		content = "job " + g.job.ns + " " + g.job.name + " " + itoa(sh.n)
	} else if pid <= 1 {
		return
	} else if g.separated() {
		// The cells account it runs as: a stop request signals as that one.
		content += "\n" + g.cells.name
	}
	f, err := os.CreateTemp(g.state+"/pids", ".new.")
	if err != nil {
		return
	}
	_, err = f.WriteString(content + "\n")
	if f.Close() != nil || err != nil || os.Rename(f.Name(), g.pidFile()) != nil {
		os.Remove(f.Name())
		return
	}
	g.pidShown = true
}

func (g *Gate) pidFile() string { return g.state + "/pids/" + g.skey }

// retire: the shell ends once it has run what it was sent, then its process group.
func (g *Gate) retire(i int) {
	s := &g.slots[i]
	if s.sh == nil {
		return
	}
	s.sh.retired.Store(true)
	s.sh.w.Close()
	// A Job's shell that was sent nothing doesn't wait for the pod.
	if g.jobMode() && !s.sh.sent.Load() {
		s.sh.abortJobShell()
	}
	g.waitShell(s.sh)
	if i == g.cur {
		os.Remove(g.pidFile())
	}
	s.sh, s.hash, s.dirty = nil, "", false
}

// waitShell waits for a shell's watcher. (A HUP, INT or TERM meanwhile has stopped every shell:
// signals.)
func (g *Gate) waitShell(sh *shell) { <-sh.done }

// shellFor: the slot for the runbook with this manifest hash: its own shell; else the session's
// first one if it ran nothing yet; else a new one. A shell that ran unsigned text is never one a
// signed runbook gets (security review round 3).
func (g *Gate) shellFor(hash string) {
	// The current shell's runbook ("" for the session's first shell, before any load).
	h := g.slots[g.cur].hash
	to := -1
	for s := range g.slots {
		if g.slots[s].sh != nil && g.slots[s].hash == hash {
			to = s
		}
	}
	if to >= 0 {
		if g.slots[to].dirty {
			g.retire(to)
			g.startShell(to)
		}
	} else if h == "" && !g.slots[g.cur].dirty {
		to = g.cur
	} else {
		// A free slot, else the one least recently used.
		old := -1
		for s := range g.slots {
			if g.slots[s].sh == nil {
				to = s
				break
			}
			if s == g.cur {
				continue
			}
			if old < 0 || g.slots[s].used < g.slots[old].used {
				old = s
			}
		}
		if to < 0 {
			to = old
			g.retire(to)
		}
		g.startShell(to)
	}
	// The session's first shell, left without a runbook, is of no more use.
	if g.cur != to && h == "" {
		g.retire(g.cur)
	}
	g.slots[to].hash = hash
	g.useSlot(to)
}

// send writes text to the current shell. (A shell that ended: the session ends with it.)
func (g *Gate) send(text string) {
	if sh := g.slots[g.cur].sh; sh != nil {
		if g.jobMode() {
			sh.sent.Store(true)
		}
		sh.w.WriteString(text)
	}
}

// sendRequest: the text of a request whose reply the shell prints (run, step, raw, context). In a
// Job whose pod isn't ready yet, the client hears first that the request waits for it. run: the
// run's number for a signed run, else "".
func (g *Gate) sendRequest(text, run string) {
	if g.jobMode() && g.slots[g.cur].sh != nil {
		g.job.waitFor(run)
	}
	g.send(text)
}

func marker(id, exit string) {
	m := proto.Marker(id, exit)
	os.Stderr.WriteString(m)
	os.Stdout.WriteString(m)
}

// refuse: the reason on stderr, logged, and exit 126 as the request's result.
func (g *Gate) refuse(id, reason string) {
	say(reason)
	g.log.Event("event", "refused", "id", id, "reason", reason)
	marker(id, Refused)
}

type line struct {
	text string
	err  error
}

func (g *Gate) serve() {
	// A bound on what a client can make the gate hold (security review round 4): the Go runtime
	// keeps its heap under memory_limit, and a session that needs more ends (memOver).
	limit := int64(0)
	if mib := g.cfg.MemoryLimit; mib != "0" {
		limit = int64(atoi(mib)) << 20
		debug.SetMemoryLimit(limit)
	}
	g.startShell(0)
	g.useSlot(0)
	lines := make(chan line)
	go func() {
		rd := proto.NewReader(os.Stdin)
		for {
			t, err := rd.Next()
			lines <- line{t, err}
			if err != nil {
				return
			}
		}
	}()
	term := false
loop:
	for {
		// A shell that ended by itself, or a signal, comes before the next request. (A signal
		// taken while a shell was retired counts too: signalled.)
		if g.signalled.Load() {
			term = true
			break loop
		}
		select {
		case <-g.endCh:
			term = true
			break loop
		case <-g.termCh:
			term = true
			break loop
		default:
		}
		select {
		case <-g.endCh:
			term = true
			break loop
		case <-g.termCh:
			term = true
			break loop
		case l := <-lines:
			if l.err == proto.ErrTooLong {
				say("request too long: the session ends")
				g.log.Event("event", "refused", "reason", "request too long")
				break loop
			}
			if l.err != nil {
				break loop
			}
			if g.jobMode() {
				g.job.spoke()
			}
			g.handle(l.text)
			if limit > 0 && memOver(limit) {
				say("the gate's memory is over memory_limit: the session ends")
				g.log.Event("event", "refused", "reason", "memory_limit reached")
				break loop
			}
		}
	}
	// The client is done: each shell runs what it was sent, then ends. Cut short: they end now.
	// (A Job's shells need no ending in the pod: deleting the Job ends them.) A client that went
	// while the Job's pod was starting, or within seconds of its start before the reply of a
	// request that waited for it (stopped as the pod got ready), cuts the session short too: what
	// it sent would run for no one, and the Job goes now (leftWaiting). A signed run's exit that
	// comes back within 2 s is that request's end (a one-shot client leaves after its reply).
	if !term && g.jobMode() {
		cut, why := g.job.leftWaiting(2 * time.Second)
		term = cut
		if why != "" {
			g.log.Event("event", "job", "status", "left", "job", g.job.name, "reason", why)
		}
	}
	g.ending.Store(true)
	if term {
		g.stopShells(g.liveShells()...)
	}
	for i := range g.slots {
		g.retire(i)
	}
	// Separated mode, a Job: the last exits the shells wrote (and their end events).
	if g.separated() {
		g.readExitsFile()
	} else if g.jobMode() {
		g.finishFollower()
		g.jobMissingExits(term)
	}
	// What left the shells' process groups, before the report sender starts.
	g.sweep("end")
	g.sendReports()
}

// memOver: the gate's heap is over limit bytes, after a collection.
func memOver(limit int64) bool {
	s := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	metrics.Read(s)
	if s[0].Value.Kind() != metrics.KindUint64 || int64(s[0].Value.Uint64()) <= limit {
		return false
	}
	runtime.GC()
	metrics.Read(s)
	return int64(s[0].Value.Uint64()) > limit
}

func atoi(s string) int {
	n := 0
	for i := 0; i < len(s) && s[i] >= '0' && s[i] <= '9'; i++ {
		n = n*10 + int(s[i]-'0')
	}
	return n
}

// handle runs one request line.
func (g *Gate) handle(text string) {
	f := textutil.Fields(text)
	verb := ""
	if len(f) > 0 {
		verb, f = f[0], f[1:]
	}
	arg := func(i int) string {
		if i < len(f) {
			return f[i]
		}
		return ""
	}
	if verb == ":" {
		// : mdrb-gate-hello ID; printf ...: the app's first line (a plain shell runs it as is).
		// (Protocol 4: `: mdrb-gate-hello ID pod-notices; ...` from a client that takes pod notices.)
		if rid, notices, ok := proto.Hello(f); ok {
			os.Stdout.WriteString(proto.Banner(Protocol, g.cfg.Unsigned))
			if g.jobMode() {
				os.Stdout.WriteString(g.job.hello(notices))
			}
			marker(rid, g.token)
		} else {
			say("this account runs md-runbook-gate: connect with the md-runbook app")
		}
		return
	}
	rid := arg(0)
	if !textutil.IsID(rid) {
		say("this account runs md-runbook-gate: connect with the md-runbook app")
		return
	}
	args := f[1:]
	switch verb {
	case "load":
		g.doLoad(rid, args)
	case "called":
		g.doCalled(rid, args)
	case "note":
		g.doNote(rid, args)
	case "param":
		g.doParam(rid, args)
	case "run":
		if len(args) == 1 && textutil.IsNum(args[0]) {
			g.doRun(rid, args[0], "")
		} else {
			g.refuse(rid, "bad run request")
		}
	case "step":
		if len(args) == 2 && textutil.IsNum(args[0]) && textutil.IsNum(args[1]) {
			g.doRun(rid, args[0], args[1])
		} else {
			g.refuse(rid, "bad step request")
		}
	case "raw":
		g.doRaw(rid, args)
	case "context":
		g.doContext(rid, args)
	default:
		g.refuse(rid, "unknown request "+verb)
	}
}

// ---- stopping ----

// nap is a short pause.
func nap() { time.Sleep(200 * time.Millisecond) }

// cleanup: every shell of the session, with what its blocks started; the stop file and the work
// folder.
func (g *Gate) cleanup() {
	g.stopShells(g.liveShells()...)
	g.endCells()
	g.jobCleanup()
	if g.skey != "" {
		os.Remove(g.pidFile())
	}
	if g.work != "" {
		os.RemoveAll(g.work)
	}
}

// stopRequest handles a second connection that stops a session's running cell; false when cmd
// is not one.
//
// The app sends the number the session's hello answered, as it sends a plain shell's pid. Here
// it is the session's own random number: only the client of that session knows it, so no other
// session (another key of this account) can stop its cells. The state folder has, under the
// number's sha256, the pid of the session's current shell. The signal goes to every process
// under that shell (a cell's programs and theirs), never to the shell itself (security review,
// 2026-11-16).
func (g *Gate) stopRequest(cmd string) bool {
	const suffix = " 2>/dev/null; true"
	sig := ""
	for _, s := range []string{"TERM", "KILL"} {
		prefix := "pkill -" + s + " -P "
		if len(cmd) >= len(prefix)+len(suffix) && strings.HasPrefix(cmd, prefix) && strings.HasSuffix(cmd, suffix) {
			sig = s
			break
		}
	}
	if sig == "" {
		return false
	}
	n, _, _ := strings.Cut(cmd[len("pkill -"+sig+" -P "):], " ")
	if n == "" || len(n) > 20 || strings.Trim(n, "0123456789") != "" {
		g.fatal("bad stop request")
	}
	// A regular file only ([ -f ]): a FIFO planted there would hold the stop connection.
	pf := g.state + "/pids/" + sha256Hex([]byte(n))
	st, err := os.Stat(pf)
	if err != nil || !st.Mode().IsRegular() {
		g.fatal("no md-runbook session " + n)
	}
	data, err := os.ReadFile(pf)
	if err != nil {
		g.fatal("no md-runbook session " + n)
	}
	first, rest, _ := strings.Cut(string(data), "\n")
	// A session whose cells run in a Kubernetes Job (only where this gate.conf says so).
	if f := strings.Split(first, " "); g.jobMode() && len(f) == 4 && f[0] == "job" {
		g.jobStopRequest(f[1], f[2], f[3], sig)
		return true
	}
	if !textutil.IsPID(first) {
		g.fatal("no md-runbook session " + n)
	}
	pid := atoi(first)
	g.log.Event("event", "stop", "shell", first, "signal", sig)
	// Listed first, then signalled: a program stopped first can't hide its children from the list.
	list, err := procs.List()
	if err != nil {
		return true
	}
	signal := syscall.SIGTERM
	if sig == "KILL" {
		signal = syscall.SIGKILL
	}
	targets := procs.Descendants(list, pid)
	// Separated mode: the cells' programs are the leased cells account's (the pid file's second
	// line, one of the pool), signalled as that account.
	if g.separated() {
		account, ok := stopAccount(rest, g.cfg.CellsPool())
		if !ok {
			g.fatal("no md-runbook session " + n)
		}
		if len(targets) > 0 {
			g.plan = g.basePlan()
			g.plan.account = account
			g.cellsKill(signal, targets)
		}
		return true
	}
	for _, p := range targets {
		syscall.Kill(p, signal)
	}
	return true
}

// stopAccount: the cells account a separated session's pid file names (the lines after the pid),
// if it is one of the pool. A file without that line was written by a gate before 0.30.0, which
// had one cells_account: during an update, its live session is stopped as the pool's only account
// (review of 0.30.0, L4). With a larger pool, which one is unknown.
func stopAccount(rest string, pool []string) (string, bool) {
	account, _, _ := strings.Cut(rest, "\n")
	if account == "" && len(pool) == 1 {
		return pool[0], true
	}
	return account, has(pool, account)
}

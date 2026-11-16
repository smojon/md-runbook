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
// in a plain session; when it ends, its process group goes too (TERM, then KILL). Each shell has
// a process group (and session) of its own, so that its blocks' background programs end with it.

const nSlots = 6

// slot: a place for a shell. hash: its runbook's manifest hash ("" for the session's first
// shell before a load); dirty: it ran unsigned text; used: when it was last switched to.
type slot struct {
	sh    *shell
	hash  string
	dirty bool
	used  int
}

type shell struct {
	n       int
	pid     int
	w       *os.File
	done    chan struct{}
	retired atomic.Bool
}

// session runs a session; the gate's exit code.
func (g *Gate) session() int {
	work, err := os.MkdirTemp(tmpDir(), "md-runbook-gate.")
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
	g.log.Event("event", "session", "unsigned", g.cfg.Unsigned, "scopes", g.cfg.Scopes, "key_scopes", g.keyScopes)
	if g.reportProblem != "" {
		g.log.Event("event", "report", "status", "off", "reason", g.reportProblem)
	}
	if g.cfg.AllowNoGroupKill != "" {
		g.log.Event("event", "notice", "reason", "allow_no_group_kill in "+g.configPath+" is obsolete and ignored: each shell always has a process group of its own")
	}
	if g.reportOn {
		if f, err := os.OpenFile(g.work+"/report-exits", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); err == nil {
			f.Close()
		}
	}
	// Before the first shell: no leftover of an earlier session finds it.
	g.sweep("start")
	g.serve()
	g.cleanup()
	if g.signalled {
		return 1
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

func (g *Gate) cellsEnv() []string {
	env := []string{"SHELL=" + g.cellsBin, "PATH=" + g.cfg.Path, "LANG=" + g.cfg.Locale, "MD_RUNBOOK_GATE_WHO=" + g.who}
	if g.cfg.Kubeconfig != "" {
		env = append(env, "KUBECONFIG="+g.cfg.Kubeconfig)
	}
	for _, n := range names.CellsEnv {
		if v, ok := os.LookupEnv(n); ok {
			env = append(env, n+"="+v)
		}
	}
	return env
}

func (g *Gate) startShell(i int) {
	g.shells++
	r, w, err := os.Pipe()
	if err != nil {
		say("can't create a pipe")
		g.exit(2)
	}
	cmd := exec.Command(g.cellsBin, g.cellsArgs...)
	cmd.Env = g.cellsEnv()
	cmd.Stdin = r
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// A process group (and session) of its own: its blocks' background programs end with it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		r.Close()
		w.Close()
		say("can't start " + g.cellsBin)
		g.exit(2)
	}
	r.Close()
	sh := &shell{n: g.shells, pid: cmd.Process.Pid, w: w, done: make(chan struct{})}
	g.liveMu.Lock()
	g.live[sh] = true
	g.liveMu.Unlock()
	go func() {
		cmd.Wait()
		stopGroups(sh.pid)
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
	f, err := os.CreateTemp(g.state+"/pids", ".new.")
	if err != nil {
		return
	}
	_, err = f.WriteString(itoa(sh.pid) + "\n")
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
	g.waitShell(s.sh)
	if i == g.cur {
		os.Remove(g.pidFile())
	}
	s.sh, s.hash, s.dirty = nil, "", false
}

// waitShell waits for a shell's watcher. A HUP, INT or TERM meanwhile ends every shell now.
func (g *Gate) waitShell(sh *shell) {
	for {
		select {
		case <-sh.done:
			return
		case <-g.termCh:
			g.signalled = true
			stopGroups(g.livePIDs()...)
		}
	}
}

func (g *Gate) livePIDs() []int {
	g.liveMu.Lock()
	defer g.liveMu.Unlock()
	var pids []int
	for sh := range g.live {
		pids = append(pids, sh.pid)
	}
	return pids
}

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
		sh.w.WriteString(text)
	}
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
		// A shell that ended by itself, or a signal, comes before the next request.
		select {
		case <-g.endCh:
			term = true
			break loop
		case <-g.termCh:
			term, g.signalled = true, true
			break loop
		default:
		}
		select {
		case <-g.endCh:
			term = true
			break loop
		case <-g.termCh:
			term, g.signalled = true, true
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
			g.handle(l.text)
			if limit > 0 && memOver(limit) {
				say("the gate's memory is over memory_limit: the session ends")
				g.log.Event("event", "refused", "reason", "memory_limit reached")
				break loop
			}
		}
	}
	// The client is done: each shell runs what it was sent, then ends. Cut short: they end now.
	if term {
		stopGroups(g.livePIDs()...)
	}
	for i := range g.slots {
		g.retire(i)
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
		rid := strings.TrimSuffix(arg(1), ";")
		if arg(0) == "mdrb-gate-hello" && textutil.IsID(rid) {
			os.Stdout.WriteString(proto.Banner(Protocol, g.cfg.Unsigned))
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

// stopGroups: each process group a pid leads (a shell and what its blocks started) gets TERM;
// what is left of them a second later, KILL. A block's `trap ” TERM` doesn't keep a program
// running (security review round 4).
func stopGroups(pids ...int) {
	var groups []int
	for _, p := range pids {
		if p > 1 {
			groups = append(groups, p)
		}
	}
	if len(groups) == 0 {
		return
	}
	for _, p := range groups {
		syscall.Kill(-p, syscall.SIGTERM)
	}
	var left []int
	for i := 0; i < 5; i++ {
		left = left[:0]
		for _, p := range groups {
			if syscall.Kill(-p, 0) == nil {
				left = append(left, p)
			}
		}
		if len(left) == 0 {
			return
		}
		nap()
	}
	for _, p := range left {
		syscall.Kill(-p, syscall.SIGKILL)
	}
}

// cleanup: every shell of the session, with what its blocks started; the stop file and the work
// folder.
func (g *Gate) cleanup() {
	stopGroups(g.livePIDs()...)
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
	data, err := os.ReadFile(g.state + "/pids/" + sha256Hex([]byte(n)))
	if err != nil {
		g.fatal("no md-runbook session " + n)
	}
	first, _, _ := strings.Cut(string(data), "\n")
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
	for _, p := range procs.Descendants(list, pid) {
		syscall.Kill(p, signal)
	}
	return true
}

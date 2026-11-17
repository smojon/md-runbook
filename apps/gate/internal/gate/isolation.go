//go:build unix

package gate

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/procs"
)

// ---- isolation (isolation = in gate.conf) ----
// Each shell of a session runs in a process scope of its own, so that ending the scope ends
// everything a block started in it, a double-forked or setsid program too:
//
//	scope  a systemd scope of the account's user manager (systemd-run --user --scope). The gate
//	       ends it through its cgroup (cgroup.kill: cgroup v2, Linux 5.14 or newer), which also
//	       reaches the cells of separated mode (another account's processes).
//	bwrap  a PID namespace of its own (bwrap --unshare-pid): when the shell ends, the kernel ends
//	       every process in it. Files stay the host's (the whole tree is bound), but /proc shows
//	       the namespace only, and nothing in it can gain privileges (no sudo, no setuid).
//	none   the shell's process group, as before, and the kill_leftovers sweep.
//
// auto (the default) takes scope, else none: never bwrap, so that blocks that use sudo or setuid
// programs keep working after an update on every host. bwrap only when named. scope and bwrap
// are required when named.
//
// Why a user scope: a plain account can't ask the system manager for a scope (that needs root or
// a polkit rule), and logind doesn't delegate the session's own cgroup. Under sshd with UsePAM
// yes, pam_systemd starts the account's user manager (user@UID.service), which can: its socket
// is /run/user/UID/systemd/private, used without D-Bus. Without it (no PAM, a container, macOS)
// the gate falls back. loginctl enable-linger keeps the manager running between sessions.
//
// In shared mode a block runs as the account that owns its scope: one that means to can move
// itself out of it (or ask the user manager for a service). The scope ends what a block left
// behind by accident; separated mode keeps blocks in it (they can't write the account's cgroups).

// CellsMode is the argument that makes the gate's program the cells' launcher: it reads one
// request from stdin (cellsReq: start the shell, signal processes, check files, sweep) and does
// it as whichever account runs it. The gate starts it through systemd-run, sudo or bwrap, so
// that the shell gets exactly the cells' environment however it was started. In separated mode
// it is the one command the gate's account may run as the cells' account (see sudoRule). It
// grants nothing: it does what the account running it may do anyway.
const CellsMode = "__cells"

// cellsReq is a request to the cells' mode. Op: exec (Argv with Env, in Dir), kill (Sig to each
// of Targets: a pid, or -group), check (which of Read the account can read, which of Write it can
// write), scope (its cgroup, if the gate can end it there) or killall (separated mode: KILL to
// every process of the account, UID; separated.go). In a Job's pod also stop (Sig to what runs
// under shell Shell), end (the Shells, with what they started) and follow (stream Paths to
// stdout).
type cellsReq struct {
	Op      string   `json:"op"`
	Argv    []string `json:"argv,omitempty"`
	Env     []string `json:"env,omitempty"`
	Dir     string   `json:"dir,omitempty"`
	Sig     int      `json:"sig,omitempty"`
	Targets []int    `json:"targets,omitempty"`
	Read    []string `json:"read,omitempty"`
	Write   []string `json:"write,omitempty"`
	// killall: the uid the gate leased; the cells' mode refuses to run as any other (never root).
	UID int `json:"uid,omitempty"`
	// In a Kubernetes Job's pod (job.go): the shell's number (exec, stop), the shells to end
	// (end), and the files to follow (follow; Events: the pod's own log = file too).
	Shell  int      `json:"shell,omitempty"`
	Shells []int    `json:"shells,omitempty"`
	Paths  []string `json:"paths,omitempty"`
	Events bool     `json:"events,omitempty"`
	// follow: when its stdin ends, end the pod (TERM to PID 1, tini): a dead-man switch.
	EndPod bool `json:"end_pod,omitempty"`
	// exec, separated mode (the cells run as an account of their own): no_new_privs before the
	// exec, on Linux (setNoNewPrivs). Else a setuid file that one session's block left would let a
	// later session's block become that account, and reach whichever session leased it then
	// (review of 0.30.0, H1). Fail closed: no shell when it can't be set.
	NoNewPrivs bool `json:"no_new_privs,omitempty"`
	// check: the cells account's home folder (checkHome).
	Home string `json:"home,omitempty"`
}

const (
	cellsHeader = "mdrb-cells "
	cellsMax    = 1 << 20
)

// encode: "mdrb-cells N\n" and N bytes of JSON. The cells' mode reads exactly that much of its
// stdin, and the shell it starts reads the rest (the cells).
func (r cellsReq) encode() []byte {
	data, _ := json.Marshal(r)
	return append([]byte(cellsHeader+strconv.Itoa(len(data))+"\n"), data...)
}

// readCellsReq reads one request, not a byte more (no buffer: the rest is the shell's).
func readCellsReq(f io.Reader) (cellsReq, error) {
	var req cellsReq
	var line []byte
	b := make([]byte, 1)
	for {
		n, err := f.Read(b)
		if n == 1 {
			if b[0] == '\n' {
				break
			}
			line = append(line, b[0])
			if len(line) > 32 {
				return req, errors.New("bad header")
			}
			continue
		}
		if err != nil {
			return req, err
		}
	}
	s, ok := strings.CutPrefix(string(line), cellsHeader)
	n, err := strconv.Atoi(s)
	if !ok || err != nil || n <= 0 || n > cellsMax {
		return req, errors.New("bad header")
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(f, data); err != nil {
		return req, err
	}
	if err := json.Unmarshal(data, &req); err != nil {
		return req, err
	}
	return req, nil
}

// checkResult is what the check request answers.
type checkResult struct {
	UID   int      `json:"uid"`
	Read  []string `json:"read"`
	Write []string `json:"write"`
	// The home folder (checkHome): still open to other accounts; the files in it that would let a
	// key log in as the account, removed and still there.
	HomeOpen bool     `json:"home_open,omitempty"`
	Removed  []string `json:"removed,omitempty"`
	Logins   []string `json:"logins,omitempty"`
}

// cellsMain is the cells' mode; its exit code (exec doesn't return).
func cellsMain() int {
	req, err := readCellsReq(os.Stdin)
	if err != nil {
		say("cells mode: bad request")
		return 2
	}
	switch req.Op {
	case "exec":
		if len(req.Argv) == 0 || !strings.HasPrefix(req.Argv[0], "/") {
			say("cells mode: bad request")
			return 2
		}
		if req.Dir != "" && os.Chdir(req.Dir) != nil {
			os.Chdir("/")
		}
		if req.Shell > 0 {
			markShell(req.Shell)
		}
		if req.NoNewPrivs {
			// The flag is the thread's: set it on the thread that execs.
			runtime.LockOSThread()
			if err := setNoNewPrivs(); err != nil {
				say("cells mode: can't set no_new_privs (" + err.Error() + "): the cells don't start")
				return 126
			}
		}
		err := syscall.Exec(req.Argv[0], req.Argv, req.Env)
		say("can't start " + req.Argv[0] + ": " + err.Error())
		return 127
	case "kill":
		s := syscall.Signal(req.Sig)
		for _, t := range req.Targets {
			// Never 0 (its own group), -1 (every process) or PID 1.
			if t > 1 || t < -1 {
				syscall.Kill(t, s)
			}
		}
		return 0
	case "check":
		res := checkResult{UID: os.Getuid(), Read: []string{}, Write: []string{}}
		for _, p := range req.Read {
			if readable(p) {
				res.Read = append(res.Read, p)
			}
		}
		for _, p := range req.Write {
			if writable(p) {
				res.Write = append(res.Write, p)
			}
		}
		res.HomeOpen, res.Removed, res.Logins = checkHome(req.Home, os.Getuid())
		data, _ := json.Marshal(res)
		os.Stdout.Write(append(data, '\n'))
		return 0
	case "scope":
		cg := procs.Cgroup(os.Getpid())
		dir := cgroupRoot + cg
		if cg == "" || cg == "/" || !writable(dir+"/cgroup.kill") || !exists(dir+"/cgroup.events") {
			return 1
		}
		os.Stdout.WriteString(cg + "\n")
		return 0
	case "killall":
		return cellsKillAll(req.UID, os.Getuid(), os.Geteuid(), syscall.Kill)
	case "stop":
		return stopShell(req.Shell, syscall.Signal(req.Sig))
	case "end":
		endShells(req.Shells)
		return 0
	case "follow":
		followFiles(followPaths(req), os.Stdin, os.Stdout, 100*time.Millisecond)
		// The gate ended the session, or is gone: so is the pod (its container ends, and with
		// backoffLimit 0 the Job). Nothing a block left behind outlives the session.
		if req.EndPod {
			syscall.Kill(1, syscall.SIGTERM)
		}
		return 0
	}
	say("cells mode: bad request")
	return 2
}

// ---- how the gate starts the cells' shells ----

// cgroupRoot is where cgroup v2 is mounted.
const cgroupRoot = "/sys/fs/cgroup"

// plan is how this session starts its shells: the isolation it got and the account they run as.
type plan struct {
	iso        string // scope, bwrap or none (auto resolved)
	account    string // separated mode: the cells account this session leased; "" shared
	exe        string // this program (its cells mode)
	sudo       string
	systemdRun string
	bwrap      string
	runtimeDir string // the user manager's (systemd-run --user)
}

// launch is a process the gate starts: argv, its environment, and what it reads first (a request
// to the cells' mode; nil when the gate starts the shell itself).
type launch struct {
	argv   []string
	env    []string
	header []byte
}

// bwrapArgs: the whole file tree as it is (devices too), a PID namespace and /proc of its own, a
// session of its own (the shell leads its process group, as without bwrap), and everything in it
// ends when the gate's side of it does.
func bwrapArgs(bwrap string) []string {
	return []string{bwrap, "--die-with-parent", "--new-session", "--unshare-pid", "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--"}
}

// outer: what the gate starts to run its cells' mode: in a new scope named unit (when not ""),
// as the cells' account when asCells (separated mode).
func (p plan) outer(unit string, asCells bool) launch {
	var argv []string
	env := []string{"PATH=" + sysPath, "LC_ALL=C"}
	if unit != "" {
		argv = append(argv, p.systemdRun, "--user", "--scope", "--quiet", "--collect", "--unit="+unit, "--description=md-runbook-gate cells", "--")
		env = append(env, "XDG_RUNTIME_DIR="+p.runtimeDir)
	}
	if asCells {
		argv = append(argv, p.sudo, "-n", "-u", p.account, "--")
	}
	return launch{argv: append(argv, p.exe, CellsMode), env: env}
}

// shell: how to start a shell (cells: its argv, env and starting folder). Shared mode without
// isolation starts it directly, as before; anything else through the cells' mode, which starts
// it (in bwrap's namespace with bwrap) with exactly this environment.
func (p plan) shell(cells, env []string, dir, unit string) launch {
	if p.iso != "scope" && p.iso != "bwrap" && p.account == "" {
		return launch{argv: cells, env: env}
	}
	inner := cells
	if p.iso == "bwrap" {
		inner = append(bwrapArgs(p.bwrap), cells...)
	}
	if p.iso != "scope" {
		unit = ""
	}
	l := p.outer(unit, p.account != "")
	// Separated mode: no_new_privs. Not with bwrap, which sets it itself in its namespace, and
	// which may be a setuid program (no_new_privs before it would stop it).
	l.header = cellsReq{Op: "exec", Argv: inner, Env: env, Dir: dir, NoNewPrivs: p.account != "" && p.iso != "bwrap"}.encode()
	return l
}

// sudoRule is the one line of sudoers that separated mode needs: the gate's account may run its
// cells' mode as any account of the pool, without a password, and nothing else.
func sudoRule(gateAccount string, pool []string, exe string) string {
	return gateAccount + " ALL=(" + strings.Join(pool, ",") + ") NOPASSWD: " + exe + " " + CellsMode
}

// runLimit: how long runCmd lets a program run.
const runLimit = 20 * time.Second

// runCmd runs a program to its end (at most runLimit) with stdin; its stdout, and an error that
// names its exit and the first line of its stderr. In a session of its own: no terminal.
func runCmd(argv, env []string, stdin []byte) ([]byte, error) {
	return runFor(runLimit, argv, env, stdin)
}

// waitDelay: how long a program's output may stay open after it ended or was killed. sudo's
// child (the cells' mode) holds the pipes; the cells' account can stop it (SIGSTOP), and the gate
// can't signal it. Without a bound, Wait would wait for it forever (review of 0.28.0).
const waitDelay = 2 * time.Second

// runFor is runCmd with a limit: after it, the program is killed, and its output is given up
// waitDelay later even if a process the gate can't signal still holds it.
func runFor(limit time.Duration, argv, env []string, stdin []byte) ([]byte, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.WaitDelay = waitDelay
	cmd.Env = env
	if env == nil {
		cmd.Env = []string{"PATH=" + sysPath, "LC_ALL=C"}
	}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var late atomic.Bool
	t := time.AfterFunc(limit, func() {
		late.Store(true)
		cmd.Process.Kill()
	})
	err := cmd.Wait()
	t.Stop()
	if late.Load() {
		return out.Bytes(), fmt.Errorf("%w after %s (%w)", errTimeout, limit, err)
	}
	if err != nil {
		first, _, _ := strings.Cut(strings.TrimSpace(errb.String()), "\n")
		if first != "" {
			return out.Bytes(), fmt.Errorf("%w: %s", err, first)
		}
		return out.Bytes(), err
	}
	return out.Bytes(), nil
}

// errTimeout: runFor killed the program at its limit.
var errTimeout = errors.New("timed out")

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- choosing the isolation ----

// basePlan: the account and programs, before the isolation is chosen.
func (g *Gate) basePlan() plan {
	p := plan{iso: "none", sudo: g.helper("sudo"), runtimeDir: "/run/user/" + itoa(g.uid)}
	if exe, err := os.Executable(); err == nil && strings.HasPrefix(exe, "/") {
		p.exe = exe
	}
	return p
}

// isolationsToTry: what isolation = WANT tries, in order; none after them. auto tries scope only:
// bwrap takes sudo and setuid programs from the blocks, so only an admin who names it gets it.
func isolationsToTry(want string) []string {
	switch want {
	case "auto":
		return []string{"scope"}
	case "scope", "bwrap":
		return []string{want}
	}
	return nil
}

// resolveIsolation sets g.plan.iso: isolation = scope or bwrap, or what auto finds. A named one
// that this server lacks stops the gate.
func (g *Gate) resolveIsolation() {
	want := g.cfg.Isolation
	g.isoWhy = ""
	for _, iso := range isolationsToTry(want) {
		why := g.probe(iso)
		if why == "" {
			g.plan.iso = iso
			return
		}
		if want != "auto" {
			g.fatal("isolation = " + iso + ": " + why + ". Use isolation = auto or none, or fix it.")
		}
		g.isoWhy += iso + ": " + why + "; "
	}
	g.plan.iso = "none"
}

// probe: "" when this session can use the isolation, else why not.
func (g *Gate) probe(iso string) string {
	if g.plan.exe == "" {
		return "can't find this program's own path"
	}
	switch iso {
	case "scope":
		sr := g.helper("systemd-run")
		if sr == "" {
			return "no systemd-run"
		}
		if !procs.HaveProc() {
			return "needs Linux"
		}
		if !exists(g.plan.runtimeDir + "/systemd/private") {
			return "no systemd user manager for this account (" + g.plan.runtimeDir + "/systemd/private): log in through pam_systemd, or run loginctl enable-linger " + g.account
		}
		p := g.plan
		p.systemdRun = sr
		unit := "md-runbook-gate-probe-" + randHex(6) + ".scope"
		l := p.outer(unit, false)
		out, err := runCmd(l.argv, l.env, cellsReq{Op: "scope"}.encode())
		if err != nil || !strings.HasSuffix(strings.TrimSpace(string(out)), "/"+unit) {
			return "can't make a scope that the gate can end (it needs cgroup v2 and cgroup.kill, Linux 5.14 or newer)"
		}
		g.plan.systemdRun = sr
		return ""
	case "bwrap":
		b := g.helper("bwrap")
		if b == "" {
			return "no bwrap"
		}
		if !procs.HaveProc() {
			return "needs Linux"
		}
		l := g.plan.outer("", g.plan.account != "")
		cells := append(append([]string{g.cellsBin}, g.cellsArgs...), "-c", ":")
		req := cellsReq{Op: "exec", Argv: append(bwrapArgs(b), cells...), Env: []string{"PATH=" + g.cfg.Path}, Dir: "/"}
		if _, err := runCmd(l.argv, l.env, req.encode()); err != nil {
			return "bwrap can't make a PID namespace here (" + err.Error() + ")"
		}
		g.plan.bwrap = b
		return ""
	}
	return "unknown"
}

// ---- finding a shell, and ending it ----

// locate finds what a wrapper hides: the shell's own pid and group (separated mode, bwrap) and the
// scope's cgroup. Until the wrapper got there, or 10 seconds, or the wrapper ended.
func (g *Gate) locate(sh *shell, unit string) {
	needShell := g.plan.account != "" || g.plan.iso == "bwrap"
	needCg := g.plan.iso == "scope"
	if !needShell && !needCg {
		return
	}
	uid := g.uid
	if g.plan.account != "" {
		uid = g.cells.uid
	}
	var inner func(int) bool
	if g.plan.iso == "bwrap" {
		inner = func(pid int) bool {
			ns := procs.NSpid(pid)
			return len(ns) > 1 && ns[len(ns)-1] == 2
		}
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		pid, _, cg := sh.info()
		if needCg && cg == "" {
			if c := procs.Cgroup(sh.leader); strings.HasSuffix(c, "/"+unit) {
				cg = cgroupRoot + c
				sh.mu.Lock()
				sh.cg = cg
				sh.mu.Unlock()
			}
		}
		if needShell && pid == 0 {
			if list, err := procs.List(); err == nil {
				if p := procs.ShellOf(list, sh.leader, uid, inner); p > 0 {
					pid = p
					pgid := p
					for _, q := range list {
						if q.PID == p && q.PGID > 1 {
							pgid = q.PGID
						}
					}
					sh.mu.Lock()
					sh.pid, sh.pgid = p, pgid
					sh.mu.Unlock()
				}
			}
		}
		if (!needCg || cg != "") && (!needShell || pid != 0) {
			return
		}
		select {
		case <-sh.done:
			return
		default:
		}
		if time.Now().After(deadline) {
			g.log.Event("event", "notice", "reason", "the cells' shell "+itoa(sh.n)+" wasn't found under its wrapper: stop requests can't reach it")
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// liveShells: the shells whose wrapper still runs.
func (g *Gate) liveShells() []*shell {
	g.liveMu.Lock()
	defer g.liveMu.Unlock()
	var out []*shell
	for sh := range g.live {
		out = append(out, sh)
	}
	return out
}

// stopShells: each shell, with what its blocks started (its process group, its scope), gets TERM;
// what is left of them a second later, KILL. A block's `trap ” TERM` doesn't keep a program
// running (security review round 4).
func (g *Gate) stopShells(shs ...*shell) {
	if len(shs) == 0 {
		return
	}
	if g.jobMode() {
		g.jobStopShells(shs)
	}
	g.signalShells(shs, syscall.SIGTERM)
	for i := 0; i < 5; i++ {
		if !g.anyAlive(shs) {
			return
		}
		nap()
	}
	g.signalShells(shs, syscall.SIGKILL)
}

// groupsOf: the process groups of a shell: its wrapper's (the gate started it with setsid) and the
// shell's own, if another.
func groupsOf(sh *shell) []int {
	sh.mu.Lock()
	leader, pgid := sh.leader, sh.pgid
	sh.mu.Unlock()
	gs := []int{}
	if leader > 1 {
		gs = append(gs, leader)
	}
	if pgid > 1 && pgid != leader {
		gs = append(gs, pgid)
	}
	return gs
}

// signalShells sends sig to the shells' groups and scopes. The gate signals what runs as its own
// account; in separated mode, the cells' account's processes get it through the cells' mode (one
// sudo for all). KILL ends a scope through its cgroup, whatever account its processes run as.
//
// No helper comes first: KILL writes every scope's cgroup.kill, then signals the groups, and only
// then asks the cells' mode, which a process of the cells' account could stop. TERM leaves the
// cells' mode running in the background: the wait for the shells to end doesn't depend on it.
func (g *Gate) signalShells(shs []*shell, sig syscall.Signal) {
	if sig == syscall.SIGKILL {
		for _, sh := range shs {
			if _, _, cg := sh.info(); cg != "" {
				os.WriteFile(cg+"/cgroup.kill", []byte("1"), 0)
			}
		}
	}
	var cells []int
	sep := g.plan.account != ""
	for _, sh := range shs {
		for _, gr := range groupsOf(sh) {
			err := syscall.Kill(-gr, sig)
			if sep && (err == nil || err == syscall.EPERM) {
				cells = append(cells, -gr)
			}
		}
		_, _, cg := sh.info()
		if cg == "" || sig == syscall.SIGKILL {
			continue
		}
		for _, p := range cgroupProcs(cg) {
			if err := syscall.Kill(p, sig); err == syscall.EPERM && sep {
				cells = append(cells, p)
			}
		}
	}
	if len(cells) == 0 {
		return
	}
	if sig == syscall.SIGKILL {
		g.cellsKill(sig, cells)
	} else {
		go g.cellsKill(sig, cells)
	}
}

// anyAlive: a process is left in a shell's groups or scope. (EPERM: a process of the cells'
// account.)
func (g *Gate) anyAlive(shs []*shell) bool {
	for _, sh := range shs {
		for _, gr := range groupsOf(sh) {
			if err := syscall.Kill(-gr, 0); err == nil || err == syscall.EPERM {
				return true
			}
		}
		if _, _, cg := sh.info(); cg != "" && populated(cg) {
			return true
		}
	}
	return false
}

// cellsKill signals processes of the cells' account (pids, or -groups) as that account: at most
// 5 seconds, and waitDelay more for a stopped cells' mode.
func (g *Gate) cellsKill(sig syscall.Signal, targets []int) {
	l := g.plan.outer("", true)
	if g.plan.exe == "" || g.plan.sudo == "" {
		return
	}
	runFor(5*time.Second, l.argv, l.env, cellsReq{Op: "kill", Sig: int(sig), Targets: targets}.encode())
}

// cgroupProcs: the processes in a cgroup and the cgroups under it.
func cgroupProcs(dir string) []int {
	var out []int
	var walk func(d string, depth int)
	walk = func(d string, depth int) {
		if b, err := os.ReadFile(d + "/cgroup.procs"); err == nil {
			for _, f := range strings.Fields(string(b)) {
				if n, err := strconv.Atoi(f); err == nil && n > 1 {
					out = append(out, n)
				}
			}
		}
		if depth >= 8 {
			return
		}
		ents, _ := os.ReadDir(d)
		for _, e := range ents {
			if e.IsDir() {
				walk(d+"/"+e.Name(), depth+1)
			}
		}
	}
	walk(dir, 0)
	return out
}

// populated: a process is left in the cgroup or under it (cgroup.events; a cgroup that is gone
// has none).
func populated(dir string) bool {
	b, err := os.ReadFile(dir + "/cgroup.events")
	return err == nil && strings.Contains(string(b), "populated 1")
}

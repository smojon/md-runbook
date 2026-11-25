//go:build unix

// Package gate is md-runbook-gate: the only program an SSH key restricted with
//
//	restrict,command="/usr/local/bin/md-runbook-gate" ssh-ed25519 AAAA... alice@support
//
// may start. It runs the cells of runbooks signed by a key in allowed_signers (and, if this
// server or key allows it, unsigned cells), in one persistent shell per runbook, and logs every
// request. See apps/gate/README.md and docs/features/signed-runbooks.md.
//
// Options (in the authorized_keys command): --config=FILE (default /etc/md-runbook/gate.conf),
// --unsigned=allow|refuse and --scopes=a,b (override the config for this key), --signers=N,
// --who=NAME (the name logged for this key; default, with ExposeAuthInfo yes in sshd: a user
// certificate's key ID, else the key's fingerprint). --sshd-force-command (sshd_config's ForceCommand only) and sshd_force_command =
// yes in a gate.conf the account can't change go together: one without the other stops the gate.
//
// Each signed runbook runs in a shell of its own (bash --noprofile --norc, else sh) with the PATH
// and locale of gate.conf: nothing from the account's profile, the client's locale or another
// runbook. The cells of one runbook share that shell, as in a plain session, also after a call
// into another runbook. A signed block is trusted code: it can read what its shell gets next and
// answer for later runs (see README.md, Trust). Other processes of the account can reach a
// session's shells through /proc: the account must be used by the gate alone, and with
// kill_leftovers = yes the gate ends the account's processes that outlived their session.
//
// The client (the md-runbook app) speaks a line protocol on stdin; replies end with the same
// end-of-cell marker as a plain shell session (\036__MDRB_<id>__ <exit>, on stdout and stderr).
//
//	: mdrb-gate-hello ID; ...           -> banner \036__MDRB_GATE__ PROTOCOL unsigned=allow|refuse, marker with the session number (what a stop request names)
//	called ID HASH N                  -> (protocol 2) the next load is the runbook called by call N of the
//	                                     runbook with manifest sha256 HASH: logged with that load (what the
//	                                     app says, for the audit; it grants nothing)
//	note ID KEY VALUE [KEY VALUE ...] -> (protocol 3) base64 values; KEY is ALERT (required), ALERT_FINGERPRINT
//	                                     or ALERT_STARTS_AT: the next load answers that alert: logged with
//	                                     that load (it grants nothing and runs nothing)
//	load ID MANIFEST SIGNATURE        -> base64; checks the signature and policy; \036__MDRB_SIGNED__ PRINCIPAL HASH
//	param ID NAME VALUE               -> base64 value, checked against the manifest's pattern
//	run ID CELL | step ID CELL K      -> runs a signed cell, or its K-th command (0-based)
//	raw ID TEXT                       -> base64 shell text, only where unsigned cells are allowed
//	context ID                        -> runs `kubectl config current-context` (the kube-context guard)
//
// (Protocol 4) A hello `: mdrb-gate-hello ID pod-notices; ...` takes pod notices: where the cells
// run in a Kubernetes Job, the gate says when a request waits for the Job's pod and when that wait
// ends, so that the pod's start is no part of the client's time limit (proto.Pod).
//
// A second connection whose command is `pkill -TERM|-KILL -P N 2>/dev/null; true` stops the
// running cell of session N (the number its hello answered; what the app sends to cancel).
//
// This program replaces the POSIX sh script of the same name (0.27.0 and before), with the same
// protocol, gate.conf, key-line checks and log events. Its comments keep the reasons the script
// gave for each check (the security review rounds of 2026-11-16).
package gate

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/smojon/md-runbook/apps/gate/internal/config"
	"github.com/smojon/md-runbook/apps/gate/internal/logx"
	"github.com/smojon/md-runbook/apps/gate/internal/manifest"
	"github.com/smojon/md-runbook/apps/gate/internal/names"
	"github.com/smojon/md-runbook/apps/gate/internal/proto"
	"github.com/smojon/md-runbook/apps/gate/internal/report"
	"github.com/smojon/md-runbook/apps/gate/internal/sshcert"
	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// Protocol is the gate protocol the hello banner names.
const Protocol = "4"

// Refused is the exit of a refused request.
const Refused = "126"

// The gate's own PATH comes first; the one sshd gave it after.
const gatePath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

// Gate is one run of the program: a session, or a stop request.
type Gate struct {
	cfg        config.Config
	configPath string
	// The key line's options.
	keyUnsigned, keyScopes, keySigners string
	who                                string
	cliForce                           bool
	// The user certificate of the login (nil for a plain key), and why its key ID isn't who or
	// why it couldn't be read ("" when nothing went wrong).
	cert        *sshcert.Cert
	certProblem string

	// self: this program's path, as the key lines name it (the shell gate's $0).
	self    string
	account string
	uid     int
	client  string
	log     *logx.Logger
	state   string
	keys    []string // authorized_keys, expanded
	ppid0   int

	reportOn      bool
	reportProblem string
	cellsBin      string
	cellsArgs     []string

	// How the shells start (isolation, separated mode), and the cells account this session leased
	// (separated mode): its lock, held until the gate ends, and the end of its processes, once.
	plan      plan
	cells     cellsInfo
	cellsLock io.Closer
	cellsEnd  sync.Once
	// The locks of the pool's accounts the lease couldn't clear, held until the gate ends (so
	// that no other session tries them meanwhile; an os.File closes when collected).
	cellsStuck []io.Closer
	// The programs the gate runs, by absolute path (helpers.go).
	helpers map[string]string
	// This program's name as process listings show it (separated mode: what the cells run under).
	gateComm string
	isoWhy   string // why auto found no isolation
	unitID   string // the session's scopes' names
	// The session's Kubernetes Job (cells_runner = kubernetes-job).
	job *kubeJob

	sess
}

// Main runs the gate with os.Args; its exit code.
func Main(args []string) int {
	if len(args) > 1 && args[1] == report.SenderMode {
		return report.SenderMain(os.Stdin)
	}
	if len(args) == 2 && args[1] == CellsMode {
		return cellsMain()
	}
	g := &Gate{ppid0: os.Getppid()}
	g.cleanEnv()
	syscall.Umask(0o077)
	g.signals()
	// A bug is no reason to leave the shells running (the shell gate's EXIT trap always ran).
	defer func() {
		if r := recover(); r != nil {
			say(fmt.Sprintf("internal error: %v", r))
			g.exit(2)
		}
	}()
	return g.main(args[1:])
}

// cleanEnv: the gate's own environment. Nothing that changes how the programs it starts load
// code, read files or connect (names.Unsafe), its checks in the C locale (sshd may pass the
// client's LANG and LC_*, which would change what a pattern matches; the cells' shell gets
// gate.conf's locale instead), and its PATH first.
func (g *Gate) cleanEnv() {
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if names.Unsafe(name) {
			os.Unsetenv(name)
		}
	}
	os.Setenv("LC_ALL", "C")
	if p := os.Getenv("PATH"); p != "" {
		os.Setenv("PATH", gatePath+":"+p)
	} else {
		os.Setenv("PATH", gatePath)
	}
}

// signals: HUP, INT and TERM end the session (its shells, then the run reports go out, exit 1);
// before the session they end the gate. The shells' process groups are stopped here at once, as
// the shell gate's EXIT trap did: the request loop may be blocked writing to a busy shell, and
// that write ends once the shell does. A write to a client that went (SIGPIPE) fails instead of
// ending the gate, which then still ends the shells. (Caught, not ignored: the shells get the
// default actions back.)
func (g *Gate) signals() {
	g.termCh = make(chan struct{}, 1)
	ch := make(chan os.Signal, 8)
	signal.Notify(ch, syscall.SIGHUP, syscall.SIGINT, syscall.SIGTERM, syscall.SIGPIPE)
	go func() {
		for s := range ch {
			if s == syscall.SIGPIPE {
				continue
			}
			if !g.started.Load() {
				os.Exit(1)
			}
			g.signalled.Store(true)
			g.ending.Store(true)
			g.stopShells(g.liveShells()...)
			select {
			case g.termCh <- struct{}{}:
			default:
			}
		}
	}()
}

func say(msg string) { os.Stderr.WriteString("md-runbook-gate: " + msg + "\n") }

// fatal: the message on stderr, and exit 2 (after the session's cleanup, once there is one).
func (g *Gate) fatal(msg string) {
	say(msg)
	g.exit(2)
}

func (g *Gate) exit(code int) {
	if g.started.Load() {
		g.cleanup()
	}
	os.Exit(code)
}

// accountFatal: logged, then fatal.
func (g *Gate) accountFatal(msg string) {
	g.log.Event("event", "account-check", "status", "refused", "reason", strings.ReplaceAll(msg, "\n", " "))
	g.fatal(msg)
}

func (g *Gate) main(args []string) int {
	g.configPath = config.Default
	configNamed := false
	for _, a := range args {
		switch {
		case strings.HasPrefix(a, "--config="):
			g.configPath = a[len("--config="):]
			configNamed = true
		case a == "--unsigned=allow" || a == "--unsigned=refuse":
			g.keyUnsigned = a[len("--unsigned="):]
		case strings.HasPrefix(a, "--scopes="):
			g.keyScopes = strings.ReplaceAll(a[len("--scopes="):], ",", " ")
			// Empty is not "every scope": fail closed (security review, 2026-11-16).
			if textutil.Trim(g.keyScopes) == "" {
				g.fatal("--scopes= is empty: name the scopes this key may run, or leave the option out")
			}
		case strings.HasPrefix(a, "--signers="):
			g.keySigners = a[len("--signers="):]
		case strings.HasPrefix(a, "--who="):
			g.who = a[len("--who="):]
		// Only a statement: gate.conf decides (security review round 3, 2026-11-16).
		case a == "--sshd-force-command":
			g.cliForce = true
		default:
			g.fatal("unknown option " + a)
		}
	}
	g.cfg = config.Defaults()
	// A --config= that isn't there is an error, not the built-in defaults (security review,
	// 2026-11-16).
	if configNamed && !exists(g.configPath) {
		g.fatal("no config " + g.configPath + " (--config=)")
	}
	if exists(g.configPath) {
		if !readable(g.configPath) {
			g.fatal("can't read " + g.configPath)
		}
		if err := g.cfg.ReadFile(g.configPath); err != nil {
			g.fatal(err.Error())
		}
	}
	// Before anything runs: the programs the gate runs, from root's folders only.
	g.loadHelpers()
	g.gateComm = selfComm()
	g.settle()
	g.log = &logx.Logger{Dest: g.cfg.Log}
	g.identify()

	// The session's state: the current shell's pid under the session number's hash, for stop
	// requests (a second connection).
	g.state = os.Getenv("HOME")
	if g.state == "" {
		g.state = "/tmp"
	}
	g.state += "/.md-runbook-gate"
	if os.MkdirAll(g.state+"/pids", 0o700) != nil || os.Chmod(g.state, 0o700) != nil {
		g.fatal("can't create " + g.state)
	}
	if cmd := os.Getenv("SSH_ORIGINAL_COMMAND"); g.stopRequest(cmd) {
		return 0
	}
	g.checkAccount()
	return g.session()
}

// settle applies the key's options and checks the settings; a bad one stops the gate.
func (g *Gate) settle() {
	c := &g.cfg
	if g.keyUnsigned != "" {
		c.Unsigned = g.keyUnsigned
	}
	if c.Unsigned != "allow" && c.Unsigned != "refuse" {
		g.fatal("unsigned = " + c.Unsigned + ": expected allow or refuse")
	}
	if c.Scopes == "" {
		g.fatal("scopes = is empty in " + g.configPath + ": name the scopes, or * for any")
	}
	if g.keySigners != "" {
		c.Signers = g.keySigners
	}
	if len(c.Signers) != 1 || c.Signers[0] < '1' || c.Signers[0] > '5' {
		g.fatal("signers = " + c.Signers + ": expected 1 to 5")
	}
	if c.Log != "syslog" {
		f, err := os.OpenFile(c.Log, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o666)
		if err == nil {
			f.Close()
		}
		if err != nil || !writable(c.Log) {
			g.fatal("can't write the log " + c.Log)
		}
	}
	// Absolute folders only: an empty entry or a relative one would be the cell's working folder.
	if !config.AbsoluteList(c.Path) {
		g.fatal("path = " + c.Path + ": expected absolute folders separated by :")
	}
	switch {
	case c.Locale == "auto":
		// C.UTF-8 where the system has it (glibc lists it as C.utf8), else C.
		c.Locale = "C"
		var out []byte
		if loc := g.helper("locale"); loc != "" {
			out, _ = exec.Command(loc, "-a").Output()
		}
		for _, l := range strings.Split(string(out), "\n") {
			if cUTF8.MatchString(l) {
				c.Locale = "C.UTF-8"
				break
			}
		}
	case !config.ValidLocale(c.Locale):
		g.fatal("locale = " + c.Locale + ": expected a locale name such as C.UTF-8, or auto")
	}
	if c.Kubeconfig != "" && !config.AbsoluteList(c.Kubeconfig) {
		g.fatal("kubeconfig = " + c.Kubeconfig + ": expected absolute files separated by :")
	}
	g.checkRunner()
	// Run reports (report_to): optional, and never in a run's way. A bad address is logged at the
	// start of each session and nothing is sent; the runs go on.
	if c.ReportTo != "" {
		if config.ValidReportTo(c.ReportTo) {
			g.reportOn = true
		} else {
			g.reportProblem = "report_to must be an https address without user name or query (http only for localhost)"
		}
	}
}

var cUTF8 = regexp.MustCompile(`^(?i)c\.utf-?8$`)

// identify: the account, the client, who the key is, and this program's path.
func (g *Gate) identify() {
	g.account = "?"
	if id := g.helper("id"); id != "" {
		if out, err := exec.Command(id, "-un").Output(); err == nil {
			g.account = strings.TrimRight(string(out), "\n")
		}
	}
	g.uid = os.Geteuid()
	// sshd_force_command switches off the check of the key lines, so it counts only from a
	// gate.conf out of the account's reach. A key line can't say it (security review round 3).
	// And only together with --sshd-force-command, which only sshd_config's ForceCommand line
	// has: a gate.conf shared with key lines doesn't switch their check off (security review
	// round 4).
	if g.cliForce && !g.cfg.SSHDForceCommand {
		g.fatal("--sshd-force-command needs sshd_force_command = yes in " + g.configPath)
	}
	if g.cfg.SSHDForceCommand && !g.cliForce {
		g.fatal("sshd_force_command = yes in " + g.configPath + " needs --sshd-force-command on sshd_config's ForceCommand line")
	}
	if g.cfg.SSHDForceCommand && g.canChange(g.configPath) {
		g.fatal("sshd_force_command = yes in " + g.configPath + ", a file this account can change: make it and its folder root-owned and not writable by the account")
	}
	g.client, _, _ = strings.Cut(os.Getenv("SSH_CLIENT"), " ")
	if auth := os.Getenv("SSH_USER_AUTH"); auth != "" && readable(auth) {
		g.identifyKey(authKey(auth))
	}
	g.log.Account, g.log.Who, g.log.Client = g.account, g.who, g.client
	if g.cert != nil {
		g.log.CA = g.cert.CA
	}
	// This program's path as sh found it: argv[0], or for a bare name its place in the PATH (a
	// script's $0 was that path).
	g.self = os.Args[0]
	if !strings.Contains(g.self, "/") {
		if p, err := exec.LookPath(g.self); err == nil && strings.HasPrefix(p, "/") {
			g.self = p
		} else if exe, err := os.Executable(); err == nil {
			g.self = exe
		}
	}
}

// identifyKey: who logged in, from the key that did (authKey's).
//   - A user certificate: who is its key ID (what the CA says the person is), unless the key ID
//     isn't fit for the log (sshcert.Name): then the plain key's fingerprint, and the session
//     event says why. The session event also names the serial and the plain key, and every
//     event the CA (cert_ca): the key ID is that CA's word.
//   - A plain key, or a certificate this gate can't read: its fingerprint, as ssh-keygen -l
//     prints it.
//
// --who= on the key line still wins. sshd checked the certificate before the login: the gate
// only reads it.
func (g *Gate) identifyKey(key string) {
	if key == "" {
		return
	}
	c, err := sshcert.FromAuthLine(key)
	if err == nil {
		g.cert = c
		if g.who == "" {
			name, problem := sshcert.Name(c.KeyID)
			g.who, g.certProblem = name, problem
			if name == "" {
				g.who = c.Key
			}
		}
		return
	}
	if !errors.Is(err, sshcert.ErrNotCert) {
		g.certProblem = err.Error()
	}
	if g.who == "" {
		g.who = fingerprint(g.helper("ssh-keygen"), key)
	}
}

// certLog: the session event's fields for a certificate login (none for a plain key). Every
// event has cert_ca too (logx.Logger.CA).
func (g *Gate) certLog() []string {
	var kv []string
	if c := g.cert; c != nil {
		kv = append(kv, "key", c.Key, "cert_serial", strconv.FormatUint(c.Serial, 10))
	}
	if g.certProblem != "" {
		kv = append(kv, "cert_problem", g.certProblem)
	}
	return kv
}

// authKey: the key that logged in: ExposeAuthInfo's file, its first publickey line, without
// "publickey " ("" when there is none).
func authKey(auth string) string {
	data, err := os.ReadFile(auth)
	if err != nil {
		return ""
	}
	for _, l := range strings.Split(string(data), "\n") {
		if key, ok := strings.CutPrefix(l, "publickey "); ok {
			return key
		}
	}
	return ""
}

// fingerprint: a key's fingerprint as ssh-keygen -l prints it.
func fingerprint(keygen, key string) string {
	if keygen == "" {
		return ""
	}
	cmd := exec.Command(keygen, "-lf", "-")
	cmd.Stdin = strings.NewReader(key + "\n")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	first, _, _ := strings.Cut(string(out), "\n")
	if f := textutil.Fields(first); len(f) >= 2 {
		return f[1]
	}
	return ""
}

// canChange: the account could change the file: it can write it or its folder, or it owns it
// (and so could chmod it).
func (g *Gate) canChange(path string) bool {
	dir := "."
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		dir = path[:i]
		if dir == "" {
			dir = "/"
		}
	}
	if writable(path) || writable(dir) {
		return true
	}
	var st syscall.Stat_t
	return syscall.Stat(path, &st) == nil && int(st.Uid) == g.uid
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func isLink(path string) bool {
	st, err := os.Lstat(path)
	return err == nil && st.Mode()&os.ModeSymlink != 0
}

func readable(path string) bool   { return syscall.Access(path, 4) == nil }
func writable(path string) bool   { return syscall.Access(path, 2) == nil }
func executable(path string) bool { return syscall.Access(path, 1) == nil }

// phys: a path with its folder's links resolved, "" when it can't be.
func phys(p string) string {
	i := strings.LastIndexByte(p, '/')
	if i < 0 {
		return ""
	}
	d, err := filepath.EvalSymlinks(p[:i+1])
	if err != nil {
		return ""
	}
	if d, err = filepath.Abs(d); err != nil {
		return ""
	}
	return strings.TrimSuffix(d, "/") + "/" + p[i+1:]
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// ---- the session ----

// sess is a session's state, in memory only: nothing a cell could change.
type sess struct {
	started atomic.Bool
	termCh  chan struct{}
	// signalled: HUP, INT or TERM ended the session (exit 1, no end-session event).
	signalled atomic.Bool
	// ending: the session's shells are being ended (a Job's shells then need nothing in the pod).
	ending atomic.Bool

	work       string
	token      string
	skey       string
	sessionTop int
	topFound   bool

	slots    [nSlots]slot
	cur      int
	uses     int
	shells   int
	pidShown bool
	liveMu   sync.Mutex
	live     map[*shell]bool
	endCh    chan struct{}

	loaded     bool
	man        *manifest.Manifest
	principal  string
	mhash      string
	mname      string
	mversion   string
	stepCell   string
	stepNext   string
	runs       int
	pnames     []string
	params     map[string]string
	exported   []string
	calledBy   string
	calledCall string
	note       proto.Note

	reportRuns []report.Run
	rbManifest map[string]*manifest.Manifest
	rbSigner   map[string]string

	// Separated mode: the file the cells' shells append each run's exit to, what the gate read of
	// it, and the runs it waits for.
	exitsPath string
	exitsMu   sync.Mutex
	exitsOff  int64
	exitsBuf  []byte
	exitsBad  string // why the exits file is not what the shells wrote ("" while it is)
	sepRuns   map[string]sepRun
	sepExits  map[string]report.Exit
}

func itoa(n int) string { return strconv.Itoa(n) }

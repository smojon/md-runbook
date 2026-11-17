//go:build unix

package gate

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/smojon/md-runbook/apps/gate/internal/logx"
	"github.com/smojon/md-runbook/apps/gate/internal/procs"
	"github.com/smojon/md-runbook/apps/gate/internal/report"
	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// ---- separated mode (cells_accounts = or cells_account = in gate.conf) ----
// The cells run as a second, unprivileged account, through `sudo -n -u ACCOUNT` and this
// program's cells mode: each session as an account of its own, leased from a pool (cellspool.go).
// So a block can't read what only the gate's account can: the report token, the log, the gate's
// pipes and /proc entries, the session's work folder; nor reach another session's shells. What
// the cells' shell must tell the gate (each run's exit, a kube-context refusal) it writes to a
// file it can only append to, with the run's random number (exitsFile); the gate logs the `end`
// events itself.
//
// Before each session the gate checks every account of the pool (selfCheck), and refuses to
// start when:
//   - an account doesn't exist, is root, or is the gate's own, or two have the same uid;
//   - one is in a privileged group, or may use cron or at;
//   - `sudo -n -l` lists anything but the one rule (sudoRule), naming the whole pool;
//   - a folder above the gate's program, gate.conf, the trusted keys, revoked, floors, the
//     account's keys, the report token or the log is not safe (safePathProblem: the rule of
//     OpenSSH's StrictModes).
//
// Those checks run nothing as the pool's accounts. Then, for the account the session leased only,
// once none of its processes is left (leaseCells), its cells' mode through sudo (access): never
// as an account another session's blocks run as (review of 0.30.0, H2). It refuses when
//   - the cells' account can read the report token or the log, or change the gate's program,
//     gate.conf, the trusted keys, the account's keys or the gate's state;
//   - it can't append to the session's exits file (the work folder is in /tmp).

// cellsInfo is a cells account as the self-check found it.
type cellsInfo struct {
	name   string
	uid    int
	home   string
	groups map[int]bool
}

// runFunc runs a program: argv, its environment (nil: a plain one), stdin; its stdout.
type runFunc func(argv, env []string, stdin []byte) ([]byte, error)

// selfCheck is what the separated mode's check needs: how to run programs (tests give their own)
// and what to check.
type selfCheck struct {
	run  runFunc
	plan plan // the programs (exe, sudo); its account is set for each account checked
	// The pool, and the setting that named it (cells_account or cells_accounts), for messages.
	pool        []string
	key         string
	sh, id      string // the programs (helpers.go)
	gateAccount string
	gateUID     int
	// The cells' account must not read noRead, nor write noWrite, but must write mustWrite.
	noRead, noWrite, mustWrite []string
	// The files whose folders must be safe up to / (safePathProblem, cellsRule), and how to stat a
	// path (lstat): tests give their own.
	safe []string
	stat statFunc
	// Where cron and at take their allow and deny lists from.
	cron cronSetup
}

// what: how messages name an account of the pool.
func (c selfCheck) what(name string) string {
	if c.key == "cells_account" {
		return "cells_account = " + name
	}
	return "cells_accounts: " + name
}

// do runs the check; each account of the pool, or why the gate must not start.
func (c selfCheck) do() ([]cellsInfo, error) {
	if len(c.pool) == 0 {
		return nil, errors.New(c.key + ": no account")
	}
	if c.id == "" || c.sh == "" {
		return nil, errors.New(c.key + ": no id or sh in " + sysPath)
	}
	if c.gateUID == 0 {
		return nil, errors.New(c.key + " needs the gate to run as an account other than root")
	}
	var infos []cellsInfo
	uids := map[int]string{}
	for _, name := range c.pool {
		info, err := c.account(name)
		if err != nil {
			return nil, err
		}
		// Two names of one uid would be one account: its sessions could reach each other.
		if other, ok := uids[info.uid]; ok {
			return nil, errors.New(c.key + ": " + other + " and " + name + " are the same account (uid " + strconv.Itoa(info.uid) + "): give each session an account of its own")
		}
		uids[info.uid] = name
		infos = append(infos, info)
	}
	need := c.need()
	if c.plan.exe == "" {
		return nil, errors.New(c.key + ": can't find this program's own path")
	}
	if c.plan.sudo == "" {
		return nil, errors.New(c.key + ": no sudo in " + sysPath + need)
	}
	out, err := c.run([]string{c.plan.sudo, "-n", "-l"}, nil, nil)
	if p := sudoProblem(string(out), c.pool, c.plan.exe); p != "" {
		return nil, errors.New(c.key + ": " + p + need)
	} else if err != nil {
		return nil, errors.New(c.key + ": sudo -n -l failed (" + err.Error() + ")" + need)
	}
	for _, info := range infos {
		if err := c.folders(info); err != nil {
			return nil, err
		}
	}
	return infos, nil
}

// need: the sudoers line separated mode needs, for messages.
func (c selfCheck) need() string {
	return "\n  Separated mode needs exactly this sudoers line (for example in /etc/sudoers.d/md-runbook-gate), and no other rule for " + c.gateAccount + ":\n  " + sudoRule(c.gateAccount, c.pool, c.plan.exe)
}

// account: what the check needs to know of an account of the pool, and its own problems.
func (c selfCheck) account(name string) (cellsInfo, error) {
	info := cellsInfo{name: name, groups: map[int]bool{}}
	what := c.what(name)
	out, err := c.run([]string{c.id, "-u", name}, nil, nil)
	uid, aerr := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || aerr != nil {
		return info, errors.New(what + ": no such account")
	}
	switch {
	case uid == 0:
		return info, errors.New(what + " is root: give the cells an unprivileged account of their own")
	case uid == c.gateUID:
		return info, errors.New(what + " is the gate's own account: give the cells an account of their own")
	}
	info.uid = uid
	// Its groups: a folder writable by one of them is writable by the cells.
	out, err = c.run([]string{c.id, "-G", name}, nil, nil)
	if err != nil {
		return info, errors.New(what + ": can't list its groups (id -G)")
	}
	for _, f := range strings.Fields(string(out)) {
		if g, err := strconv.Atoi(f); err == nil {
			info.groups[g] = true
		}
	}
	// No privileged group: through one, the cells could do more than the gate's account.
	if out, err := c.run([]string{c.id, "-Gn", name}, nil, nil); err != nil {
		return info, errors.New(what + ": can't list its groups (id -Gn)")
	} else if bad := privilegedGroups(string(out)); len(bad) > 0 || info.groups[0] {
		if info.groups[0] && !has(bad, "gid 0") {
			bad = append(bad, "gid 0")
		}
		return info, errors.New(what + " is in the group " + strings.Join(bad, ", ") + ": give the cells an account without privileged groups")
	}
	// No cron or at jobs: one could start mid-session and reach the session's shells.
	if probs := cronProblems(c.cron, name); len(probs) > 0 {
		return info, errors.New(what + ": " + strings.Join(probs, "; ") + " (a job of a cells account could reach the shells of a session that leased it)")
	}
	// Its home folder (getpwnam, as the shell's ~NAME reads it): where the cells start.
	if out, err := c.run([]string{c.sh, "-c", "printf '%s' ~" + name}, nil, nil); err == nil && strings.HasPrefix(string(out), "/") {
		info.home = string(out)
	}
	return info, nil
}

// folders: the folders above the gate's files are safe from the account (as the gate sees them:
// nothing runs as the account).
func (c selfCheck) folders(info cellsInfo) error {
	var unsafe []string
	for _, p := range c.safe {
		if why := safePathProblem(p, c.stat, cellsRule(c.gateUID, info.uid, info.groups, c.gateAccount, info.name)); why != "" && !has(unsafe, why) {
			unsafe = append(unsafe, why)
		}
	}
	if len(unsafe) > 0 {
		return errors.New(c.what(info.name) + ": " + strings.Join(unsafe, "; "))
	}
	return nil
}

// access: the account can't reach the gate's files, and can append to the session's exits file:
// its cells' mode, through sudo, checks what it can read and write. Only for the account this
// session leased, once none of its processes is left (leaseCells): a process of an account that
// another session holds could stop that check, or read the session's exits path from it (review
// of 0.30.0, H2).
func (c selfCheck) access(info cellsInfo) error {
	name, what, need := info.name, c.what(info.name), c.need()
	p := c.plan
	p.account = name
	l := p.outer("", true)
	out, err := c.run(l.argv, l.env, cellsReq{Op: "check", Read: c.noRead, Write: append(append([]string{}, c.noWrite...), c.mustWrite...)}.encode())
	var res checkResult
	if err != nil || json.Unmarshal(out, &res) != nil {
		msg := "can't run the cells' mode as " + name + " through sudo"
		if err != nil {
			msg += " (" + err.Error() + ")"
		}
		return errors.New(what + ": " + msg + need)
	}
	if res.UID != info.uid {
		return errors.New(what + ": sudo ran the cells' mode as uid " + strconv.Itoa(res.UID) + ", not " + strconv.Itoa(info.uid))
	}
	var problems []string
	if len(res.Read) > 0 {
		problems = append(problems, name+" can read "+strings.Join(res.Read, ", ")+": make it unreadable for that account")
	}
	var changes, misses []string
	for _, p := range c.noWrite {
		if has(res.Write, p) {
			changes = append(changes, p)
		}
	}
	for _, p := range c.mustWrite {
		if !has(res.Write, p) {
			misses = append(misses, p)
		}
	}
	if len(changes) > 0 {
		problems = append(problems, name+" can change "+strings.Join(changes, ", ")+": make it root-owned (or the gate's account's) and not writable by that account")
	}
	if len(misses) > 0 {
		problems = append(problems, name+" can't append to "+strings.Join(misses, ", ")+", the session's exits file: it must be able to enter /tmp")
	}
	if len(problems) > 0 {
		return errors.New(what + ": " + strings.Join(problems, "; "))
	}
	return nil
}

func has(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// sudoEntries: the rules `sudo -n -l` lists (the lines under "... may run the following commands
// on ...:"), blanks collapsed.
func sudoEntries(out string) []string {
	var entries []string
	in := false
	for _, l := range strings.Split(strings.ReplaceAll(out, "\r", ""), "\n") {
		if strings.Contains(l, "may run the following commands") {
			in = true
			continue
		}
		if !in {
			continue
		}
		t := strings.Join(strings.Fields(l), " ")
		if t == "" {
			continue
		}
		if l[0] != ' ' && l[0] != '\t' {
			in = false
			continue
		}
		entries = append(entries, t)
	}
	return entries
}

// sudoProblem: "" when `sudo -n -l` lists exactly the one rule, else what is wrong.
func sudoProblem(out string, pool []string, exe string) string {
	e := sudoEntries(out)
	switch {
	case len(e) == 1 && isPoolRule(e[0], pool, exe):
		return ""
	case len(e) == 0:
		return "sudo -n -l lists no rule for this account"
	}
	return "sudo -n -l lists " + strings.Join(e, " | ") + ": that is not exactly the one rule (a wider one lets the gate's account do more than start the cells)"
}

// isPoolRule: a rule as `sudo -n -l` lists it is `(RUNAS) NOPASSWD: EXE __cells`, and its RUNAS
// list (names separated by commas, as sudo prints them: ", ") names each account of the pool, in
// any order, and nothing else: no ALL, no group (`a : b`), no other account, no negation. sudo
// matches a runas list as a set, so the order is the admin's.
func isPoolRule(entry string, pool []string, exe string) bool {
	rest, ok := strings.CutPrefix(entry, "(")
	if !ok {
		return false
	}
	runas, cmd, ok := strings.Cut(rest, ")")
	if !ok || cmd != " NOPASSWD: "+exe+" "+CellsMode {
		return false
	}
	seen := map[string]bool{}
	for _, n := range strings.Split(runas, ",") {
		n = strings.TrimSpace(n)
		if !has(pool, n) {
			return false
		}
		seen[n] = true
	}
	return len(seen) == len(pool)
}

// separated: the cells run as accounts of their own.
func (g *Gate) separated() bool { return len(g.cfg.CellsPool()) > 0 }

// mode is the gate's mode, as run reports say it. A Kubernetes Job counts as separated: its
// cells can't reach the gate's pod (job.go).
func (g *Gate) mode() string {
	if g.apart() {
		return report.Separated
	}
	return report.Shared
}

// setupSeparated: the work folder open to the cells (enter only), the exits file they append to,
// the self-check of every account of the pool, and the session's lease of one (with none of its
// processes left, then its cells' mode's check). Any problem stops the gate before its first
// shell.
func (g *Gate) setupSeparated() {
	if os.Chmod(g.work, 0o711) != nil {
		g.fatal("can't open the work folder " + g.work + " to the cells' account")
	}
	g.exitsPath = g.work + "/exits." + randHex(16)
	f, err := os.OpenFile(g.exitsPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		g.fatal("can't create " + g.exitsPath)
	}
	f.Close()
	// Others may append, not read: the cells' account, and the random name hides it from the rest.
	if os.Chmod(g.exitsPath, 0o622) != nil {
		g.fatal("can't create " + g.exitsPath)
	}
	var noRead, noWrite []string
	add := func(list *[]string, ps ...string) {
		for _, p := range ps {
			if p != "" && !has(*list, p) {
				*list = append(*list, p)
			}
		}
	}
	dirOf := func(p string) string {
		if !strings.HasPrefix(p, "/") {
			return ""
		}
		return filepath.Dir(p)
	}
	if g.cfg.ReportToken != "" {
		add(&noRead, g.cfg.ReportToken)
		add(&noWrite, g.cfg.ReportToken)
	}
	if g.cfg.Log != "syslog" {
		add(&noRead, g.cfg.Log)
		add(&noWrite, g.cfg.Log, dirOf(g.cfg.Log))
	}
	add(&noWrite, g.plan.exe, dirOf(g.plan.exe), g.configPath, dirOf(g.configPath), g.cfg.AllowedSigners, g.cfg.Revoked, g.cfg.Floors, g.state, dirOf(g.state), g.work)
	for _, k := range g.keys {
		add(&noWrite, k, dirOf(k))
	}
	// The files whose folders up to / must be safe from the cells' account.
	var safe []string
	add(&safe, g.plan.exe, g.configPath, g.cfg.AllowedSigners, g.cfg.Revoked, g.cfg.Floors, g.cfg.ReportToken)
	if g.cfg.Log != "syslog" {
		add(&safe, g.cfg.Log)
	}
	add(&safe, g.keys...)
	c := selfCheck{run: runCmd, plan: g.plan, pool: g.cfg.CellsPool(), key: g.cfg.CellsKey(), sh: g.helper("sh"), id: g.helper("id"), gateAccount: g.account, gateUID: g.uid,
		noRead: noRead, noWrite: noWrite, mustWrite: []string{g.exitsPath}, safe: safe, stat: lstat, cron: systemCron()}
	infos, err := c.do()
	if err != nil {
		g.log.Event("event", "self-check", "status", "refused", "reason", strings.ReplaceAll(err.Error(), "\n", " "))
		g.fatal(err.Error())
	}
	g.leaseCells(c, infos)
	g.sepRuns = map[string]sepRun{}
	g.sepExits = map[string]report.Exit{}
	go func() {
		for {
			nap()
			g.readExitsFile()
		}
	}()
}

// sepRun: a signed run of separated mode: its request id and random number.
type sepRun struct{ rid, nonce string }

// exitsMax: the most of the exits file the gate reads in a session.
const exitsMax = 16 << 20

// readExitsFile reads what the cells' shells appended since the last read: each run's exit, as
// `N EXIT TIME NONCE [KUBE-REASON]` (tab-separated), one line per signed run; the gate logs its
// `end` event then (and the kube-context refusal it names).
//
// Only the shells write there, but the cells' account can write the file, so a block of this
// session can change it in place (review of 0.28.0, M1: within a session, as Trust says). What
// isn't exactly a line the gate waits for ends the session, and no run report goes out: a line
// that doesn't parse, a wrong number or random number, a second line for a run, a shorter file,
// one past exitsMax (junkExits).
func (g *Gate) readExitsFile() {
	g.exitsMu.Lock()
	defer g.exitsMu.Unlock()
	if g.exitsBad != "" {
		return
	}
	f, err := os.Open(g.exitsPath)
	if err != nil {
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return
	}
	size := st.Size()
	switch {
	case size < g.exitsOff:
		g.junkExits("it got shorter")
		return
	case size > exitsMax:
		g.junkExits("it is over " + itoa(exitsMax>>20) + " MiB")
		return
	}
	for size > g.exitsOff && g.exitsBad == "" {
		n := min(size-g.exitsOff, 1<<16)
		buf := make([]byte, n)
		got, _ := f.ReadAt(buf, g.exitsOff)
		if got <= 0 {
			break
		}
		g.exitsOff += int64(got)
		g.exitsBuf = append(g.exitsBuf, buf[:got]...)
		for g.exitsBad == "" {
			i := strings.IndexByte(string(g.exitsBuf), '\n')
			if i < 0 {
				break
			}
			g.exitLine(string(g.exitsBuf[:i]))
			g.exitsBuf = g.exitsBuf[i+1:]
		}
		if len(g.exitsBuf) > 4096 {
			g.junkExits("a line is over 4096 bytes")
		}
	}
}

// junkExits: the exits file is not what the shells write (exitsMu held). Logged, said, and the
// session ends; its run reports don't go out.
func (g *Gate) junkExits(why string) {
	if g.exitsBad != "" {
		return
	}
	g.exitsBad = why
	msg := "the session's exits file was changed (" + why + "): the session ends"
	say(msg)
	g.log.Event("event", "exits", "status", "refused", "reason", msg)
	select {
	case g.endCh <- struct{}{}:
	default:
	}
}

// exitLine takes one line of the exits file (exitsMu held).
func (g *Gate) exitLine(line string) {
	f := strings.Split(line, "\t")
	if len(f) < 4 || len(f) > 5 {
		g.junkExits("a line that doesn't parse")
		return
	}
	run, ok := g.sepRuns[f[0]]
	_, done := g.sepExits[f[0]]
	switch {
	case !ok:
		g.junkExits("a line for no run of this session")
		return
	case done:
		g.junkExits("a second line for run " + f[0])
		return
	case run.nonce == "" || f[3] != run.nonce:
		g.junkExits("a line for run " + f[0] + " without its random number")
		return
	}
	rc := f[1]
	if !textutil.IsNum(rc) || len(rc) > 3 {
		g.junkExits("an exit that is no number")
		return
	}
	at := f[2]
	if !isUTCTime(at) {
		at = logx.Now()
	}
	g.sepExits[f[0]] = report.Exit{RC: rc, Time: at}
	if len(f) == 5 && f[4] != "" {
		g.log.Event("event", "refused", "id", run.rid, "reason", textutil.Cut(f[4], 600))
	}
	end := g.log.Line("event", "end", "id", run.rid)
	g.log.Write(end[:len(end)-1] + `,"exit":` + strconv.Itoa(atoi(rc)) + "}")
}

// isUTCTime: YYYY-MM-DDTHH:MM:SSZ, as `date -u +%Y-%m-%dT%H:%M:%SZ` prints it.
func isUTCTime(s string) bool {
	if len(s) != 20 || s[19] != 'Z' || s[10] != 'T' {
		return false
	}
	for i, c := range s[:19] {
		switch i {
		case 4, 7:
			if c != '-' {
				return false
			}
		case 10:
		case 13, 16:
			if c != ':' {
				return false
			}
		default:
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	return true
}

// sepExitsCopy: the exits read so far (for the run reports).
func (g *Gate) sepExitsCopy() map[string]report.Exit {
	g.exitsMu.Lock()
	defer g.exitsMu.Unlock()
	out := make(map[string]report.Exit, len(g.sepExits))
	for k, v := range g.sepExits {
		out[k] = v
	}
	return out
}

// privileged: groups whose members can do more than an account of their own (become root, read
// logs or disks, run containers).
var privileged = []string{"root", "sudo", "wheel", "admin", "adm", "docker", "lxd", "incus-admin", "libvirt", "kvm", "disk", "systemd-journal", "shadow"}

// privilegedGroups: the privileged groups among `id -Gn`'s.
func privilegedGroups(idGn string) []string {
	var out []string
	for _, g := range strings.Fields(idGn) {
		if has(privileged, g) && !has(out, g) {
			out = append(out, g)
		}
	}
	return out
}

// cronSetup: where cron and at read who may use them, and whether they are installed.
type cronSetup struct {
	dir         string // /etc (macOS: /usr/lib/cron)
	crontab, at bool
	read        func(string) ([]byte, error)
}

// systemCron: this server's.
func systemCron() cronSetup {
	dir := "/etc"
	if runtime.GOOS == "darwin" {
		dir = "/usr/lib/cron"
	}
	return cronSetup{dir: dir, crontab: inPath(sysPath, "crontab") != "", at: inPath(sysPath, "at") != "", read: os.ReadFile}
}

// cronProblems: "" for each tool the account can't use. It can't when tool.deny lists it, or
// tool.allow exists without it; anything else (neither file: each tool has its own default)
// counts as allowed. A file that can't be read is a problem too.
func cronProblems(c cronSetup, name string) []string {
	var out []string
	for _, t := range []struct {
		tool string
		on   bool
	}{{"cron", c.crontab}, {"at", c.at}} {
		if !t.on {
			continue
		}
		allow, deny := c.dir+"/"+t.tool+".allow", c.dir+"/"+t.tool+".deny"
		if a, err := c.read(allow); err == nil {
			if listed(string(a), name) {
				out = append(out, allow+" lists "+name+": remove it")
			}
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			out = append(out, "can't read "+allow+": make it readable by the gate's account")
			continue
		}
		d, err := c.read(deny)
		switch {
		case err == nil && listed(string(d), name):
		case err != nil && !errors.Is(err, fs.ErrNotExist):
			out = append(out, "can't read "+deny+": make it readable by the gate's account")
		default:
			out = append(out, name+" may use "+t.tool+": add it to "+deny+" (or create "+allow+" without it)")
		}
	}
	return out
}

// listed: a line of an allow or deny file is the name.
func listed(file, name string) bool {
	for _, l := range strings.Split(file, "\n") {
		if strings.TrimSpace(l) == name {
			return true
		}
	}
	return false
}

// selfComm: this program's name as process listings show it.
func selfComm() string {
	if b, err := os.ReadFile("/proc/self/stat"); err == nil {
		if p, ok := procs.ParseStat(string(b)); ok {
			return p.Comm
		}
	}
	return procs.Comm(os.Args[0])
}

// exitsBadNow: why the exits file was refused, "" while it is fine.
func (g *Gate) exitsBadNow() string {
	g.exitsMu.Lock()
	defer g.exitsMu.Unlock()
	return g.exitsBad
}

//go:build unix

package gate

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/smojon/md-runbook/apps/gate/internal/logx"
	"github.com/smojon/md-runbook/apps/gate/internal/procs"
	"github.com/smojon/md-runbook/apps/gate/internal/report"
	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// ---- separated mode (cells_account = in gate.conf) ----
// The cells run as a second, unprivileged account, through `sudo -n -u ACCOUNT` and this
// program's cells mode. So a block can't read what only the gate's account can: the report token,
// the log, the gate's pipes and /proc entries, the session's work folder. What the cells' shell
// must tell the gate (each run's exit, a kube-context refusal) it writes to a file it can only
// append to, with the run's random number (exitsFile); the gate logs the `end` events itself.
//
// Before each session the gate checks (selfCheck), and refuses to start when:
//   - the account doesn't exist, is root, or is the gate's own;
//   - `sudo -n -l` lists anything but the one rule (sudoRule);
//   - a folder above the gate's program, gate.conf, the trusted keys, revoked, floors, the
//     account's keys, the report token or the log is not safe (safePathProblem: the rule of
//     OpenSSH's StrictModes);
//   - the cells' account can read the report token or the log, or change the gate's program,
//     gate.conf, the trusted keys, the account's keys or the gate's state;
//   - it can't append to the session's exits file (the work folder is in /tmp).

// cellsInfo is the cells' account as the self-check found it.
type cellsInfo struct {
	uid  int
	home string
}

// runFunc runs a program: argv, its environment (nil: a plain one), stdin; its stdout.
type runFunc func(argv, env []string, stdin []byte) ([]byte, error)

// selfCheck is what the separated mode's check needs: how to run programs (tests give their own)
// and what to check.
type selfCheck struct {
	run         runFunc
	plan        plan
	sh          string
	gateAccount string
	gateUID     int
	// The cells' account must not read noRead, nor write noWrite, but must write mustWrite.
	noRead, noWrite, mustWrite []string
	// The files whose folders must be safe up to / (safePathProblem), how to stat a path (lstat)
	// and how to resolve one (its links): tests give their own.
	safe []string
	stat statFunc
	real func(string) (string, error)
}

// pathInfo is what the safe-path rule needs of a file or folder.
type pathInfo struct {
	uid, gid int
	perm     os.FileMode // the permission bits
	sticky   bool
}

// statFunc stats a path without following a link.
type statFunc func(path string) (pathInfo, error)

// lstat is the real statFunc.
func lstat(p string) (pathInfo, error) {
	fi, err := os.Lstat(p)
	if err != nil {
		return pathInfo{}, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return pathInfo{}, errors.New("no owner")
	}
	return pathInfo{uid: int(st.Uid), gid: int(st.Gid), perm: fi.Mode().Perm(), sticky: fi.Mode()&os.ModeSticky != 0}, nil
}

// safePathProblem: "" when every folder from p up to / is safe from the cells' account, else
// why not (the folder named). The rule of OpenSSH's StrictModes: each folder is owned by root or
// by the gate's account, and the cells' account can't write it (as its owner, through one of its
// groups, or as anyone). A sticky folder it can write (/tmp) is safe when the entry below it is
// root's or the gate account's: then others can't rename or replace that entry. p's links are
// resolved first; a p that doesn't exist yet is checked as where it would be.
func safePathProblem(p string, st statFunc, real func(string) (string, error), gateUID, cellsUID int, cellsGroups map[int]bool, gateAccount, cells string) string {
	if !strings.HasPrefix(p, "/") {
		a, err := filepath.Abs(p)
		if err != nil {
			return "can't check " + p
		}
		p = a
	}
	p = filepath.Clean(p)
	if r, err := real(p); err == nil && strings.HasPrefix(r, "/") {
		p = r
	} else if r, err := real(filepath.Dir(p)); err == nil && strings.HasPrefix(r, "/") {
		p = filepath.Join(r, filepath.Base(p))
	} else {
		return "the folder of " + p + " doesn't exist"
	}
	child, d := p, filepath.Dir(p)
	for {
		di, err := st(d)
		if err != nil {
			return "can't check " + d + ", a folder above " + p
		}
		if di.uid != 0 && di.uid != gateUID {
			return d + ", a folder above " + p + ", is owned by uid " + strconv.Itoa(di.uid) + ": make it root's (or " + gateAccount + "'s)"
		}
		writable := di.perm&0o002 != 0 || (cellsGroups[di.gid] && di.perm&0o020 != 0) || (di.uid == cellsUID && di.perm&0o200 != 0)
		if writable {
			if !di.sticky {
				return d + ", a folder above " + p + ", is writable by " + cells + ": make it writable by root (or " + gateAccount + ") alone"
			}
			ci, err := st(child)
			if err != nil {
				return child + " doesn't exist in " + d + ", which " + cells + " can write: create it as root (or " + gateAccount + ")"
			}
			if ci.uid != 0 && ci.uid != gateUID {
				return child + " is owned by uid " + strconv.Itoa(ci.uid) + " in " + d + ", which " + cells + " can write: make it root's (or " + gateAccount + "'s)"
			}
		}
		if d == "/" {
			return ""
		}
		child, d = d, filepath.Dir(d)
	}
}

// do runs the check; the cells' account, or why the gate must not start.
func (c selfCheck) do() (cellsInfo, error) {
	var info cellsInfo
	name := c.plan.account
	out, err := c.run([]string{"id", "-u", name}, nil, nil)
	uid, aerr := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || aerr != nil {
		return info, errors.New("cells_account = " + name + ": no such account")
	}
	switch {
	case uid == 0:
		return info, errors.New("cells_account = " + name + " is root: give the cells an unprivileged account of their own")
	case uid == c.gateUID:
		return info, errors.New("cells_account = " + name + " is the gate's own account: give the cells an account of their own")
	case c.gateUID == 0:
		return info, errors.New("cells_account needs the gate to run as an account other than root")
	}
	info.uid = uid
	// Its groups: a folder writable by one of them is writable by the cells.
	groups := map[int]bool{}
	out, err = c.run([]string{"id", "-G", name}, nil, nil)
	if err != nil {
		return info, errors.New("cells_account = " + name + ": can't list its groups (id -G)")
	}
	for _, f := range strings.Fields(string(out)) {
		if g, err := strconv.Atoi(f); err == nil {
			groups[g] = true
		}
	}
	// Its home folder (getpwnam, as the shell's ~NAME reads it): where the cells start.
	if out, err := c.run([]string{c.sh, "-c", "printf '%s' ~" + name}, nil, nil); err == nil && strings.HasPrefix(string(out), "/") {
		info.home = string(out)
	}
	rule := c.plan.sudoRule(c.gateAccount)
	need := "\n  Separated mode needs exactly this sudoers line (for example in /etc/sudoers.d/md-runbook-gate), and no other rule for " + c.gateAccount + ":\n  " + rule
	if c.plan.exe == "" {
		return info, errors.New("cells_account: can't find this program's own path")
	}
	if c.plan.sudo == "" {
		return info, errors.New("cells_account = " + name + ": no sudo in " + gatePath + need)
	}
	out, err = c.run([]string{c.plan.sudo, "-n", "-l"}, nil, nil)
	if p := sudoProblem(string(out), c.plan.account, c.plan.exe); p != "" {
		return info, errors.New("cells_account = " + name + ": " + p + need)
	} else if err != nil {
		return info, errors.New("cells_account = " + name + ": sudo -n -l failed (" + err.Error() + ")" + need)
	}
	var unsafe []string
	for _, p := range c.safe {
		if why := safePathProblem(p, c.stat, c.real, c.gateUID, uid, groups, c.gateAccount, name); why != "" && !has(unsafe, why) {
			unsafe = append(unsafe, why)
		}
	}
	if len(unsafe) > 0 {
		return info, errors.New("cells_account = " + name + ": " + strings.Join(unsafe, "; "))
	}
	l := c.plan.outer("", true)
	out, err = c.run(l.argv, l.env, cellsReq{Op: "check", Read: c.noRead, Write: append(append([]string{}, c.noWrite...), c.mustWrite...)}.encode())
	var res checkResult
	if err != nil || json.Unmarshal(out, &res) != nil {
		msg := "can't run the cells' mode as " + name + " through sudo"
		if err != nil {
			msg += " (" + err.Error() + ")"
		}
		return info, errors.New("cells_account = " + name + ": " + msg + need)
	}
	if res.UID != uid {
		return info, errors.New("cells_account = " + name + ": sudo ran the cells' mode as uid " + strconv.Itoa(res.UID) + ", not " + strconv.Itoa(uid))
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
		return info, errors.New("cells_account = " + name + ": " + strings.Join(problems, "; "))
	}
	return info, nil
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
func sudoProblem(out, account, exe string) string {
	want := "(" + account + ") NOPASSWD: " + exe + " " + CellsMode
	e := sudoEntries(out)
	switch {
	case len(e) == 1 && e[0] == want:
		return ""
	case len(e) == 0:
		return "sudo -n -l lists no rule for this account"
	}
	return "sudo -n -l lists " + strings.Join(e, " | ") + ": that is not exactly the one rule (a wider one lets the gate's account do more than start the cells)"
}

// separated: the cells run as an account of their own.
func (g *Gate) separated() bool { return g.cfg.CellsAccount != "" }

// mode is the gate's mode, as run reports say it.
func (g *Gate) mode() string {
	if g.separated() {
		return report.Separated
	}
	return report.Shared
}

// setupSeparated: the work folder open to the cells (enter only), the exits file they append to,
// and the self-check. Any problem stops the gate before its first shell.
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
	c := selfCheck{run: runCmd, plan: g.plan, sh: "/bin/sh", gateAccount: g.account, gateUID: g.uid, noRead: noRead, noWrite: noWrite, mustWrite: []string{g.exitsPath},
		safe: safe, stat: lstat, real: filepath.EvalSymlinks}
	info, err := c.do()
	if err != nil {
		g.log.Event("event", "self-check", "status", "refused", "reason", strings.ReplaceAll(err.Error(), "\n", " "))
		g.fatal(err.Error())
	}
	g.cells = info
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
// `N EXIT TIME NONCE [KUBE-REASON]` (tab-separated). The first line with a run's number counts, as
// in report-exits; the gate logs its `end` event then (and the kube-context refusal it names). A
// shorter file (truncated) is read again from its start: what was read stays read.
func (g *Gate) readExitsFile() {
	g.exitsMu.Lock()
	defer g.exitsMu.Unlock()
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
	if size < g.exitsOff {
		g.exitsOff, g.exitsBuf = 0, nil
	}
	for size > g.exitsOff && g.exitsRead < exitsMax {
		n := min(size-g.exitsOff, 1<<16)
		buf := make([]byte, n)
		got, _ := f.ReadAt(buf, g.exitsOff)
		if got <= 0 {
			break
		}
		g.exitsOff += int64(got)
		g.exitsRead += int64(got)
		g.exitsBuf = append(g.exitsBuf, buf[:got]...)
		for {
			i := strings.IndexByte(string(g.exitsBuf), '\n')
			if i < 0 {
				break
			}
			g.exitLine(string(g.exitsBuf[:i]))
			g.exitsBuf = g.exitsBuf[i+1:]
		}
		if len(g.exitsBuf) > 4096 {
			g.exitsBuf = nil
		}
	}
}

// exitLine takes one line of the exits file (exitsMu held).
func (g *Gate) exitLine(line string) {
	f := strings.Split(line, "\t")
	if len(f) < 4 || len(f) > 5 {
		return
	}
	run, ok := g.sepRuns[f[0]]
	if _, done := g.sepExits[f[0]]; !ok || done || run.nonce == "" || f[3] != run.nonce {
		return
	}
	rc := f[1]
	if !textutil.IsNum(rc) || len(rc) > 3 {
		rc = "1"
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

// sweepCells: with kill_leftovers = yes in separated mode, the cells' account's processes that
// belong to no live session end too (the cells' mode does it, as that account; Linux).
func (g *Gate) sweepCells(when string) {
	if g.cfg.KillLeftovers != "yes" || !g.separated() {
		return
	}
	if !procs.HaveProc() {
		g.log.Event("event", "leftovers", "status", "skipped", "reason", "no /proc here", "cells", g.cfg.CellsAccount, "when", when)
		return
	}
	l := g.plan.outer("", true)
	out, err := runCmd(l.argv, l.env, cellsReq{Op: "sweep"}.encode())
	var res sweepResult
	if err != nil || json.Unmarshal(out, &res) != nil {
		g.log.Event("event", "leftovers", "status", "skipped", "reason", "can't run the cells' mode", "cells", g.cfg.CellsAccount, "when", when)
		return
	}
	if res.Incomplete {
		g.log.Event("event", "leftovers", "status", "incomplete", "reason", "sweep incomplete: processes of the cells' account kept appearing (a fork loop?)", "cells", g.cfg.CellsAccount, "when", when)
	}
	if len(res.Killed) > 0 {
		var pids []string
		for _, p := range res.Killed {
			pids = append(pids, itoa(p))
		}
		g.log.Event("event", "leftovers", "status", "killed", "pids", strings.Join(pids, " "), "cells", g.cfg.CellsAccount, "when", when)
	}
}

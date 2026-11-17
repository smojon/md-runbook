//go:build unix

package gate

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/logx"
	"github.com/smojon/md-runbook/apps/gate/internal/report"
)

var testPlan = plan{exe: "/usr/local/bin/md-runbook-gate", sudo: "/usr/bin/sudo", systemdRun: "/usr/bin/systemd-run", bwrap: "/usr/bin/bwrap", runtimeDir: "/run/user/1000"}

func decodeHeader(t *testing.T, h []byte) cellsReq {
	t.Helper()
	r := bytes.NewReader(h)
	req, err := readCellsReq(r)
	if err != nil {
		t.Fatalf("header %q: %v", h, err)
	}
	if r.Len() != 0 {
		t.Errorf("header: %d bytes after the request", r.Len())
	}
	return req
}

// The command lines the gate starts its shells with, for each isolation and mode.
func TestShellLaunch(t *testing.T) {
	cells := []string{"/usr/bin/bash", "--noprofile", "--norc"}
	env := []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	unit := "md-runbook-gate-ab12cd-1.scope"
	scope := []string{"/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--collect", "--unit=" + unit, "--description=md-runbook-gate cells", "--"}
	sudo := []string{"/usr/bin/sudo", "-n", "-u", "mdrb-cells", "--"}
	self := []string{"/usr/local/bin/md-runbook-gate", "__cells"}
	bw := []string{"/usr/bin/bwrap", "--die-with-parent", "--new-session", "--unshare-pid", "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--"}
	wrapEnv := []string{"PATH=" + sysPath, "LC_ALL=C"}
	scopeEnv := append(append([]string{}, wrapEnv...), "XDG_RUNTIME_DIR=/run/user/1000")
	cat := func(parts ...[]string) []string {
		var out []string
		for _, p := range parts {
			out = append(out, p...)
		}
		return out
	}
	for _, c := range []struct {
		iso, account string
		argv, env    []string
		inner        []string // the header's argv; nil: no header
		dir          string
	}{
		{"none", "", cells, env, nil, ""},
		{"scope", "", cat(scope, self), scopeEnv, cells, ""},
		{"bwrap", "", self, wrapEnv, cat(bw, cells), ""},
		{"none", "mdrb-cells", cat(sudo, self), wrapEnv, cells, "/home/mdrb-cells"},
		{"scope", "mdrb-cells", cat(scope, sudo, self), scopeEnv, cells, "/home/mdrb-cells"},
		{"bwrap", "mdrb-cells", cat(sudo, self), wrapEnv, cat(bw, cells), "/home/mdrb-cells"},
	} {
		p := testPlan
		p.iso, p.account = c.iso, c.account
		l := p.shell(cells, env, c.dir, unit)
		if !reflect.DeepEqual(l.argv, c.argv) || !reflect.DeepEqual(l.env, c.env) {
			t.Errorf("%s/%q: argv %q env %q", c.iso, c.account, l.argv, l.env)
		}
		if c.inner == nil {
			if l.header != nil {
				t.Errorf("%s/%q: a header", c.iso, c.account)
			}
			continue
		}
		req := decodeHeader(t, l.header)
		if req.Op != "exec" || !reflect.DeepEqual(req.Argv, c.inner) || !reflect.DeepEqual(req.Env, env) || req.Dir != c.dir {
			t.Errorf("%s/%q: request %+v", c.iso, c.account, req)
		}
		// Separated mode: no_new_privs (review of 0.30.0, H1); bwrap sets it itself.
		if want := c.account != "" && c.iso != "bwrap"; req.NoNewPrivs != want {
			t.Errorf("%s/%q: no_new_privs %v, want %v", c.iso, c.account, req.NoNewPrivs, want)
		}
	}
}

// auto never falls back to bwrap (it takes sudo and setuid programs from the blocks): scope, else
// none. bwrap only when named.
func TestIsolationsToTry(t *testing.T) {
	for want, try := range map[string][]string{"auto": {"scope"}, "scope": {"scope"}, "bwrap": {"bwrap"}, "none": nil} {
		if got := isolationsToTry(want); !reflect.DeepEqual(got, try) {
			t.Errorf("isolationsToTry(%q) = %q, want %q", want, got, try)
		}
	}
}

// A helper whose child holds its output and is stopped (as a process of the cells' account can
// stop the cells' mode under sudo): runFor still returns, at its limit plus waitDelay (review of
// 0.28.0).
func TestRunForStoppedChild(t *testing.T) {
	pidFile := t.TempDir() + "/child.pid"
	t0 := time.Now()
	_, err := runFor(time.Second, []string{"/bin/sh", "-c", `/bin/sh -c 'echo $$ >"$0"; kill -STOP $$; echo late' "$0" & wait`, pidFile}, nil, nil)
	took := time.Since(t0)
	if b, rerr := os.ReadFile(pidFile); rerr == nil {
		if pid, perr := strconv.Atoi(strings.TrimSpace(string(b))); perr == nil {
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	if err == nil || took > time.Second+waitDelay+2*time.Second {
		t.Errorf("runFor: %v after %s", err, took)
	}
}

// The programs the gate runs: from sysPath only, each file and every folder above it root's and
// writable by root alone; the gate account owning one is not enough (review of 0.28.0, H1).
func TestHelpers(t *testing.T) {
	var asked []string
	h := findHelpers(func(path, name string) string {
		asked = append(asked, path)
		if name == "bwrap" {
			return ""
		}
		return "/usr/bin/" + name
	})
	for _, p := range asked {
		if p != "/usr/bin:/bin:/usr/sbin:/sbin" {
			t.Errorf("looked in %s", p)
		}
	}
	if h["ssh-keygen"] != "/usr/bin/ssh-keygen" || h["bwrap"] != "" || len(h) != len(helperNames) {
		t.Errorf("helpers: %v", h)
	}
	root := func(perm os.FileMode) pathInfo { return pathInfo{perm: perm} }
	sys := func() fakeFS {
		fs := fakeFS{"/": root(0o755), "/usr": root(0o755), "/usr/bin": root(0o755), "/bin": {perm: 0o777, link: "usr/bin"}}
		for _, n := range helperNames {
			fs["/usr/bin/"+n] = root(0o755)
		}
		return fs
	}
	if p := helperProblems(h, sys().stat, -1); len(p) != 0 {
		t.Errorf("root's: %q", p)
	}
	// In a user namespace that doesn't map root, root's files show as the overflow uid: accepted
	// there, and only there.
	outside := sys()
	for p, i := range outside {
		i.uid = 65534
		outside[p] = i
	}
	if p := helperProblems(h, outside.stat, 65534); len(p) != 0 {
		t.Errorf("in a user namespace: %q", p)
	}
	if p := helperProblems(h, outside.stat, -1); len(p) == 0 {
		t.Error("the overflow uid outside a user namespace")
	}
	for name, c := range map[string]struct {
		change func(fs fakeFS)
		want   string
	}{
		"group may write the folder":    {func(fs fakeFS) { fs["/usr/bin"] = root(0o775) }, "ssh-keygen (/usr/bin/ssh-keygen): /usr/bin, a folder above /usr/bin/ssh-keygen, is writable by anyone but root"},
		"the gate's account owns /usr":  {func(fs fakeFS) { fs["/usr"] = pathInfo{uid: 1000, perm: 0o755} }, "/usr, a folder above /usr/bin/sudo, is owned by uid 1000: make root its owner"},
		"anyone may write the file":     {func(fs fakeFS) { fs["/usr/bin/ssh-keygen"] = root(0o757) }, "ssh-keygen (/usr/bin/ssh-keygen): /usr/bin/ssh-keygen is writable by anyone but root"},
		"another account owns the file": {func(fs fakeFS) { fs["/usr/bin/sudo"] = pathInfo{uid: 1000, perm: 0o755} }, "sudo (/usr/bin/sudo): /usr/bin/sudo is owned by uid 1000"},
		"a link out to an open folder": {func(fs fakeFS) {
			fs["/usr/bin/id"] = pathInfo{perm: 0o777, link: "/srv/id"}
			fs["/srv"] = root(0o777)
			fs["/srv/id"] = root(0o755)
		}, "id (/usr/bin/id): /srv, a folder above /srv/id, is writable by anyone but root"},
	} {
		fs := sys()
		c.change(fs)
		got := strings.Join(helperProblems(h, fs.stat, -1), "\n")
		if !strings.Contains(got, c.want) {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
}

func TestSudoRule(t *testing.T) {
	if got := sudoRule("support", []string{"mdrb-cells"}, testPlan.exe); got != "support ALL=(mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate __cells" {
		t.Errorf("rule: %s", got)
	}
	pool := []string{"mdrb-cells-1", "mdrb-cells-2", "mdrb-cells-3", "mdrb-cells-4"}
	if got := sudoRule("support", pool, testPlan.exe); got != "support ALL=(mdrb-cells-1,mdrb-cells-2,mdrb-cells-3,mdrb-cells-4) NOPASSWD: /usr/local/bin/md-runbook-gate __cells" {
		t.Errorf("pool rule: %s", got)
	}
}

// The request reader takes exactly the request: what follows is the shell's.
func TestCellsReqFraming(t *testing.T) {
	req := cellsReq{Op: "kill", Sig: 15, Targets: []int{-42, 43}}
	r := bytes.NewReader(append(req.encode(), "echo cells\n"...))
	got, err := readCellsReq(r)
	if err != nil || !reflect.DeepEqual(got, req) {
		t.Fatalf("read: %+v %v", got, err)
	}
	if rest, _ := io.ReadAll(r); string(rest) != "echo cells\n" {
		t.Errorf("rest: %q", rest)
	}
	for _, bad := range []string{"", "x\n", "mdrb-cells 0\n", "mdrb-cells -1\n{}", "mdrb-cells 9999999\n", "mdrb-cells 5\n{}", "mdrb-cells 2\n[]", strings.Repeat("a", 40) + "\n"} {
		if _, err := readCellsReq(strings.NewReader(bad)); err == nil {
			t.Errorf("%q: read", bad)
		}
	}
}

// What `sudo -n -l` prints (sudo 1.9).
const sudoHead = "Matching Defaults entries for support on web-1:\n    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin, use_pty\n\nUser support may run the following commands on web-1:\n"

func TestSudoProblem(t *testing.T) {
	exe := "/usr/local/bin/md-runbook-gate"
	one := []string{"mdrb-cells"}
	good := sudoHead + "    (mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n"
	if p := sudoProblem(good, one, exe); p != "" {
		t.Errorf("exact rule: %s", p)
	}
	if p := sudoProblem(strings.ReplaceAll(good, "\n", "\r\n"), one, exe); p != "" {
		t.Errorf("CRLF: %s", p)
	}
	// A pool: the whole pool as one runas list, in any order, as sudo prints it (", ").
	pool := []string{"mdrb-cells-1", "mdrb-cells-2", "mdrb-cells-3", "mdrb-cells-4"}
	rule := func(runas string) string {
		return sudoHead + "    (" + runas + ") NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n"
	}
	for _, runas := range []string{"mdrb-cells-1, mdrb-cells-2, mdrb-cells-3, mdrb-cells-4", "mdrb-cells-4, mdrb-cells-2, mdrb-cells-1, mdrb-cells-3", "mdrb-cells-1,mdrb-cells-2,mdrb-cells-3,mdrb-cells-4"} {
		if p := sudoProblem(rule(runas), pool, exe); p != "" {
			t.Errorf("pool (%s): %s", runas, p)
		}
	}
	for name, out := range map[string]string{
		"one missing":        rule("mdrb-cells-1, mdrb-cells-2, mdrb-cells-3"),
		"one more":           rule("mdrb-cells-1, mdrb-cells-2, mdrb-cells-3, mdrb-cells-4, mdrb-cells-5"),
		"and ALL":            rule("mdrb-cells-1, mdrb-cells-2, mdrb-cells-3, mdrb-cells-4, ALL"),
		"and root":           rule("mdrb-cells-1, mdrb-cells-2, mdrb-cells-3, mdrb-cells-4, root"),
		"negation":           rule("ALL, !root"),
		"a group":            rule("mdrb-cells-1, mdrb-cells-2, mdrb-cells-3, mdrb-cells-4 : ALL"),
		"empty":              rule(""),
		"a line per account": rule("mdrb-cells-1, mdrb-cells-2") + "    (mdrb-cells-3, mdrb-cells-4) NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n",
		"another command":    sudoHead + "    (mdrb-cells-1, mdrb-cells-2, mdrb-cells-3, mdrb-cells-4) NOPASSWD: /usr/local/bin/md-runbook-gate __cells, (root) /bin/sh\n",
	} {
		if p := sudoProblem(out, pool, exe); p == "" {
			t.Errorf("pool, %s: accepted", name)
		}
	}
	// A pool of one takes no other account's line.
	if p := sudoProblem(rule("mdrb-cells-1"), one, exe); p == "" {
		t.Error("another account: accepted")
	}
	for name, out := range map[string]string{
		"none":          "Sorry, user support may not run sudo on web-1.\n",
		"all commands":  sudoHead + "    (mdrb-cells) NOPASSWD: ALL\n",
		"root too":      good + "    (ALL : ALL) ALL\n",
		"any runas":     sudoHead + "    (ALL) NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n",
		"another cmd":   sudoHead + "    (mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate __cells, /bin/sh\n",
		"any args":      sudoHead + "    (mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate\n",
		"setenv":        sudoHead + "    (mdrb-cells) NOPASSWD: SETENV: /usr/local/bin/md-runbook-gate __cells\n",
		"password":      sudoHead + "    (mdrb-cells) /usr/local/bin/md-runbook-gate __cells\n",
		"other program": sudoHead + "    (mdrb-cells) NOPASSWD: /tmp/md-runbook-gate __cells\n",
		"group too":     sudoHead + "    (mdrb-cells : ALL) NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n",
	} {
		if p := sudoProblem(out, one, exe); p == "" {
			t.Errorf("%s: accepted", name)
		}
	}
}

// A fake system for the self-check: the programs it runs and what they answer.
type fakeSys struct {
	idOut, groups, home, sudoL string
	groupNames                 string
	cronFiles                  map[string]string
	idErr, sudoErr             error
	check                      checkResult
	checkErr                   error
	checkHome                  string // the home folder the last check request named
	calls                      [][]string
	files                      fakeFS
	// Accounts of a pool other than mdrb-cells: their uid (id -u), and what their check answers
	// (else check, with their uid).
	uids   map[string]string
	checks map[string]checkResult
}

// fakeFS: owners and modes by path (no links).
type fakeFS map[string]pathInfo

func (fs fakeFS) stat(p string) (pathInfo, error) {
	if i, ok := fs[p]; ok {
		return i, nil
	}
	return pathInfo{}, errors.New("no such file")
}

// A system: root's folders, a sticky /tmp, and the gate's account (1000)'s folder in it.
func goodFS() fakeFS {
	root := func(perm os.FileMode) pathInfo { return pathInfo{uid: 0, gid: 0, perm: perm} }
	return fakeFS{
		"/": root(0o755), "/usr": root(0o755), "/usr/local": root(0o755), "/usr/local/bin": root(0o755),
		"/usr/local/bin/md-runbook-gate": root(0o755), "/etc": root(0o755), "/etc/md-runbook": root(0o755),
		"/etc/md-runbook/gate.conf": root(0o644), "/tmp": {uid: 0, gid: 0, perm: 0o777, sticky: true},
		"/tmp/mdrb.x": {uid: 1000, gid: 1000, perm: 0o700}, "/tmp/mdrb.x/report-token": {uid: 1000, gid: 1000, perm: 0o600},
	}
}

func (f *fakeSys) run(argv, env []string, stdin []byte) ([]byte, error) {
	f.calls = append(f.calls, argv)
	switch {
	case argv[0] == "id" && argv[1] == "-Gn":
		return []byte(f.groupNames), nil
	case argv[0] == "id" && argv[1] == "-G":
		return []byte(f.groups), nil
	case argv[0] == "id":
		if u, ok := f.uids[argv[2]]; ok {
			return []byte(u + "\n"), nil
		}
		return []byte(f.idOut), f.idErr
	case argv[0] == "/bin/sh":
		return []byte(f.home), nil
	case reflect.DeepEqual(argv, []string{"/usr/bin/sudo", "-n", "-l"}):
		return []byte(f.sudoL), f.sudoErr
	case len(argv) == 7 && reflect.DeepEqual(argv[:3], []string{"/usr/bin/sudo", "-n", "-u"}) && reflect.DeepEqual(argv[4:], []string{"--", "/usr/local/bin/md-runbook-gate", "__cells"}):
		name := argv[3]
		res, ok := f.checks[name]
		if !ok {
			res = f.check
			if u, in := f.uids[name]; in {
				res.UID, _ = strconv.Atoi(u)
			} else if name != "mdrb-cells" {
				return nil, errors.New("exit status 1: sudo: a password is required")
			}
		}
		req, err := readCellsReq(bytes.NewReader(stdin))
		if err != nil || req.Op != "check" {
			return nil, errors.New("bad request")
		}
		f.checkHome = req.Home
		data, _ := json.Marshal(res)
		return data, f.checkErr
	}
	return nil, errors.New("unexpected " + strings.Join(argv, " "))
}

func goodSys() *fakeSys {
	return &fakeSys{
		idOut: "1500\n", groups: "1500 27\n", groupNames: "mdrb-cells users\n", home: "/home/mdrb-cells",
		sudoL:     sudoHead + "    (mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n",
		check:     checkResult{UID: 1500, Read: []string{}, Write: []string{"/tmp/md-runbook-gate.x/exits.y"}},
		files:     goodFS(),
		cronFiles: map[string]string{"/etc/cron.deny": "daemon\nmdrb-cells\n", "/etc/at.allow": "root\n"},
	}
}

// check: the self-check of a pool of one, then the check of its cells' mode (as when leased).
func check(f *fakeSys) (cellsInfo, error) {
	c := testCheck(f, "cells_account", "mdrb-cells")
	infos, err := c.do()
	if err != nil || len(infos) != 1 {
		return cellsInfo{}, err
	}
	return infos[0], c.access(infos[0])
}

func checkPool(f *fakeSys, key string, pool ...string) ([]cellsInfo, error) {
	return testCheck(f, key, pool...).do()
}

func testCheck(f *fakeSys, key string, pool ...string) selfCheck {
	return selfCheck{
		run: f.run, plan: testPlan, pool: pool, key: key, sh: "/bin/sh", id: "id", gateAccount: "support", gateUID: 1000,
		noRead:    []string{"/etc/md-runbook/report-token", "/var/log/md-runbook-gate.log"},
		noWrite:   []string{"/usr/local/bin/md-runbook-gate", "/etc/md-runbook/gate.conf"},
		mustWrite: []string{"/tmp/md-runbook-gate.x/exits.y"},
		safe:      []string{"/usr/local/bin/md-runbook-gate", "/etc/md-runbook/gate.conf", "/tmp/mdrb.x/report-token"},
		stat:      f.files.stat,
		cron:      cronSetup{dir: "/etc", crontab: true, at: true, read: f.readCron},
	}
}

func TestSelfCheck(t *testing.T) {
	f := goodSys()
	info, err := check(f)
	if err != nil || info.uid != 1500 || info.home != "/home/mdrb-cells" {
		t.Fatalf("good: %+v %v", info, err)
	}
	if len(f.calls) != 6 {
		t.Errorf("calls: %q", f.calls)
	}
	// The cells' mode looks at the account's home (checkHome).
	if f.checkHome != "/home/mdrb-cells" {
		t.Errorf("check of the home: %q", f.checkHome)
	}
	rule := "support ALL=(mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate __cells"
	for name, c := range map[string]struct {
		change func(f *fakeSys)
		want   []string
	}{
		"no account":       {func(f *fakeSys) { f.idOut, f.idErr = "", errors.New("exit status 1") }, []string{"no such account"}},
		"privileged group": {func(f *fakeSys) { f.groupNames = "mdrb-cells docker sudo" }, []string{"mdrb-cells is in the group docker, sudo: give the cells an account without privileged groups"}},
		"gid 0":            {func(f *fakeSys) { f.groups = "1500 0" }, []string{"is in the group gid 0"}},
		"may use cron":     {func(f *fakeSys) { delete(f.cronFiles, "/etc/cron.deny") }, []string{"mdrb-cells may use cron: add it to /etc/cron.deny (or create /etc/cron.allow without it)"}},
		"open folder":      {func(f *fakeSys) { f.files["/etc/md-runbook"] = pathInfo{perm: 0o777} }, []string{"/etc/md-runbook, a folder above /etc/md-runbook/gate.conf, is writable by mdrb-cells"}},
		"root":             {func(f *fakeSys) { f.idOut = "0\n" }, []string{"is root"}},
		"the gate's own":   {func(f *fakeSys) { f.idOut = "1000\n" }, []string{"the gate's own account"}},
		"no rule": {func(f *fakeSys) {
			f.sudoL, f.sudoErr = "Sorry, user support may not run sudo on web-1.\n", errors.New("exit status 1")
		}, []string{"lists no rule", rule}},
		"too wide":         {func(f *fakeSys) { f.sudoL += "    (ALL : ALL) NOPASSWD: ALL\n" }, []string{"not exactly the one rule", "(ALL : ALL) NOPASSWD: ALL", rule}},
		"all as cells":     {func(f *fakeSys) { f.sudoL = sudoHead + "    (mdrb-cells) NOPASSWD: ALL\n" }, []string{"not exactly the one rule", rule}},
		"sudo fails":       {func(f *fakeSys) { f.checkErr = errors.New("exit status 1: sudo: a password is required") }, []string{"can't run the cells' mode", "a password is required", rule}},
		"another uid":      {func(f *fakeSys) { f.check.UID = 1501 }, []string{"as uid 1501, not 1500"}},
		"readable token":   {func(f *fakeSys) { f.check.Read = []string{"/etc/md-runbook/report-token"} }, []string{"can read /etc/md-runbook/report-token"}},
		"readable log":     {func(f *fakeSys) { f.check.Read = []string{"/var/log/md-runbook-gate.log"} }, []string{"can read /var/log/md-runbook-gate.log"}},
		"writable program": {func(f *fakeSys) { f.check.Write = append(f.check.Write, "/usr/local/bin/md-runbook-gate") }, []string{"can change /usr/local/bin/md-runbook-gate"}},
		"no exits file":    {func(f *fakeSys) { f.check.Write = []string{} }, []string{"can't append to /tmp/md-runbook-gate.x/exits.y"}},
		"open home":        {func(f *fakeSys) { f.check.HomeOpen = true }, []string{"mdrb-cells's home /home/mdrb-cells is open to other accounts", "mode 0700"}},
		"a login key":      {func(f *fakeSys) { f.check.Logins = []string{"/home/mdrb-cells/.ssh/authorized_keys"} }, []string{"/home/mdrb-cells/.ssh/authorized_keys would let a key log in as mdrb-cells", "DenyUsers mdrb-cells"}},
	} {
		f := goodSys()
		c.change(f)
		_, err := check(f)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		for _, w := range c.want {
			if !strings.Contains(err.Error(), w) {
				t.Errorf("%s: %q lacks %q", name, err, w)
			}
		}
	}
	// A wrong rule stops before the cells' mode runs.
	f = goodSys()
	f.sudoL += "    (ALL) ALL\n"
	check(f)
	for _, c := range f.calls {
		if len(c) > 2 && c[2] == "-u" {
			t.Errorf("ran the cells' mode under a wrong rule: %q", c)
		}
	}
	// Without a home folder the cells start in /.
	f = goodSys()
	f.home = "~mdrb-cells"
	if info, err := check(f); err != nil || info.home != "" {
		t.Errorf("no home: %+v %v", info, err)
	}
}

// A pool: every account is checked, the sudo line names them all, and two names of one uid are
// one account.
func TestSelfCheckPool(t *testing.T) {
	pool := []string{"mdrb-cells", "mdrb-cells-2", "mdrb-cells-3"}
	sys := func() *fakeSys {
		f := goodSys()
		f.uids = map[string]string{"mdrb-cells-2": "1502", "mdrb-cells-3": "1503"}
		f.cronFiles["/etc/cron.deny"] = "daemon\nmdrb-cells\nmdrb-cells-2\nmdrb-cells-3\n"
		f.sudoL = sudoHead + "    (mdrb-cells-3, mdrb-cells, mdrb-cells-2) NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n"
		return f
	}
	f := sys()
	infos, err := checkPool(f, "cells_accounts", pool...)
	if err != nil || len(infos) != 3 {
		t.Fatalf("good: %+v %v", infos, err)
	}
	for i, want := range []cellsInfo{{name: "mdrb-cells", uid: 1500}, {name: "mdrb-cells-2", uid: 1502}, {name: "mdrb-cells-3", uid: 1503}} {
		if infos[i].name != want.name || infos[i].uid != want.uid || !infos[i].groups[27] {
			t.Errorf("account %d: %+v", i, infos[i])
		}
	}
	// 4 for each account (id -u, -G, -Gn, its home), sudo -l; nothing as an account of the pool.
	if len(f.calls) != 4*3+1 {
		t.Errorf("calls: %d %q", len(f.calls), f.calls)
	}
	asAccount := func(calls [][]string) []string {
		var out []string
		for _, c := range calls {
			if len(c) > 3 && c[0] == "/usr/bin/sudo" && c[2] == "-u" {
				out = append(out, c[3])
			}
		}
		return out
	}
	if got := asAccount(f.calls); len(got) != 0 {
		t.Errorf("ran as %q before any lease", got)
	}
	// The cells' mode's check runs as the leased account only (review of 0.30.0, H2: another
	// session's blocks run as the others).
	c := testCheck(f, "cells_accounts", pool...)
	f.calls = nil
	if err := c.access(infos[1]); err != nil {
		t.Fatalf("access: %v", err)
	}
	if got := asAccount(f.calls); !reflect.DeepEqual(got, []string{"mdrb-cells-2"}) || len(f.calls) != 1 {
		t.Errorf("access as mdrb-cells-2 ran %q", f.calls)
	}
	// Its findings: for that account.
	f = sys()
	f.checks = map[string]checkResult{"mdrb-cells-3": {UID: 1503, Read: []string{"/etc/md-runbook/report-token"}, Write: []string{"/tmp/md-runbook-gate.x/exits.y"}}}
	c = testCheck(f, "cells_accounts", pool...)
	if infos, err = c.do(); err != nil {
		t.Fatalf("do: %v", err)
	}
	if err := c.access(infos[0]); err != nil {
		t.Errorf("another account's finding: %v", err)
	}
	if err := c.access(infos[2]); err == nil || !strings.Contains(err.Error(), "cells_accounts: mdrb-cells-3: mdrb-cells-3 can read /etc/md-runbook/report-token") {
		t.Errorf("one reads the token: %v", err)
	}
	rule := "support ALL=(mdrb-cells,mdrb-cells-2,mdrb-cells-3) NOPASSWD: /usr/local/bin/md-runbook-gate __cells"
	for name, c := range map[string]struct {
		change func(f *fakeSys)
		want   []string
	}{
		"same uid":      {func(f *fakeSys) { f.uids["mdrb-cells-3"] = "1502" }, []string{"cells_accounts: mdrb-cells-2 and mdrb-cells-3 are the same account (uid 1502)"}},
		"one is root":   {func(f *fakeSys) { f.uids["mdrb-cells-2"] = "0" }, []string{"cells_accounts: mdrb-cells-2 is root"}},
		"one is gate's": {func(f *fakeSys) { f.uids["mdrb-cells-3"] = "1000" }, []string{"cells_accounts: mdrb-cells-3 is the gate's own account"}},
		"one not named": {func(f *fakeSys) {
			f.sudoL = sudoHead + "    (mdrb-cells, mdrb-cells-2) NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n"
		}, []string{"not exactly the one rule", rule}},
		"old line":       {func(f *fakeSys) { f.sudoL = goodSys().sudoL }, []string{"not exactly the one rule", rule}},
		"one may use at": {func(f *fakeSys) { f.cronFiles["/etc/at.allow"] = "root\nmdrb-cells-2\n" }, []string{"cells_accounts: mdrb-cells-2: /etc/at.allow lists mdrb-cells-2"}},
		"one in a group": {func(f *fakeSys) { f.groupNames = "users docker" }, []string{"cells_accounts: mdrb-cells is in the group docker"}},
	} {
		f := sys()
		c.change(f)
		_, err := checkPool(f, "cells_accounts", pool...)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		for _, w := range c.want {
			if !strings.Contains(err.Error(), w) {
				t.Errorf("%s: %q lacks %q", name, err, w)
			}
		}
	}
}

// The safe-path rule (OpenSSH's StrictModes): each folder up to / root's or the gate account's
// (1000), not writable by the cells' account (1500, in groups 1500 and 27), except a sticky one
// whose entry below is root's or the gate account's.
func TestSafePathProblem(t *testing.T) {
	groups := map[int]bool{1500: true, 27: true}
	for name, c := range map[string]struct {
		change func(fs fakeFS)
		path   string
		want   string // "" accepted, else a part of the message
	}{
		"all root's":                {nil, "/etc/md-runbook/gate.conf", ""},
		"open parent":               {func(fs fakeFS) { fs["/etc/md-runbook"] = pathInfo{perm: 0o777} }, "/etc/md-runbook/gate.conf", "/etc/md-runbook, a folder above /etc/md-runbook/gate.conf, is writable by mdrb-cells"},
		"open grandparent":          {func(fs fakeFS) { fs["/etc"] = pathInfo{perm: 0o757} }, "/etc/md-runbook/gate.conf", "/etc, a folder above /etc/md-runbook/gate.conf, is writable by mdrb-cells"},
		"parent of another account": {func(fs fakeFS) { fs["/etc/md-runbook"] = pathInfo{uid: 1234, perm: 0o755} }, "/etc/md-runbook/gate.conf", "is owned by uid 1234"},
		"parent of the gate's":      {func(fs fakeFS) { fs["/etc/md-runbook"] = pathInfo{uid: 1000, gid: 1000, perm: 0o755} }, "/etc/md-runbook/gate.conf", ""},
		"cells' group may write":    {func(fs fakeFS) { fs["/etc/md-runbook"] = pathInfo{gid: 27, perm: 0o775} }, "/etc/md-runbook/gate.conf", "/etc/md-runbook, a folder above /etc/md-runbook/gate.conf, is writable by mdrb-cells"},
		"another group may write":   {func(fs fakeFS) { fs["/etc/md-runbook"] = pathInfo{gid: 4, perm: 0o775} }, "/etc/md-runbook/gate.conf", ""},
		"sticky /tmp, gate's child": {nil, "/tmp/mdrb.x/report-token", ""},
		"sticky /tmp, root's child": {func(fs fakeFS) { fs["/tmp/mdrb.x"] = pathInfo{perm: 0o755} }, "/tmp/mdrb.x/report-token", ""},
		"sticky /tmp, another's child": {func(fs fakeFS) { fs["/tmp/mdrb.x"] = pathInfo{uid: 1500, gid: 1500, perm: 0o700} }, "/tmp/mdrb.x/report-token",
			"/tmp/mdrb.x, a folder above /tmp/mdrb.x/report-token, is owned by uid 1500"},
		"sticky /tmp, file in it of another": {func(fs fakeFS) { fs["/tmp/token"] = pathInfo{uid: 1234, perm: 0o600} }, "/tmp/token", "/tmp/token is owned by uid 1234 in /tmp"},
		"sticky /tmp, file not there yet":    {nil, "/tmp/token", "/tmp/token doesn't exist in /tmp"},
		"open but not sticky /tmp":           {func(fs fakeFS) { fs["/tmp"] = pathInfo{perm: 0o777} }, "/tmp/mdrb.x/report-token", "/tmp, a folder above /tmp/mdrb.x/report-token, is writable by mdrb-cells"},
		"a file not there yet, safe folder":  {nil, "/etc/md-runbook/revoked", ""},
		"a folder not there":                 {nil, "/etc/nowhere/revoked", "the folder of /etc/nowhere/revoked doesn't exist"},
		// Links: the path as written and every target (review of 0.28.0).
		"a link in an open folder to a safe file": {func(fs fakeFS) {
			fs["/srv"] = pathInfo{perm: 0o777}
			fs["/srv/allowed_signers"] = pathInfo{perm: 0o777, link: "/etc/md-runbook/gate.conf"}
		}, "/srv/allowed_signers", "/srv, a folder above /srv/allowed_signers, is writable by mdrb-cells"},
		"a safe link to a file in an open folder": {func(fs fakeFS) {
			fs["/srv"] = pathInfo{perm: 0o777}
			fs["/srv/allowed_signers"] = pathInfo{perm: 0o644}
			fs["/etc/md-runbook/allowed_signers"] = pathInfo{perm: 0o777, link: "../../srv/allowed_signers"}
		}, "/etc/md-runbook/allowed_signers", "/srv, a folder above /srv/allowed_signers, is writable by mdrb-cells"},
		"a linked folder (merged /usr), safe": {func(fs fakeFS) {
			fs["/bin"] = pathInfo{perm: 0o777, link: "usr/bin"}
			fs["/usr/bin"] = pathInfo{perm: 0o755}
			fs["/usr/bin/id"] = pathInfo{perm: 0o755}
		}, "/bin/id", ""},
		"a linked folder pointing into an open one": {func(fs fakeFS) {
			fs["/srv"] = pathInfo{perm: 0o777}
			fs["/srv/conf"] = pathInfo{perm: 0o755}
			fs["/etc/md-runbook"] = pathInfo{perm: 0o777, link: "/srv/conf"}
		}, "/etc/md-runbook/gate.conf", "/srv, a folder above /srv/conf/gate.conf, is writable by mdrb-cells"},
		"a link loop": {func(fs fakeFS) {
			fs["/etc/a"] = pathInfo{perm: 0o777, link: "b"}
			fs["/etc/b"] = pathInfo{perm: 0o777, link: "a"}
		}, "/etc/a", ""},
	} {
		fs := goodFS()
		if c.change != nil {
			c.change(fs)
		}
		got := safePathProblem(c.path, fs.stat, cellsRule(1000, 1500, groups, "support", "mdrb-cells"))
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
}

// Separated mode: the gate reads the exits the cells' shells append and logs the end events.
// Anything else in the file (review of 0.28.0, M1) ends the session, logged, and no report goes
// out.
func TestExitsFile(t *testing.T) {
	newGate := func(t *testing.T) (*Gate, string, func(string, int)) {
		dir := t.TempDir()
		g := &Gate{log: &logx.Logger{Dest: dir + "/gate.log", Account: "support"}}
		g.endCh = make(chan struct{}, 1)
		g.exitsPath = dir + "/exits"
		g.sepRuns = map[string]sepRun{"1": {"0000aa01", "n1"}, "2": {"0000aa02", "n2"}, "3": {"0000aa03", "n3"}}
		g.sepExits = map[string]report.Exit{}
		write := func(s string, flag int) {
			f, err := os.OpenFile(g.exitsPath, flag, 0o600)
			if err != nil {
				t.Fatal(err)
			}
			f.WriteString(s)
			f.Close()
		}
		return g, dir, write
	}
	g, dir, write := newGate(t)
	write("1\t0\t2026-11-16T10:00:01Z\tn1\t\n2\t3\tnot a time\tn2\tkube-context is none, not prod\n3\t7", os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
	g.readExitsFile()
	// The rest of run 3's line comes later.
	write("\t2026-11-16T10:00:05Z\tn3\t\n", os.O_WRONLY|os.O_APPEND)
	g.readExitsFile()
	ex := g.sepExitsCopy()
	if g.exitsBadNow() != "" || ex["1"] != (report.Exit{RC: "0", Time: "2026-11-16T10:00:01Z"}) || ex["2"].RC != "3" || ex["2"].Time == "not a time" || ex["3"] != (report.Exit{RC: "7", Time: "2026-11-16T10:00:05Z"}) || len(ex) != 3 {
		t.Errorf("exits: %+v (%s)", ex, g.exitsBadNow())
	}
	data, _ := os.ReadFile(dir + "/gate.log")
	log := string(data)
	for _, want := range []string{`"event":"end","id":"0000aa01","exit":0}`, `"event":"end","id":"0000aa02","exit":3}`, `"event":"end","id":"0000aa03","exit":7}`,
		`"event":"refused","id":"0000aa02","reason":"kube-context is none, not prod"}`} {
		if !strings.Contains(log, want) {
			t.Errorf("log lacks %s:\n%s", want, log)
		}
	}
	select {
	case <-g.endCh:
		t.Error("the session ended")
	default:
	}
	for name, c := range map[string]struct {
		lines string
		then  func(write func(string, int))
		want  string
	}{
		"a forged random number": {"1\t0\t2026-11-16T10:00:01Z\tforged\t\n", nil, "a line for run 1 without its random number"},
		"no such run":            {"9\t0\t2026-11-16T10:00:01Z\tn1\t\n", nil, "a line for no run of this session"},
		"a second line":          {"1\t0\t2026-11-16T10:00:01Z\tn1\t\n1\t1\t2026-11-16T10:00:02Z\tn1\t\n", nil, "a second line for run 1"},
		"junk":                   {"hello\n", nil, "a line that doesn't parse"},
		"no number":              {"1\tx\t2026-11-16T10:00:01Z\tn1\t\n", nil, "an exit that is no number"},
		"a long line":            {strings.Repeat("x", 5000), nil, "a line is over 4096 bytes"},
		"truncated":              {"1\t0\t2026-11-16T10:00:01Z\tn1\t\n", func(write func(string, int)) { write("", os.O_WRONLY|os.O_TRUNC) }, "it got shorter"},
	} {
		g, dir, write := newGate(t)
		write(c.lines, os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
		g.readExitsFile()
		if c.then != nil {
			c.then(write)
			g.readExitsFile()
		}
		if !strings.Contains(g.exitsBadNow(), c.want) {
			t.Errorf("%s: %q, want %q", name, g.exitsBadNow(), c.want)
		}
		select {
		case <-g.endCh:
		default:
			t.Errorf("%s: the session goes on", name)
		}
		data, _ := os.ReadFile(dir + "/gate.log")
		if !strings.Contains(string(data), `"event":"exits","status":"refused","reason":"the session's exits file was changed (`+c.want) {
			t.Errorf("%s: log %s", name, data)
		}
	}
	for s, ok := range map[string]bool{"2026-11-16T10:00:01Z": true, "2026-11-16 10:00:01Z": false, "2026-11-16T10:00:01": false, "2026-1a-16T10:00:01Z": false} {
		if isUTCTime(s) != ok {
			t.Errorf("isUTCTime(%q) != %v", s, ok)
		}
	}
}

func (f *fakeSys) readCron(p string) ([]byte, error) {
	if c, ok := f.cronFiles[p]; ok {
		if c == "unreadable" {
			return nil, fs.ErrPermission
		}
		return []byte(c), nil
	}
	return nil, fs.ErrNotExist
}

// Cron and at: the cells' account may not use them (deny lists it, or allow exists without it);
// a file the gate can't read is a problem; a tool that isn't installed is none (review of 0.28.0).
func TestCronProblems(t *testing.T) {
	for name, c := range map[string]struct {
		files       map[string]string
		crontab, at bool
		want        string // "" none, else part of the problems
	}{
		"denied in both":         {map[string]string{"/etc/cron.deny": "mdrb-cells", "/etc/at.deny": " mdrb-cells \nx"}, true, true, ""},
		"allow lists others":     {map[string]string{"/etc/cron.allow": "root\n", "/etc/at.allow": ""}, true, true, ""},
		"allow beats deny":       {map[string]string{"/etc/cron.allow": "root", "/etc/cron.deny": ""}, true, false, ""},
		"allow lists it":         {map[string]string{"/etc/cron.allow": "mdrb-cells\n"}, true, false, "/etc/cron.allow lists mdrb-cells: remove it"},
		"neither file":           {map[string]string{}, true, false, "mdrb-cells may use cron"},
		"deny without it":        {map[string]string{"/etc/at.deny": "mdrb-cellsx"}, false, true, "mdrb-cells may use at: add it to /etc/at.deny"},
		"unreadable allow":       {map[string]string{"/etc/cron.allow": "unreadable"}, true, false, "can't read /etc/cron.allow"},
		"unreadable deny":        {map[string]string{"/etc/at.deny": "unreadable"}, false, true, "can't read /etc/at.deny"},
		"neither tool installed": {map[string]string{}, false, false, ""},
		"only at is not denied":  {map[string]string{"/etc/cron.deny": "mdrb-cells"}, true, true, "may use at"},
	} {
		f := &fakeSys{cronFiles: c.files}
		got := strings.Join(cronProblems(cronSetup{dir: "/etc", crontab: c.crontab, at: c.at, read: f.readCron}, "mdrb-cells"), "; ")
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
}

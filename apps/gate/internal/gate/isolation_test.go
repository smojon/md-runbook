//go:build unix

package gate

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"

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
	wrapEnv := []string{"PATH=" + gatePath, "LC_ALL=C"}
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

func TestSudoRule(t *testing.T) {
	p := testPlan
	p.account = "mdrb-cells"
	if got := p.sudoRule("support"); got != "support ALL=(mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate __cells" {
		t.Errorf("rule: %s", got)
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
	good := sudoHead + "    (mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n"
	if p := sudoProblem(good, "mdrb-cells", exe); p != "" {
		t.Errorf("exact rule: %s", p)
	}
	if p := sudoProblem(strings.ReplaceAll(good, "\n", "\r\n"), "mdrb-cells", exe); p != "" {
		t.Errorf("CRLF: %s", p)
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
		if p := sudoProblem(out, "mdrb-cells", exe); p == "" {
			t.Errorf("%s: accepted", name)
		}
	}
}

// A fake system for the self-check: the programs it runs and what they answer.
type fakeSys struct {
	idOut, groups, home, sudoL string
	idErr, sudoErr             error
	check                      checkResult
	checkErr                   error
	calls                      [][]string
	files                      fakeFS
}

// fakeFS: owners and modes by path (no links).
type fakeFS map[string]pathInfo

func (fs fakeFS) stat(p string) (pathInfo, error) {
	if i, ok := fs[p]; ok {
		return i, nil
	}
	return pathInfo{}, errors.New("no such file")
}

func (fs fakeFS) real(p string) (string, error) {
	if _, ok := fs[p]; ok {
		return p, nil
	}
	return "", errors.New("no such file")
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
	case argv[0] == "id" && argv[1] == "-G":
		return []byte(f.groups), nil
	case argv[0] == "id":
		return []byte(f.idOut), f.idErr
	case argv[0] == "/bin/sh":
		return []byte(f.home), nil
	case reflect.DeepEqual(argv, []string{"/usr/bin/sudo", "-n", "-l"}):
		return []byte(f.sudoL), f.sudoErr
	case reflect.DeepEqual(argv, []string{"/usr/bin/sudo", "-n", "-u", "mdrb-cells", "--", "/usr/local/bin/md-runbook-gate", "__cells"}):
		req, err := readCellsReq(bytes.NewReader(stdin))
		if err != nil || req.Op != "check" {
			return nil, errors.New("bad request")
		}
		data, _ := json.Marshal(f.check)
		return data, f.checkErr
	}
	return nil, errors.New("unexpected " + strings.Join(argv, " "))
}

func goodSys() *fakeSys {
	return &fakeSys{
		idOut: "1500\n", groups: "1500 27\n", home: "/home/mdrb-cells",
		sudoL: sudoHead + "    (mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate __cells\n",
		check: checkResult{UID: 1500, Read: []string{}, Write: []string{"/tmp/md-runbook-gate.x/exits.y"}},
		files: goodFS(),
	}
}

func check(f *fakeSys) (cellsInfo, error) {
	p := testPlan
	p.account = "mdrb-cells"
	return selfCheck{
		run: f.run, plan: p, sh: "/bin/sh", gateAccount: "support", gateUID: 1000,
		noRead:    []string{"/etc/md-runbook/report-token", "/var/log/md-runbook-gate.log"},
		noWrite:   []string{"/usr/local/bin/md-runbook-gate", "/etc/md-runbook/gate.conf"},
		mustWrite: []string{"/tmp/md-runbook-gate.x/exits.y"},
		safe:      []string{"/usr/local/bin/md-runbook-gate", "/etc/md-runbook/gate.conf", "/tmp/mdrb.x/report-token"},
		stat:      f.files.stat, real: f.files.real,
	}.do()
}

func TestSelfCheck(t *testing.T) {
	f := goodSys()
	info, err := check(f)
	if err != nil || info.uid != 1500 || info.home != "/home/mdrb-cells" {
		t.Fatalf("good: %+v %v", info, err)
	}
	if len(f.calls) != 5 {
		t.Errorf("calls: %q", f.calls)
	}
	rule := "support ALL=(mdrb-cells) NOPASSWD: /usr/local/bin/md-runbook-gate __cells"
	for name, c := range map[string]struct {
		change func(f *fakeSys)
		want   []string
	}{
		"no account":     {func(f *fakeSys) { f.idOut, f.idErr = "", errors.New("exit status 1") }, []string{"no such account"}},
		"open folder":    {func(f *fakeSys) { f.files["/etc/md-runbook"] = pathInfo{perm: 0o777} }, []string{"/etc/md-runbook, a folder above /etc/md-runbook/gate.conf, is writable by mdrb-cells"}},
		"root":           {func(f *fakeSys) { f.idOut = "0\n" }, []string{"is root"}},
		"the gate's own": {func(f *fakeSys) { f.idOut = "1000\n" }, []string{"the gate's own account"}},
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
	} {
		fs := goodFS()
		if c.change != nil {
			c.change(fs)
		}
		got := safePathProblem(c.path, fs.stat, fs.real, 1000, 1500, groups, "support", "mdrb-cells")
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
}

// Separated mode: the gate reads the exits the cells' shells append, logs the end events, and
// keeps the first line with each run's random number. A forged, garbled or truncated file
// changes nothing that was read.
func TestExitsFile(t *testing.T) {
	dir := t.TempDir()
	g := &Gate{log: &logx.Logger{Dest: dir + "/gate.log", Account: "support"}}
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
	write("2\t0\t2026-11-16T10:00:00Z\tforged\t\n1\t0\t2026-11-16T10:00:01Z\tn1\t\n2\t3\tnot a time\tn2\tkube-context is none, not prod\n2\t0\t2026-11-16T10:00:09Z\tn2\t\n3\t7", os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
	g.readExitsFile()
	// The rest of run 3's line comes later.
	write("\t2026-11-16T10:00:05Z\tn3\t\n", os.O_WRONLY|os.O_APPEND)
	g.readExitsFile()
	// Truncated, and a later line for run 1: what was read stays.
	write("1\t9\t2026-11-16T10:00:06Z\tn1\t\n", os.O_WRONLY|os.O_TRUNC)
	g.readExitsFile()
	ex := g.sepExitsCopy()
	if ex["1"] != (report.Exit{RC: "0", Time: "2026-11-16T10:00:01Z"}) || ex["2"].RC != "3" || ex["2"].Time == "not a time" || ex["3"] != (report.Exit{RC: "7", Time: "2026-11-16T10:00:05Z"}) || len(ex) != 3 {
		t.Errorf("exits: %+v", ex)
	}
	data, _ := os.ReadFile(dir + "/gate.log")
	log := string(data)
	for _, want := range []string{`"event":"end","id":"0000aa01","exit":0}`, `"event":"end","id":"0000aa02","exit":3}`, `"event":"end","id":"0000aa03","exit":7}`,
		`"event":"refused","id":"0000aa02","reason":"kube-context is none, not prod"}`} {
		if !strings.Contains(log, want) {
			t.Errorf("log lacks %s:\n%s", want, log)
		}
	}
	if strings.Count(log, `"event":"end"`) != 3 {
		t.Errorf("log:\n%s", log)
	}
	for s, ok := range map[string]bool{"2026-11-16T10:00:01Z": true, "2026-11-16 10:00:01Z": false, "2026-11-16T10:00:01": false, "2026-1a-16T10:00:01Z": false} {
		if isUTCTime(s) != ok {
			t.Errorf("isUTCTime(%q) != %v", s, ok)
		}
	}
}

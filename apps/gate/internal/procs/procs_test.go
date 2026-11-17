package procs

import (
	"reflect"
	"testing"
)

func TestParseStat(t *testing.T) {
	p, ok := ParseStat("4242 (sleep (x) y) S 4200 4242 4100 0 -1 4194304 ...")
	if !ok || p.PID != 4242 || p.PPID != 4200 || p.PGID != 4242 || p.SID != 4100 || p.Comm != "sleep (x) y" || p.Zombie {
		t.Errorf("stat: %+v %v", p, ok)
	}
	if p, ok := ParseStat("7 (sh) Z 1 7 7 0"); !ok || !p.Zombie {
		t.Errorf("zombie: %+v", p)
	}
	if _, ok := ParseStat("garbage"); ok {
		t.Error("garbage")
	}
	stat := "4242 (a) b) S 4200 4242 4100 0 -1 4194304 1 0 0 0 5 2 0 0 20 0 1 0 987654 1000 100"
	if s := ParseStartTime(stat); s != "987654" {
		t.Errorf("start time: %q", s)
	}
	if s := ParseStartTime("7 (sh) S 1 7 7"); s != "" {
		t.Errorf("short stat: %q", s)
	}
	if uid, ok := ParseUID("Name:\tsh\nUid:\t1000\t1001\t1001\t1001\n"); !ok || uid != 1001 {
		t.Errorf("uid: %d", uid)
	}
}

func TestDescendants(t *testing.T) {
	list := []Proc{{PID: 10, PPID: 1}, {PID: 11, PPID: 10}, {PID: 12, PPID: 11}, {PID: 13, PPID: 10}, {PID: 14, PPID: 1}}
	if got := Descendants(list, 10); !reflect.DeepEqual(got, []int{11, 12, 13}) {
		t.Errorf("descendants: %v", got)
	}
	if got := ParsePS("  10     1\n 11 10\nbad\n"); !reflect.DeepEqual(got, []Proc{{PID: 10, PPID: 1}, {PID: 11, PPID: 10}}) {
		t.Errorf("ps: %+v", got)
	}
	// With uid, group and name (macOS: what finds the cells' shell, and strays, in separated mode).
	if got := ParsePS(" 20 1 501 20 /usr/local/bin/md-runbook-gate\n 21 20 0 20 sudo\n"); len(got) != 2 || got[0].Comm != "md-runbook-gate" || got[1].Comm != "sudo" {
		t.Errorf("ps with comm: %+v", got)
	}
	// With uid and group (macOS: what finds the cells' shell in separated mode).
	if got := ParsePS("  10     1   0  10\n 11 10 501 10\n 12 10 x 10\n"); !reflect.DeepEqual(got, []Proc{{PID: 10, PPID: 1, PGID: 10}, {PID: 11, PPID: 10, UID: 501, PGID: 10}}) {
		t.Errorf("ps with uid: %+v", got)
	}
}

func TestParseNSpidAndCgroup(t *testing.T) {
	if got := ParseNSpid("Name:\tbash\nNSpid:\t4242\t2\nNSpgid:\t4241\t1\n"); !reflect.DeepEqual(got, []int{4242, 2}) {
		t.Errorf("nspid: %v", got)
	}
	if got := ParseNSpid("Name:\tbash\nNSpid:\t4242\n"); !reflect.DeepEqual(got, []int{4242}) {
		t.Errorf("nspid: %v", got)
	}
	if got := ParseNSpid("Name:\tbash\n"); got != nil {
		t.Errorf("no nspid: %v", got)
	}
	cg := "12:pids:/x\n0::/user.slice/user-1000.slice/user@1000.service/app.slice/md-runbook-gate-ab-1.scope\n"
	if got := ParseCgroup2(cg); got != "/user.slice/user-1000.slice/user@1000.service/app.slice/md-runbook-gate-ab-1.scope" {
		t.Errorf("cgroup: %q", got)
	}
	if got := ParseCgroup2("1:name=systemd:/x\n"); got != "" {
		t.Errorf("v1 only: %q", got)
	}
}

// The cells' shell under what the gate started: the wrapper itself once it is the shell (shared
// mode: systemd-run and the cells mode exec it), the child of uid under sudo (separated), and pid
// 2 of the PID namespace under bwrap.
func TestShellOf(t *testing.T) {
	list := []Proc{
		{PID: 50, PPID: 1, UID: 1000},  // the gate
		{PID: 51, PPID: 50, UID: 1000}, // systemd-run, then the shell (shared)
		{PID: 52, PPID: 50, UID: 0},    // sudo (separated)
		{PID: 53, PPID: 52, UID: 1500}, // the cells' shell
		{PID: 54, PPID: 53, UID: 1500}, // a cell's program
		{PID: 60, PPID: 50, UID: 0},    // sudo -> bwrap (separated)
		{PID: 61, PPID: 60, UID: 1500}, // bwrap
		{PID: 62, PPID: 61, UID: 1500}, // bwrap's init (pid 1 inside)
		{PID: 63, PPID: 62, UID: 1500}, // the shell (pid 2 inside)
		{PID: 70, PPID: 50, UID: 0},    // sudo, before its fork
	}
	two := func(pid int) bool { return pid == 63 }
	for _, c := range []struct {
		leader, uid int
		inner       func(int) bool
		want        int
	}{
		{51, 1000, nil, 51},
		{52, 1500, nil, 53},
		{60, 1500, two, 63},
		{60, 1500, func(int) bool { return false }, 0},
		{70, 1500, nil, 0},
		{99, 1000, nil, 0},
	} {
		if got := ShellOf(list, c.leader, c.uid, c.inner); got != c.want {
			t.Errorf("ShellOf(%d, %d) = %d, want %d", c.leader, c.uid, got, c.want)
		}
	}
}

// The cells' account (1500) in separated mode: a live session's cells hang under a gate (1000)
// through sudo (root). A lease ends all of them; the blocks of another gate account's session
// make it refuse instead.
//
//	202 gate (1000) -> 203 sudo (root) -> 204 bash (1500) -> 205 sleep (1500)
//	210 gate of another account (1001) -> 211 sudo -> 212 bash (1500)
//	220 another program of the gate's account (1000) -> 221 (1500)
//	300 double-forked (1500, parent 1); 301 its child
//	400 cron (root) -> 401 job (1500)
//	700 systemd --user (1500) -> 701 (sd-pam); 702 a service
//	800 docker exec'd (1500, parent 0); 900 zombie
func TestCellsLiveAndUnder(t *testing.T) {
	list := []Proc{
		{PID: 1, PPID: 0, UID: 0, Comm: "init"},
		{PID: 202, PPID: 201, UID: 1000, Comm: "md-runbook-gate"},
		{PID: 203, PPID: 202, UID: 0, Comm: "sudo"},
		{PID: 204, PPID: 203, UID: 1500, Comm: "bash"},
		{PID: 205, PPID: 204, UID: 1500, Comm: "sleep"},
		{PID: 210, PPID: 1, UID: 1001, Comm: "md-runbook-gate"},
		{PID: 211, PPID: 210, UID: 0, Comm: "sudo"},
		{PID: 212, PPID: 211, UID: 1500, Comm: "bash"},
		{PID: 220, PPID: 1, UID: 1000, Comm: "systemd"},
		{PID: 221, PPID: 220, UID: 1500, Comm: "sleep"},
		{PID: 300, PPID: 1, UID: 1500, Comm: "sleep"},
		{PID: 301, PPID: 300, UID: 1500, Comm: "sleep"},
		{PID: 400, PPID: 1, UID: 0, Comm: "cron"},
		{PID: 401, PPID: 400, UID: 1500, Comm: "job"},
		{PID: 700, PPID: 1, UID: 1500, Comm: "systemd"},
		{PID: 701, PPID: 700, UID: 1500, Comm: "(sd-pam)"},
		{PID: 702, PPID: 700, UID: 1500, Comm: "service"},
		{PID: 800, PPID: 0, UID: 1500, Comm: "sh"},
		{PID: 900, PPID: 1, UID: 1500, Comm: "sh", Zombie: true},
	}
	// What a lease ends: every live process of the account, wherever it hangs.
	if got, want := Live(list, 1500), []int{204, 205, 212, 221, 300, 301, 401, 700, 701, 702, 800}; !reflect.DeepEqual(got, want) {
		t.Errorf("live: %v, want %v", got, want)
	}
	// What makes it refuse instead: another gate account's blocks (this gate's own don't count).
	if got, want := Under(list, 1500, OtherGate(1000, 1500, "md-runbook-gate")), []int{212}; !reflect.DeepEqual(got, want) {
		t.Errorf("under another gate: %v, want %v", got, want)
	}
	if got := Under(list, 1500, OtherGate(1001, 1500, "md-runbook-gate")); !reflect.DeepEqual(got, []int{204, 205}) {
		t.Errorf("seen from the other gate: %v", got)
	}
	if Comm("/usr/local/bin/md-runbook-gate-long-name") != "md-runbook-gate" || Comm("sh") != "sh" {
		t.Errorf("comm: %q", Comm("/usr/local/bin/md-runbook-gate-long-name"))
	}
}

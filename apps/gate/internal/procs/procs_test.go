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
// through sudo (root); what left it hangs under PID 1.
//
//	202 gate (1000) -> 203 sudo (root) -> 204 bash (1500) -> 205 sleep (1500)
//	210 gate of another account (1001) -> 211 sudo -> 212 bash (1500)
//	300 double-forked (1500, parent 1); 301 its child
//	400 cron (root) -> 401 job (1500)
//	700 systemd --user (1500) -> 701 (sd-pam); 702 a service
//	800 docker exec'd (1500, parent 0); 900 zombie
func TestCellsLeftovers(t *testing.T) {
	list := []Proc{
		{PID: 1, PPID: 0, UID: 0, Comm: "init"},
		{PID: 202, PPID: 201, UID: 1000, Comm: "md-runbook-gate"},
		{PID: 203, PPID: 202, UID: 0, Comm: "sudo"},
		{PID: 204, PPID: 203, UID: 1500, Comm: "bash"},
		{PID: 205, PPID: 204, UID: 1500, Comm: "sleep"},
		{PID: 210, PPID: 1, UID: 1001, Comm: "md-runbook-gate"},
		{PID: 211, PPID: 210, UID: 0, Comm: "sudo"},
		{PID: 212, PPID: 211, UID: 1500, Comm: "bash"},
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
	inUM := func(pid int) bool { return pid == 700 || pid == 701 }
	if got, want := CellsLeftovers(list, 1500, inUM), []int{300, 301, 401, 702}; !reflect.DeepEqual(got, want) {
		t.Errorf("cells leftovers: %v, want %v", got, want)
	}
}

// A system as the sweep sees it: uid 1000 is the gate's account, 0 is root.
//
//	1    init (root)
//	100  sshd listener (root)        200 sshd-session (root, its own session) -> 201 sh (1000) -> 202 gate (1000, me) -> 203 bash
//	300  sshd-session of another login (root, session leader) -> 301 bash (1000)
//	400  cron (root) -> 401 job (1000)
//	500  leftover (1000, its own group 500) -> 501 child (group 500)
//	600  leftover in group 600 with 601 of root
//	700  systemd --user (1000) -> 701 (sd-pam) (1000) -> 702 a service (1000)
//	800  docker exec'd sh (1000, parent 0)
//	900  zombie (1000)
func system() []Proc {
	return []Proc{
		{PID: 1, PPID: 0, UID: 0, PGID: 1, SID: 1, Comm: "init"},
		{PID: 100, PPID: 1, UID: 0, PGID: 100, SID: 100, Comm: "sshd"},
		{PID: 200, PPID: 100, UID: 0, PGID: 200, SID: 200, Comm: "sshd-session"},
		{PID: 201, PPID: 200, UID: 1000, PGID: 201, SID: 200, Comm: "sh"},
		{PID: 202, PPID: 201, UID: 1000, PGID: 201, SID: 200, Comm: "md-runbook-gate"},
		{PID: 203, PPID: 202, UID: 1000, PGID: 203, SID: 203, Comm: "bash"},
		{PID: 300, PPID: 100, UID: 0, PGID: 300, SID: 300, Comm: "sshd-session"},
		{PID: 301, PPID: 300, UID: 1000, PGID: 301, SID: 300, Comm: "bash"},
		{PID: 400, PPID: 1, UID: 0, PGID: 400, SID: 400, Comm: "cron"},
		{PID: 401, PPID: 400, UID: 1000, PGID: 400, SID: 400, Comm: "job"},
		{PID: 500, PPID: 1, UID: 1000, PGID: 500, SID: 500, Comm: "sleep"},
		{PID: 501, PPID: 500, UID: 1000, PGID: 500, SID: 500, Comm: "sleep"},
		{PID: 600, PPID: 1, UID: 1000, PGID: 600, SID: 600, Comm: "sleep"},
		{PID: 601, PPID: 1, UID: 0, PGID: 600, SID: 600, Comm: "su"},
		{PID: 700, PPID: 1, UID: 1000, PGID: 700, SID: 700, Comm: "systemd"},
		{PID: 701, PPID: 700, UID: 1000, PGID: 700, SID: 700, Comm: "(sd-pam)"},
		{PID: 702, PPID: 700, UID: 1000, PGID: 702, SID: 702, Comm: "service"},
		{PID: 800, PPID: 0, UID: 1000, PGID: 800, SID: 800, Comm: "sh"},
		{PID: 900, PPID: 1, UID: 1000, PGID: 900, SID: 900, Comm: "sh", Zombie: true},
	}
}

func TestSessionRoot(t *testing.T) {
	list := system()
	if got := SessionRoot(list, 202, 201, 1000); got != 201 {
		t.Errorf("root = %d", got)
	}
	// The gate's parent changed (the client went), or was PID 1: none.
	if got := SessionRoot(list, 202, 999, 1000); got != 0 {
		t.Errorf("changed parent: %d", got)
	}
	if got := SessionRoot([]Proc{{PID: 5, PPID: 1, UID: 1000}}, 5, 1, 1000); got != 0 {
		t.Errorf("PID 1 parent: %d", got)
	}
}

func TestLeftovers(t *testing.T) {
	inUM := func(pid int) bool { return pid == 700 || pid == 701 }
	got := Leftovers(system(), 202, 201, 1000, inUM)
	want := []Leftover{
		{PID: 401, PPID: 400, PGID: 400, Group: false}, // a cron job; root's cron shares its group
		{PID: 500, PPID: 1, PGID: 500, Group: true},
		{PID: 501, PPID: 500, PGID: 500, Group: true},
		{PID: 600, PPID: 1, PGID: 600, Group: false},  // its group has a process of root
		{PID: 702, PPID: 700, PGID: 702, Group: true}, // the user manager's services go
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("leftovers:\n%+v\nwant\n%+v", got, want)
	}
}

// The ops image: sshd runs as the account. Its listener is the session's top, and spares every
// login under it; without the top (the gate's parent changed), the listener would be a leftover,
// which is why the gate doesn't sweep then (security review round 5).
func TestLeftoversSSHDAsAccount(t *testing.T) {
	list := []Proc{
		{PID: 1, PPID: 0, UID: 0, PGID: 1, SID: 1, Comm: "tini"},
		{PID: 10, PPID: 1, UID: 1000, PGID: 10, SID: 10, Comm: "sshd"},
		{PID: 11, PPID: 10, UID: 1000, PGID: 11, SID: 11, Comm: "sshd-session"},
		{PID: 12, PPID: 11, UID: 1000, PGID: 11, SID: 11, Comm: "md-runbook-gate"},
		{PID: 13, PPID: 10, UID: 1000, PGID: 13, SID: 13, Comm: "sshd-session"},
		{PID: 14, PPID: 13, UID: 1000, PGID: 14, SID: 14, Comm: "bash"},
	}
	none := func(int) bool { return false }
	top := SessionRoot(list, 12, 11, 1000)
	if top != 10 {
		t.Fatalf("top = %d", top)
	}
	if got := Leftovers(list, 12, top, 1000, none); len(got) != 0 {
		t.Errorf("leftovers: %+v", got)
	}
	if got := Leftovers(list, 12, 0, 1000, none); len(got) != 4 || got[0].PID != 10 {
		t.Errorf("without top: %+v", got)
	}
}

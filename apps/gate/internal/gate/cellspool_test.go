//go:build unix

package gate

import (
	"bufio"
	"errors"
	"io"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/procs"
)

var testPool = []string{"mdrb-cells-1", "mdrb-cells-2", "mdrb-cells-3", "mdrb-cells-4"}

// fakeLocks: locks by name, as flock would hold them.
type fakeLocks struct {
	mu   sync.Mutex
	held map[string]bool
	fail map[string]error
}

type fakeLock struct {
	l    *fakeLocks
	name string
}

func (f fakeLock) Close() error {
	f.l.mu.Lock()
	defer f.l.mu.Unlock()
	delete(f.l.held, f.name)
	return nil
}

func (f *fakeLocks) lock(name string) (io.Closer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.fail[name]; err != nil {
		return nil, err
	}
	if f.held[name] {
		return nil, errBusy
	}
	f.held[name] = true
	return fakeLock{f, name}, nil
}

// Each session takes the first free account, in the pool's order; a released one is free again;
// none free, or a lock that fails otherwise, refuses.
func TestLease(t *testing.T) {
	f := &fakeLocks{held: map[string]bool{}}
	var locks []io.Closer
	for want := range testPool {
		i, l, err := lease(testPool, f.lock)
		if err != nil || i != want {
			t.Fatalf("lease %d: %d %v", want, i, err)
		}
		locks = append(locks, l)
	}
	if _, _, err := lease(testPool, f.lock); err != errAllBusy {
		t.Errorf("all busy: %v", err)
	}
	locks[2].Close()
	if i, _, err := lease(testPool, f.lock); err != nil || i != 2 {
		t.Errorf("after a release: %d %v", i, err)
	}
	f = &fakeLocks{held: map[string]bool{"mdrb-cells-1": true}, fail: map[string]error{"mdrb-cells-2": syscall.EACCES}}
	if _, _, err := lease(testPool, f.lock); err == nil || !strings.Contains(err.Error(), "can't take the lock of mdrb-cells-2") {
		t.Errorf("a failing lock: %v", err)
	}
	if got := busyMessage("cells_accounts", testPool); got != "all 4 cells accounts are in use: raise the pool (cells_accounts = in gate.conf)" {
		t.Errorf("busy: %s", got)
	}
	if got := busyMessage("cells_account", []string{"mdrb-cells"}); !strings.Contains(got, "cells_account = mdrb-cells is in use by another session") || !strings.Contains(got, "cells_accounts =") {
		t.Errorf("busy, one: %s", got)
	}
}

// An account whose processes can't all be ended (a process in D state) doesn't block the pool:
// it is skipped, its lock kept by the session that found it, and the next free one is leased;
// none clear refuses (review of 0.30.0, M3). Only free accounts are cleared.
func TestLeaseClear(t *testing.T) {
	f := &fakeLocks{held: map[string]bool{}}
	stuckOnes := map[int]bool{0: true}
	var tried []int
	clear := func(i int) string {
		tried = append(tried, i)
		if stuckOnes[i] {
			return "1 processes of " + testPool[i] + " are left after ending them all (300 sleep)"
		}
		return ""
	}
	i, l, stuck, problems, err := leaseClear(testPool, f.lock, clear)
	if err != nil || i != 1 || len(stuck) != 1 || !reflect.DeepEqual(tried, []int{0, 1}) || len(problems) != 1 || !strings.Contains(problems[0], "mdrb-cells-1 are left") {
		t.Fatalf("one stuck: %d %v %d %v %q", i, err, len(stuck), tried, problems)
	}
	if !f.held["mdrb-cells-1"] || !f.held["mdrb-cells-2"] {
		t.Errorf("held: %v", f.held)
	}
	// Another session meanwhile: the stuck one is busy (its lock kept), so it isn't tried again.
	tried = nil
	i2, l2, stuck2, _, err := leaseClear(testPool, f.lock, clear)
	if err != nil || i2 != 2 || len(stuck2) != 0 || !reflect.DeepEqual(tried, []int{2}) {
		t.Errorf("next session: %d %v %v", i2, err, tried)
	}
	// The first session ends: its locks go, and the next session tries the stuck one again.
	l.Close()
	stuck[0].Close()
	tried = nil
	i3, l3, stuck3, _, err := leaseClear(testPool, f.lock, clear)
	if err != nil || i3 != 1 || len(stuck3) != 1 || !reflect.DeepEqual(tried, []int{0, 1}) {
		t.Errorf("after the first ended: %d %v %v", i3, err, tried)
	}
	l2.Close()
	l3.Close()
	stuck3[0].Close()

	// None clear: refused, each one's reason, their locks still held until the gate ends.
	stuckOnes = map[int]bool{0: true, 1: true, 2: true, 3: true}
	f = &fakeLocks{held: map[string]bool{"mdrb-cells-3": true}}
	tried = nil
	_, l, stuck, problems, err = leaseClear(testPool, f.lock, clear)
	if err != errNoneClear || l != nil || len(stuck) != 3 || len(problems) != 3 || !reflect.DeepEqual(tried, []int{0, 1, 3}) {
		t.Errorf("none clear: %v %d %q %v", err, len(stuck), problems, tried)
	}
	// All busy: as before.
	f = &fakeLocks{held: map[string]bool{"mdrb-cells-1": true, "mdrb-cells-2": true, "mdrb-cells-3": true, "mdrb-cells-4": true}}
	if _, _, _, _, err := leaseClear(testPool, f.lock, clear); err != errAllBusy {
		t.Errorf("all busy: %v", err)
	}
	// A lock that fails otherwise: refused, and the stuck ones' locks released.
	stuckOnes = map[int]bool{0: true}
	f = &fakeLocks{held: map[string]bool{}, fail: map[string]error{"mdrb-cells-2": syscall.EACCES}}
	if _, _, _, _, err := leaseClear(testPool, f.lock, clear); err == nil || !strings.Contains(err.Error(), "can't take the lock of mdrb-cells-2") || f.held["mdrb-cells-1"] {
		t.Errorf("a failing lock: %v %v", err, f.held)
	}
}

// Real flock: sessions side by side get different accounts, a fifth none; a closed lock (a gate
// that ended) is free again.
func TestLeaseFlockConcurrent(t *testing.T) {
	dir := t.TempDir()
	lock := flockIn(dir)
	var wg sync.WaitGroup
	var mu sync.Mutex
	got := map[int]int{}
	busy := 0
	var held []io.Closer
	for n := 0; n < 6; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			i, l, err := lease(testPool, lock)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == errAllBusy:
				busy++
			case err != nil:
				t.Errorf("lease: %v", err)
			default:
				got[i]++
				held = append(held, l)
			}
		}()
	}
	wg.Wait()
	if len(got) != 4 || busy != 2 {
		t.Fatalf("leases %v, busy %d", got, busy)
	}
	for i, n := range got {
		if n != 1 {
			t.Errorf("account %d leased %d times", i, n)
		}
	}
	held[0].Close()
	if _, l, err := lease(testPool, lock); err != nil {
		t.Errorf("after a gate ended: %v", err)
	} else {
		l.Close()
	}
	for _, l := range held[1:] {
		l.Close()
	}
	// A link planted where a lock goes is not followed.
	os.Symlink("/etc/passwd", dir+"/x.lock")
	if _, _, err := lease([]string{"x"}, lock); err == nil || errors.Is(err, errBusy) {
		t.Errorf("a link: %v", err)
	}
}

// The process that holds a lock is killed (a crashed gate): its lock goes with it.
func TestLeaseCrashedHolder(t *testing.T) {
	if dir := os.Getenv("MDRB_TEST_LOCK_HOLDER"); dir != "" {
		if _, _, err := lease(testPool[:1], flockIn(dir)); err != nil {
			os.Stdout.WriteString("failed " + err.Error() + "\n")
			os.Exit(1)
		}
		os.Stdout.WriteString("held\n")
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestLeaseCrashedHolder$")
	cmd.Env = append(os.Environ(), "MDRB_TEST_LOCK_HOLDER="+dir)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	line, _ := bufio.NewReader(out).ReadString('\n')
	if line != "held\n" {
		t.Fatalf("holder: %q", line)
	}
	if _, _, err := lease(testPool[:1], flockIn(dir)); err != errAllBusy {
		t.Fatalf("while held: %v", err)
	}
	cmd.Process.Signal(syscall.SIGKILL)
	cmd.Wait()
	i, l, err := lease(testPool[:1], flockIn(dir))
	if err != nil || i != 0 {
		t.Fatalf("after the crash: %d %v", i, err)
	}
	l.Close()
}

// killall: only as the leased account, never as root; KILL to -1.
func TestCellsKillAll(t *testing.T) {
	for _, c := range []struct {
		want, uid, euid int
		rc              int
	}{
		{1500, 1500, 1500, 0},
		{0, 0, 0, 2},    // root: never
		{1500, 0, 0, 2}, // run as root by mistake
		{1500, 1501, 1501, 2},
		{1500, 1500, 0, 2}, // a setuid root binary
		{-1, 1500, 1500, 2},
	} {
		var sent [][2]int
		kill := func(pid int, s syscall.Signal) error {
			sent = append(sent, [2]int{pid, int(s)})
			return nil
		}
		rc := cellsKillAll(c.want, c.uid, c.euid, kill)
		if rc != c.rc {
			t.Errorf("%+v: rc %d", c, rc)
		}
		want := [][2]int(nil)
		if c.rc == 0 {
			want = [][2]int{{-1, int(syscall.SIGKILL)}}
		}
		if !reflect.DeepEqual(sent, want) {
			t.Errorf("%+v: sent %v", c, sent)
		}
	}
}

// The helper's exit: 0 (Linux), or dead by its own KILL (macOS; sudo ends with the same signal,
// or 137): done. Any other exit, or runFor's own timeout (also a KILL), is not.
func TestKillallDone(t *testing.T) {
	sh := func(script string, limit time.Duration) error {
		_, err := runFor(limit, []string{"/bin/sh", "-c", script}, nil, nil)
		return err
	}
	if err := killallDone(sh("exit 0", 5*time.Second)); err != nil {
		t.Errorf("exit 0: %v", err)
	}
	if err := killallDone(sh("kill -KILL $$", 5*time.Second)); err != nil {
		t.Errorf("killed: %v", err)
	}
	if err := killallDone(sh("echo sudo: dies >&2; exit 137", 5*time.Second)); err != nil {
		t.Errorf("137: %v", err)
	}
	if err := killallDone(sh("echo 'sudo: a password is required' >&2; exit 1", 5*time.Second)); err == nil || !strings.Contains(err.Error(), "a password is required") {
		t.Errorf("exit 1: %v", err)
	}
	if err := killallDone(sh("kill -TERM $$", 5*time.Second)); err == nil {
		t.Error("TERM: done")
	}
	if err := killallDone(sh("exec sleep 5", 200*time.Millisecond)); !errors.Is(err, errTimeout) {
		t.Errorf("timeout: %v", err)
	}
}

// A fake process table for clearAccount: killall ends the account's processes after `stubborn`
// more calls; a list after each.
type fakeProcs struct {
	list     []procs.Proc
	uid      int
	stubborn int
	kills    int
	killErr  error
}

func (f *fakeProcs) ls() ([]procs.Proc, error) { return append([]procs.Proc(nil), f.list...), nil }

func (f *fakeProcs) killall() error {
	f.kills++
	if f.killErr != nil {
		return f.killErr
	}
	if f.stubborn > 0 {
		f.stubborn--
		return nil
	}
	var keep []procs.Proc
	for _, p := range f.list {
		if p.UID != f.uid || p.PID <= 1 {
			keep = append(keep, p)
		}
	}
	f.list = keep
	return nil
}

func TestClearAccount(t *testing.T) {
	base := func() []procs.Proc {
		return []procs.Proc{
			{PID: 1, UID: 0, Comm: "init"},
			{PID: 300, PPID: 1, UID: 1501, Comm: "sleep"}, // a block's setsid program
			{PID: 301, PPID: 300, UID: 1501, Comm: "sh"},  // its child
			{PID: 302, PPID: 1, UID: 1501, Comm: "sh", Zombie: true},
			{PID: 400, PPID: 1, UID: 1502, Comm: "sleep"}, // another pool account's
			{PID: 500, PPID: 1, UID: 1000, Comm: "md-runbook-gate"},
		}
	}
	run := func(f *fakeProcs, start bool) ([]int, string) {
		return clearAccount(clearer{list: f.ls, killall: f.killall, sleep: func(time.Duration) {}}, "mdrb-cells-1", 1501, 1000, "md-runbook-gate", start)
	}
	f := &fakeProcs{list: base(), uid: 1501}
	killed, problem := run(f, true)
	if problem != "" || !reflect.DeepEqual(killed, []int{300, 301}) || f.kills != 1 {
		t.Errorf("leftovers: %v %q (%d kills)", killed, problem, f.kills)
	}
	for _, p := range f.list {
		if p.UID == 1501 {
			t.Errorf("left: %+v", p)
		}
	}
	if len(f.list) != 3 {
		t.Errorf("other accounts' processes: %+v", f.list)
	}
	// Nothing there: killall runs all the same (a process could hide from a listing).
	f = &fakeProcs{list: append(base()[:1], base()[3:]...), uid: 1501}
	if killed, problem := run(f, true); problem != "" || len(killed) != 0 || f.kills != 1 {
		t.Errorf("none: %v %q %d", killed, problem, f.kills)
	}
	// A process that survives a killall (macOS: forked between the list and the signal): again.
	f = &fakeProcs{list: base(), uid: 1501, stubborn: 2}
	if _, problem := run(f, true); problem != "" || f.kills != 3 {
		t.Errorf("twice stubborn: %q %d", problem, f.kills)
	}
	f = &fakeProcs{list: base(), uid: 1501, stubborn: 3}
	if _, problem := run(f, true); !strings.Contains(problem, "2 processes of mdrb-cells-1 are left after ending them all (300 sleep, 301 sh)") || f.kills != 3 {
		t.Errorf("stubborn: %q %d", problem, f.kills)
	}
	// sudo can't run it.
	f = &fakeProcs{list: base(), uid: 1501, killErr: errors.New("exit status 1: sudo: a password is required")}
	if _, problem := run(f, false); !strings.Contains(problem, "can't end the processes of mdrb-cells-1 through sudo (exit status 1: sudo: a password is required)") {
		t.Errorf("sudo: %q", problem)
	}
	// Another gate account's session runs as it (a shared pool): refused at the start, nothing killed.
	other := append(base(), procs.Proc{PID: 600, PPID: 1, UID: 1001, Comm: "md-runbook-gate"}, procs.Proc{PID: 601, PPID: 600, UID: 0, Comm: "sudo"}, procs.Proc{PID: 602, PPID: 601, UID: 1501, Comm: "bash"})
	f = &fakeProcs{list: other, uid: 1501}
	if _, problem := run(f, true); !strings.Contains(problem, "runs the blocks of another gate account's session (602 bash)") || f.kills != 0 {
		t.Errorf("another gate: %q %d", problem, f.kills)
	}
	// This gate's own sessions don't count (none can run as a leased account; at the end they are
	// the session's own).
	own := append(base(), procs.Proc{PID: 601, PPID: 500, UID: 0, Comm: "sudo"}, procs.Proc{PID: 602, PPID: 601, UID: 1501, Comm: "bash"})
	f = &fakeProcs{list: own, uid: 1501}
	if _, problem := run(f, true); problem != "" {
		t.Errorf("own gate: %q", problem)
	}
	// hidepid: the gate can't see the account's processes.
	f = &fakeProcs{list: base()[1:], uid: 1501}
	if _, problem := run(f, true); !strings.Contains(problem, "hidepid") {
		t.Errorf("hidepid: %q", problem)
	}
}

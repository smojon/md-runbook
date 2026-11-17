//go:build unix

package gate

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/procs"
)

// ---- the pool of cells accounts (cells_accounts = in gate.conf) ----
// Each session of separated mode runs its blocks as an account of its own, leased from the pool
// for the session's whole life. Any process of an account can write into that account's shells
// through /proc/PID/fd/0 and read their exported values through /proc/PID/environ; another
// account's it can't. So a block can't reach another session's shells (review of 0.28.0, H2, and
// its re-review).
//
// The lease is a lock file per account in the gate's state folder (flock, held by the gate
// process for the session): the session takes the first account of the pool whose lock is free.
// The lock goes with the gate process, a crashed one too; its descriptor is close-on-exec, so no
// shell or block holds it. None free: the session doesn't start.
//
// Before the session's first block, and at its end, every process of the leased account ends:
// the gate runs the cells' mode as that account (the same sudo line) with killall, which calls
// kill(-1, SIGKILL). Then it lists the processes until none of the account is left. An account
// with one left (a process in D state) is skipped, its lock kept until the gate ends, and the
// next free one tried; none clear: the session doesn't start (leaseClear). So is one whose home
// keeps a key file its check can't remove (clearCells). An account that runs
// another gate account's blocks is no skip: the session doesn't start.
//   - Linux: kill(-1) signals every process the caller may signal (the account's), except itself
//     and PID 1, with the task list locked (kernel/signal.c, kill_something_info). A fork either
//     finished before, and the child gets the signal too, or sees the signal and fails: a process
//     that keeps forking can't slip out. The cells' mode itself lives on and exits 0.
//   - macOS: kill(-1) signals a list of the processes taken first (xnu, proc_iterate), the cells'
//     mode included, which dies with them (KILL is its exit, and counts as done). A process that
//     forks between the list and the signal can live on: the gate lists again, ends them all
//     again (3 times) and refuses to start while one is left.
//
// This replaces 0.28.0's look for strays (every process of the account under a gate of this
// account): one look at the start, which a process that keeps forking could slip past, and which
// didn't see a job started mid-session. What another session's blocks start now runs as another
// account. What is left of the leased account's: a block's own programs, within its session.

// errBusy: another session holds the account's lock.
var errBusy = errors.New("in use")

// errAllBusy: every account of the pool is in use.
var errAllBusy = errors.New("all in use")

// lockFunc takes an account's lock: errBusy when another session holds it.
type lockFunc func(name string) (io.Closer, error)

// errNoneClear: every free account of the pool kept a process through killall.
var errNoneClear = errors.New("none can be cleared")

// lease takes the first account of the pool whose lock is free: its index and the held lock.
// A lock that fails otherwise (the folder, the file) stops the session: fail closed.
func lease(pool []string, lock lockFunc) (int, io.Closer, error) {
	i, l, _, _, err := leaseClear(pool, lock, nil)
	return i, l, err
}

// clearRefused: an account the session can't lease for a reason that a skip would hide (another
// gate account's blocks run as it, the processes can't be listed): the session doesn't start.
type clearRefused struct{ why string }

func (e clearRefused) Error() string { return e.why }

// leaseClear takes the first account of the pool whose lock is free and whose processes all end
// (clear: "" or why not, and whether the account is only stuck; nil: none to end). A stuck
// account (a process in D state lives through SIGKILL, or killall fails) keeps its lock in stuck,
// held for the rest of this gate process, and the next free one is tried: one stuck account
// doesn't block the pool (review of 0.30.0, M3). problems: why each stuck one wasn't clear. Any
// other problem refuses at once (clearRefused): with a pool shared by two gate accounts, a skip
// would let both lease the same account (round 2, M-2). None clear: errNoneClear; none free:
// errAllBusy.
func leaseClear(pool []string, lock lockFunc, clear func(i int) (problem string, stuck bool)) (int, io.Closer, []io.Closer, []string, error) {
	var stuck []io.Closer
	var problems []string
	release := func() {
		for _, s := range stuck {
			s.Close()
		}
	}
	for i, name := range pool {
		l, err := lock(name)
		if errors.Is(err, errBusy) {
			continue
		}
		if err != nil {
			release()
			return -1, nil, nil, problems, errors.New("can't take the lock of " + name + ": " + err.Error())
		}
		if clear != nil {
			if p, skip := clear(i); p != "" {
				if !skip {
					l.Close()
					release()
					return -1, nil, nil, problems, clearRefused{p}
				}
				stuck = append(stuck, l)
				problems = append(problems, p)
				continue
			}
		}
		return i, l, stuck, problems, nil
	}
	if len(problems) > 0 {
		return -1, nil, stuck, problems, errNoneClear
	}
	return -1, nil, nil, nil, errAllBusy
}

// flockIn: the lock files in dir, NAME.lock, taken with flock (exclusive, without waiting).
func flockIn(dir string) lockFunc {
	return func(name string) (io.Closer, error) {
		f, err := os.OpenFile(dir+"/"+name+".lock", os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
		if err != nil {
			return nil, err
		}
		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			f.Close()
			if err == syscall.EWOULDBLOCK {
				return nil, errBusy
			}
			return nil, err
		}
		return f, nil
	}
}

// busyMessage: why the session doesn't start when no account is free.
func busyMessage(key string, pool []string) string {
	if len(pool) == 1 {
		return key + " = " + pool[0] + " is in use by another session of this account: for sessions side by side, name more accounts in cells_accounts ="
	}
	return "all " + itoa(len(pool)) + " cells accounts are in use: raise the pool (cells_accounts = in gate.conf)"
}

// cellsKillAll is the cells' mode's killall: KILL to every process of this account. Only as the
// account the gate leased (want), never as root: as root, kill(-1) would end the system.
func cellsKillAll(want, uid, euid int, kill func(int, syscall.Signal) error) int {
	if want <= 0 || uid != want || euid != want {
		say("cells mode: killall runs only as the cells account the gate leased")
		return 2
	}
	kill(-1, syscall.SIGKILL)
	return 0
}

// killallDone: the cells' mode's killall ran. It exits 0 (Linux), or dies in its own kill (KILL:
// macOS; sudo then ends with the same signal). A timeout is not that: runFor killed it.
func killallDone(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, errTimeout) {
		return err
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() && ws.Signal() == syscall.SIGKILL {
			return nil
		}
		if ee.ExitCode() == 128+int(syscall.SIGKILL) {
			return nil
		}
	}
	return err
}

// clearer is what ending an account's processes needs (tests give their own).
type clearer struct {
	list    func() ([]procs.Proc, error)
	killall func() error
	sleep   func(time.Duration)
}

// clearAccount ends every process of the account (name, uid): killall, then a listing until none
// is left (20 looks, 50 ms apart), 3 times at most. At the start (start) it refuses instead when
// the account runs another gate account's blocks: killall would end them, and the pool would be
// shared. What it found before (killed), and "" or why the account isn't clear. stuck: only this
// account is the problem (processes are left, or killall failed: a block's leftovers can make
// sudo fail as it, at its process limit), so a lease may skip it. Not for another gate account's
// blocks, nor for a listing that fails: those refuse.
func clearAccount(c clearer, name string, uid, gateUID int, gateComm string, start bool) (killed []int, problem string, stuck bool) {
	list, err := c.list()
	if err != nil {
		return nil, "can't list the processes", false
	}
	if !hasPID1(list) {
		return nil, "can't see other accounts' processes (is /proc mounted with hidepid?): the gate must see " + name + "'s", false
	}
	killed = procs.Live(list, uid)
	if start {
		if other := procs.Under(list, uid, procs.OtherGate(gateUID, uid, gateComm)); len(other) > 0 {
			return nil, name + " runs the blocks of another gate account's session (" + shown(list, other) + "): a pool serves one gate account only. Give each gate account cells accounts of its own", false
		}
	}
	var left []int
	for try := 0; try < 3; try++ {
		if err := c.killall(); err != nil {
			return killed, "can't end the processes of " + name + " through sudo (" + err.Error() + ")", true
		}
		for look := 0; look < 20; look++ {
			if list, err = c.list(); err != nil {
				return killed, "can't list the processes", false
			}
			if left = procs.Live(list, uid); len(left) == 0 {
				return killed, "", false
			}
			c.sleep(50 * time.Millisecond)
		}
	}
	return killed, itoa(len(left)) + " processes of " + name + " are left after ending them all (" + shown(list, left) + ")", true
}

// shown: up to 5 processes, as `PID name`.
func shown(list []procs.Proc, pids []int) string {
	byPID := map[int]procs.Proc{}
	for _, p := range list {
		byPID[p.PID] = p
	}
	var out []string
	for i, p := range pids {
		if i == 5 {
			out = append(out, "...")
			break
		}
		out = append(out, itoa(p)+" "+byPID[p].Comm)
	}
	return strings.Join(out, ", ")
}

func hasPID1(list []procs.Proc) bool {
	for _, p := range list {
		if p.PID == 1 {
			return true
		}
	}
	return false
}

// leaseCells: the session's cells account, from the pool (after the self-check), with none of its
// processes left, and the checks that run the cells' mode as that account (clearCells): only as an
// account this session holds, never as one another session's blocks run as (review of 0.30.0,
// H2). A stuck account is skipped; any other problem stops the gate before its first shell.
func (g *Gate) leaseCells(c selfCheck, infos []cellsInfo) {
	pool := g.cfg.CellsPool()
	dir := g.state + "/cells"
	if os.MkdirAll(dir, 0o700) != nil || os.Chmod(dir, 0o700) != nil {
		g.fatal("can't create " + dir)
	}
	var fatal error
	clear := func(i int) (string, bool) {
		problem, stuck, err := g.clearCells(c, infos[i], g.clearer())
		fatal = err
		return problem, stuck
	}
	i, lk, stuck, problems, err := leaseClear(pool, flockIn(dir), clear)
	// Nothing to end at the session's end on a stuck account: what is left may be another gate
	// account's. Its lock is kept, so that no other session of this gate account takes it now.
	g.cellsStuck = stuck
	if fatal != nil {
		g.cells, g.plan.account = cellsInfo{}, ""
		g.log.Event("event", "self-check", "status", "refused", "reason", strings.ReplaceAll(fatal.Error(), "\n", " "))
		g.fatal(fatal.Error())
	}
	if err != nil {
		msg, event := err.Error(), "lease"
		var refused clearRefused
		switch {
		case err == errAllBusy:
			msg = busyMessage(g.cfg.CellsKey(), pool)
		case err == errNoneClear:
			msg, event = g.cfg.CellsKey()+": no free cells account could be cleared: "+strings.Join(problems, "; "), "self-check"
		case errors.As(err, &refused):
			msg, event = g.cfg.CellsKey()+": "+refused.why, "self-check"
		}
		g.cells, g.plan.account = cellsInfo{}, ""
		g.log.Event("event", event, "status", "refused", "reason", msg)
		g.fatal(msg)
	}
	g.cells, g.plan.account, g.cellsLock = infos[i], infos[i].name, lk
}

// clearCells is a lease's look at a free account (its lock held): every process of it ends
// (clearAccount), then its cells' mode checks it (c.access). "" when the session may take it;
// else why not, and whether only this account is the problem (stuck: the lease skips it). fatal:
// a problem of the gate's setup that a skip would hide (the account can read the token, ...): the
// session doesn't start.
//   - A key file in its home that the check removed is logged (`lease`, `removed`).
//   - One it couldn't remove makes it stuck (review of 0.30.0, re-check M1): a block can leave
//     one, and a refusal would stop every session until root cleans up.
func (g *Gate) clearCells(c selfCheck, info cellsInfo, clr clearer) (problem string, stuck bool, fatal error) {
	g.cells, g.plan.account = info, info.name
	killed, problem, stuck := clearAccount(clr, info.name, info.uid, g.uid, g.gateComm, true)
	g.logKilled(killed, "start")
	if problem == "" {
		removed, err := c.access(info)
		if len(removed) > 0 {
			g.log.Event("event", "lease", "status", "removed", "cells", info.name, "files", strings.Join(removed, " "))
		}
		var left keyFilesLeft
		switch {
		case errors.As(err, &left):
			problem, stuck = left.why, true
		case err != nil:
			return err.Error(), false, err
		}
	}
	if stuck {
		// Its lock stays held by this gate process; the next account is tried.
		g.log.Event("event", "lease", "status", "skipped", "cells", info.name, "reason", problem)
	}
	return problem, stuck, nil
}

// endCells: at the end of the session (once), every process of its cells account ends. What is
// left is logged; the next session on that account ends it, or refuses to start.
func (g *Gate) endCells() {
	if g.cellsLock == nil {
		return
	}
	g.cellsEnd.Do(func() {
		killed, problem, _ := clearAccount(g.clearer(), g.cells.name, g.cells.uid, g.uid, g.gateComm, false)
		g.logKilled(killed, "end")
		if problem != "" {
			g.log.Event("event", "leftovers", "status", "incomplete", "reason", problem, "cells", g.cells.name, "when", "end")
		}
	})
}

func (g *Gate) logKilled(pids []int, when string) {
	if len(pids) == 0 {
		return
	}
	var s []string
	for _, p := range pids {
		s = append(s, itoa(p))
	}
	g.log.Event("event", "leftovers", "status", "killed", "pids", strings.Join(s, " "), "cells", g.cells.name, "when", when)
}

func (g *Gate) clearer() clearer {
	return clearer{list: procs.List, killall: g.cellsKillAll, sleep: time.Sleep}
}

// cellsKillAll runs the cells' mode's killall as the leased account (at most 10 seconds).
func (g *Gate) cellsKillAll() error {
	if g.plan.exe == "" || g.plan.sudo == "" || g.plan.account == "" {
		return errors.New("no sudo")
	}
	l := g.plan.outer("", true)
	_, err := runFor(10*time.Second, l.argv, l.env, cellsReq{Op: "killall", UID: g.cells.uid}.encode())
	return killallDone(err)
}

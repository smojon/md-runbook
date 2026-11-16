//go:build unix

package gate

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/logx"
	"github.com/smojon/md-runbook/apps/gate/internal/procs"
	"github.com/smojon/md-runbook/apps/gate/internal/report"
)

// ---- leftovers (kill_leftovers = yes) ----
// A program can outlive its session: it left its process group (setsid, a double fork), or it
// runs from cron. Such a leftover could write into a later session's shell through /proc
// (security review round 4). With kill_leftovers = yes, at the start of a session and at its end,
// the gate ends every process of this account that belongs to no live session. Linux only
// (/proc). Spared (procs.Leftovers):
//   - this session: everything under its topmost ancestor of this account (below PID 1; see
//     procs.SessionRoot), and under the gate;
//   - every other SSH login: anything under sshd's own process of another account (root's), the
//     leader of its session. Not under any other account's process: a cron job goes, and so does
//     an orphan a subreaper of root adopted (security review round 5);
//   - PID 1, what came in from outside the PID namespace (docker exec, kubectl exec), and the
//     account's user manager (systemd --user and its sd-pam: by name, parent and cgroup, as their
//     exe can't be read);
//   - run-report senders of earlier sessions: this program in its sender mode, with nothing in its
//     environment that loads code. (A sender ends within report.SenderMax, so one a block started
//     can't outlive many sweeps. Other sessions' gates are spared as part of their sessions.)
//
// Processes of a live session are out of its reach: keep the account for the gate alone. Against
// a fork loop (a program that forks and exits, again and again, so its pid never holds still) the
// sweep is best-effort: it stops whole process groups, and lists again until 3 passes in a row
// find nothing new, for at most 50 passes or 5 seconds ("sweep incomplete" in the log).
//
// In separated mode the cells' account is swept as well (sweepCells).
func (g *Gate) sweep(when string) {
	g.sweepAccount(when)
	g.sweepCells(when)
}

func (g *Gate) sweepAccount(when string) {
	if g.cfg.KillLeftovers != "yes" {
		return
	}
	me := os.Getpid()
	meExe := procs.Exe(me)
	if !readable("/proc/self/cmdline") || meExe == "" {
		g.log.Event("event", "leftovers", "status", "skipped", "reason", "no /proc here")
		return
	}
	// Never as root: every process of the system would be a leftover. (Root in a user namespace,
	// as in the tests, is fine.)
	if g.uid == 0 && procs.RealRoot() {
		g.log.Event("event", "leftovers", "status", "skipped", "reason", "the account is root")
		return
	}
	// Stopped first (STOP can't be caught or ignored), then listed again for what they started
	// meanwhile, then killed. killed: pids and -groups stopped; groups: the groups; failed: pids
	// that were gone before STOP.
	var killed []string
	stoppedPID := map[int]bool{}
	groups := map[int]bool{}
	failed := map[int]bool{}
	inUM := procs.InUserManagerScope(g.uid)
	t0 := time.Now()
	for pass, quiet := 0, 0; quiet < 3; {
		if pass >= 50 || time.Since(t0) >= 5*time.Second {
			g.log.Event("event", "leftovers", "status", "incomplete", "reason", "sweep incomplete: processes of the account kept appearing (a fork loop?)", "when", when)
			break
		}
		pass++
		list, err := procs.List()
		if err != nil {
			g.log.Event("event", "leftovers", "status", "skipped", "reason", "can't list the processes")
			break
		}
		if !g.topFound {
			g.sessionTop = procs.SessionRoot(list, me, g.ppid0, g.uid)
			if g.sessionTop == 0 {
				g.log.Event("event", "leftovers", "status", "skipped", "reason", "the gate's parent (sshd) ended first", "when", when)
				return
			}
			g.topFound = true
		}
		type stop struct {
			pid, pgid int
			group     bool
		}
		var stops []stop
		spared := map[int]bool{}
		for _, l := range procs.Leftovers(list, me, g.sessionTop, g.uid, inUM) {
			// (Group 0: its leader is outside the PID namespace.)
			pgid, group := l.PGID, l.Group
			if pgid <= 0 {
				pgid, group = 0, false
			}
			if stoppedPID[l.PID] || failed[l.PID] || groups[pgid] {
				continue
			}
			// A report sender: this program in its sender mode, nothing in its environment that
			// loads code.
			if x := procs.Exe(l.PID); x != "" && x == meExe && isSender(procs.Args(l.PID)) && procs.CleanEnviron(l.PID) {
				spared[pgid] = true
				continue
			}
			stops = append(stops, stop{l.PID, pgid, group})
		}
		if len(stops) == 0 {
			quiet++
			continue
		}
		quiet = 0
		for _, s := range stops {
			if groups[s.pgid] {
				continue
			}
			// A whole group at once: a fork loop that keeps its group can't slip out between two
			// passes.
			if s.group && s.pgid > 1 && !spared[s.pgid] {
				if syscall.Kill(-s.pgid, syscall.SIGSTOP) == nil {
					groups[s.pgid] = true
					killed = append(killed, "-"+itoa(s.pgid))
				} else {
					failed[s.pid] = true
				}
			} else if syscall.Kill(s.pid, syscall.SIGSTOP) == nil {
				stoppedPID[s.pid] = true
				killed = append(killed, itoa(s.pid))
			} else {
				// Gone already (or out of reach): not listed again.
				failed[s.pid] = true
			}
		}
	}
	if len(killed) == 0 {
		return
	}
	for _, k := range killed {
		syscall.Kill(atoiSigned(k), syscall.SIGKILL)
	}
	g.log.Event("event", "leftovers", "status", "killed", "pids", strings.Join(killed, " "), "when", when)
}

func isSender(args []string) bool { return len(args) == 2 && args[1] == report.SenderMode }

func atoiSigned(s string) int {
	if strings.HasPrefix(s, "-") {
		return -atoi(s[1:])
	}
	return atoi(s)
}

// ---- run reports (report_to in gate.conf) ----

// sendReports: at the end of a session, one run summary per signed runbook the session ran, sent
// after the session by this program started again (report.SenderMode), detached from the SSH
// channel: it never holds up or fails a run; each try is logged as a `report` event.
func (g *Gate) sendReports() {
	if !g.reportOn || len(g.reportRuns) == 0 {
		return
	}
	var token []byte
	if g.cfg.ReportToken != "" {
		data, err := os.ReadFile(g.cfg.ReportToken)
		tok := strings.NewReplacer(" ", "", "\t", "", "\r", "", "\n", "").Replace(string(data))
		if err != nil || tok == "" {
			g.log.Event("event", "report", "status", "skipped", "reason", "can't read the token file "+g.cfg.ReportToken)
			return
		}
		token = []byte(tok)
	}
	now := logx.Now()
	exits := g.readExits()
	host, _ := os.Hostname()
	s := report.Session{Who: g.who, Account: g.account, Client: g.client, Host: host, Mode: g.mode()}
	b := report.Batch{To: []byte(g.cfg.ReportTo), Token: token, Log: []byte(g.cfg.Log), Account: []byte(g.account), Who: []byte(g.who), Client: []byte(g.client)}
	seen := map[string]bool{}
	for _, r := range g.reportRuns {
		if seen[r.Hash] {
			continue
		}
		seen[r.Hash] = true
		m := g.rbManifest[r.Hash]
		if m == nil {
			continue
		}
		body := report.Summary(m, r.Hash, g.rbSigner[r.Hash], g.reportRuns, exits, s, now)
		b.Reports = append(b.Reports, report.Item{Body: []byte(body), Name: []byte(m.Field("name", "", 2)), Version: []byte(m.Field("version", "", 2))})
	}
	if len(b.Reports) == 0 {
		return
	}
	exe := "/proc/self/exe"
	if !procs.HaveProc() {
		var err error
		if exe, err = os.Executable(); err != nil {
			g.log.Event("event", "report", "status", "skipped", "reason", "can't start the report sender")
			return
		}
	}
	cmd := exec.Command(exe, report.SenderMode)
	cmd.Env = []string{"PATH=" + sysPath, "LC_ALL=C"}
	// A session of its own: the end of the SSH session doesn't end it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	in, err := cmd.StdinPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		g.log.Event("event", "report", "status", "skipped", "reason", "can't start the report sender")
		return
	}
	in.Write(b.Encode())
	in.Close()
	cmd.Process.Release()
}

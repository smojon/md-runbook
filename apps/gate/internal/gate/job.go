//go:build unix

package gate

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/config"
	"github.com/smojon/md-runbook/apps/gate/internal/procs"
	"github.com/smojon/md-runbook/apps/gate/internal/report"
	"github.com/smojon/md-runbook/apps/gate/internal/textutil"
)

// ---- Kubernetes Jobs (cells_runner = kubernetes-job) ----
// On the Kubernetes ops host each session's cells run in a Job of their own: a pod of the same
// image, with a service account of their own (job_service_account). The gate's pod keeps the
// report token, the log and the state; its own service account may only run those Jobs. So a
// block can't reach the gate's files, and sessions can't reach each other (docs/design/
// ops-job-per-session.md). Only the transport of separated mode changes: each shell is
//
//	kubectl exec -i -q -n NS POD -c cells -- md-runbook-gate __cells
//
// with the same exec request as through sudo. Across the pod boundary:
//   - exits: the shell appends them to jobExits in the pod, with the run's random number, as in
//     separated mode; one more `__cells follow` streams that file to the gate (and the pod's own
//     log = file: md-runbook-probe's events, which the gate logs again as its own);
//   - a stop request runs `__cells stop` in the pod: the shell's descendants get the signal;
//   - a shell that ends (retired, or by itself) gets `__cells end`: its group and descendants;
//   - the session's end deletes the Job, and with it everything in the pod.
//
// Before the first shell the gate checks both service accounts (SelfSubjectAccessReviews): the
// gate's may run Jobs and nothing of the cells' rights; the cells' may not exec into pods, read
// logs or Secrets, or start workloads in the gate's namespace. A wrong answer: no session.

// In the Job's pod: the exits file and the shells' pids (fresh with each pod). (Variables: tests
// use folders of their own.)
var (
	jobExits  = "/tmp/.md-runbook-gate-exits"
	jobShells = "/tmp/.md-runbook-gate-shells"
)

const (
	// The Job's container, and its limits.
	jobContainer = "cells"
	jobDeadline  = 86400 // a session lasts at most a day
	jobTTL       = 60
	// How long the pod may take to be Ready, and how often the gate asks.
	jobReadyMax  = 3 * time.Minute
	jobReadyPoll = 500 * time.Millisecond
	// The longest line the follower forwards (an exit, or a probe event).
	followLineMax = 16 << 10
)

// kubeJob is the session's Job: how the gate reaches Kubernetes, and what it learned.
type kubeJob struct {
	kubectl string
	env     []string // the gate's kubectl's environment (its kubeconfig: the pod's account)
	podEnv  []string // kubectl's in the Job's pod (the cells' kubeconfig)
	run     runFunc
	quick   runFunc // on the paths that stop and clean up: bounded (killFor)
	exe     string  // this program, in the Job's image too

	ns, context, opsPod, opsUID, image, sa, name string

	ready chan struct{} // closed once the pod is Ready (pod set) or can't be (err set)
	mu    sync.Mutex
	pod   string
	err   string
	noted atomic.Bool
	// closing: the gate ends the follower (its end is no sign of a changed stream).
	closing atomic.Bool

	follow     *exec.Cmd
	followIn   io.WriteCloser
	followDone chan struct{}
	cleaned    sync.Once
}

func (j *kubeJob) kc(args ...string) []string { return append([]string{j.kubectl}, args...) }

// execArgv: the cells' mode in the Job's pod, through kubectl exec (stdin open, no banner).
func (j *kubeJob) execArgv(pod string) []string {
	return j.kc("exec", "-i", "-q", "-n", j.ns, pod, "-c", jobContainer, "--", j.exe, CellsMode)
}

// killFor runs a kubectl of a path that stops or cleans up: at most 5 seconds, and its output
// given up waitDelay later (a cells' mode stopped in the pod can't hold the gate).
func killFor(argv, env []string, stdin []byte) ([]byte, error) {
	return runFor(5*time.Second, argv, env, stdin)
}

// podName: the Job's pod once it is Ready ("" before, or when it can't be).
func (j *kubeJob) podName() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.pod
}

// jobMode: the cells run in a Kubernetes Job.
func (g *Gate) jobMode() bool { return g.cfg.CellsRunner == "kubernetes-job" }

// apart: the cells can't reach the gate's files (separated mode, or a Job): their exits come
// back through a file, and run reports say gate_mode separated.
func (g *Gate) apart() bool { return g.separated() || g.jobMode() }

// checkRunner: the settings of cells_runner, before anything runs. Fail closed.
func (g *Gate) checkRunner() {
	if p := runnerProblem(g.cfg); p != "" {
		g.fatal(p)
	}
}

// runnerProblem: "" when gate.conf's cells_runner settings go together, else what to change.
func runnerProblem(c config.Config) string {
	if c.CellsRunner != "kubernetes-job" {
		if c.JobServiceAccount != "" || c.JobImage != "" {
			return "job_service_account and job_image are for cells_runner = kubernetes-job only: add it, or remove them"
		}
		return ""
	}
	switch {
	case c.JobServiceAccount == "":
		return "cells_runner = kubernetes-job needs job_service_account = NAME: the service account the cells' Jobs run as"
	case c.CellsAccount != "":
		return "cells_runner = kubernetes-job and cells_account don't go together: the Job's pod keeps the cells apart. Remove cells_account"
	case c.Isolation == "scope" || c.Isolation == "bwrap":
		return "isolation = " + c.Isolation + " doesn't go with cells_runner = kubernetes-job: the Job's pod is the isolation. Use auto or none"
	}
	return ""
}

func (g *Gate) newKubeJob() *kubeJob {
	home := os.Getenv("HOME")
	// kubectl as the gate's other programs: from root's system folders only (helpers.go).
	j := &kubeJob{kubectl: g.helper("kubectl"), run: runCmd, quick: killFor, exe: g.plan.exe, sa: g.cfg.JobServiceAccount, ready: make(chan struct{})}
	j.env = []string{"PATH=" + sysPath, "LC_ALL=C", "HOME=" + home}
	j.podEnv = []string{"PATH=" + g.cfg.Path, "LC_ALL=C", "HOME=" + home}
	if g.cfg.Kubeconfig != "" {
		j.podEnv = append(j.podEnv, "KUBECONFIG="+g.cfg.Kubeconfig)
	}
	return j
}

// setupJob: where the gate runs, the check of its service account, the sweep, and the Job. Any
// problem stops the gate before its first shell. The pod starts in the background (prepare).
func (g *Gate) setupJob() {
	j := g.newKubeJob()
	if j.kubectl == "" {
		g.fatal("cells_runner = kubernetes-job: no kubectl in " + sysPath)
	}
	if j.exe == "" {
		g.fatal("cells_runner = kubernetes-job: can't find this program's own path")
	}
	out, err := j.run(j.kc("config", "view", "--minify", "-o", "json"), j.env, nil)
	if err == nil {
		j.context, j.ns, err = parseContext(out)
	}
	if err != nil {
		g.fatal("cells_runner = kubernetes-job: kubectl has no current context (" + err.Error() + "): the gate runs Jobs with its pod's service account (md-runbook-ops-start writes ~/.kube/config)")
	}
	host, _ := os.Hostname()
	out, err = j.run(j.kc("get", "pod", host, "-n", j.ns, "-o", "json"), j.env, nil)
	if err == nil {
		j.opsUID, j.image, err = parseOwnPod(out)
	}
	if err != nil {
		g.fatal("cells_runner = kubernetes-job: this gate runs in no pod " + host + " of namespace " + j.ns + " (" + err.Error() + ")")
	}
	j.opsPod = host
	if g.cfg.JobImage != "" {
		j.image = g.cfg.JobImage
	}
	if p := j.check(opsReviews(j.ns), "", "the gate's service account"); len(p) > 0 {
		msg := "cells_runner = kubernetes-job: " + strings.Join(p, "; ") + ". See apps/ops/README.md (RBAC)."
		g.log.Event("event", "self-check", "status", "refused", "reason", msg)
		g.fatal(msg)
	}
	g.sweepJobs(j)
	j.name = "md-runbook-cells-" + randHex(5)
	spec := jobSpec{Name: j.name, NS: j.ns, OpsPod: j.opsPod, OpsUID: j.opsUID, Image: j.image, SA: j.sa, Context: j.context, GatePID: itoa(os.Getpid())}
	if _, err := j.run(j.kc("create", "-f", "-", "-o", "name"), j.env, jobManifest(spec)); err != nil {
		g.fatal("cells_runner = kubernetes-job: can't create the cells' Job (" + err.Error() + ")")
	}
	g.job = j
	g.exitsPath = jobExits
	g.sepRuns = map[string]sepRun{}
	g.sepExits = map[string]report.Exit{}
	g.log.Event("event", "job", "status", "created", "job", j.name, "namespace", j.ns, "image", j.image, "service_account", j.sa)
	go g.prepareJob(j)
}

// prepareJob: the pod Ready, the cells' service account checked in it (before any block), the
// follower started. Then the shells start; else the session ends.
func (g *Gate) prepareJob(j *kubeJob) {
	t0 := time.Now()
	pod, why := j.waitPod(time.Sleep, time.Now)
	if why == "" {
		if p := j.check(cellsReviews(j.ns), pod, "the cells' service account "+j.sa); len(p) > 0 {
			why = strings.Join(p, "; ") + ". See apps/ops/README.md (RBAC)."
			g.log.Event("event", "self-check", "status", "refused", "reason", "cells_runner = kubernetes-job: "+why)
		}
	}
	if why == "" {
		why = g.startFollower(j, pod)
	}
	j.mu.Lock()
	if why == "" {
		j.pod = pod
	} else {
		j.err = why
	}
	j.mu.Unlock()
	if why == "" {
		g.log.Event("event", "job", "status", "ready", "job", j.name, "pod", pod, "seconds", strconv.FormatFloat(time.Since(t0).Seconds(), 'f', 1, 64))
	} else {
		say("this session's cells can't start: " + why)
		g.log.Event("event", "job", "status", "failed", "job", j.name, "reason", why)
	}
	close(j.ready)
}

// waitPod: the Job's pod once Ready, or why not. At most jobReadyMax; an error that won't pass
// by itself (a bad image, a failed Job) ends it at once.
func (j *kubeJob) waitPod(sleep func(time.Duration), now func() time.Time) (string, string) {
	deadline := now().Add(jobReadyMax)
	for {
		out, err := j.run(j.kc("get", "jobs,pods", "-n", j.ns, "-l", "md-runbook-job="+j.name, "-o", "json"), j.env, nil)
		if err == nil {
			pod, ready, fail := podState(out)
			if fail != "" {
				return "", fail + ": see kubectl -n " + j.ns + " describe job " + j.name
			}
			if ready {
				return pod, ""
			}
		}
		if now().After(deadline) {
			return "", "its pod wasn't ready within 3 minutes: see kubectl -n " + j.ns + " describe job " + j.name
		}
		sleep(jobReadyPoll)
	}
}

// check runs the reviews as the gate's service account (pod "") or, in the Job's pod, as the
// cells'; what is wrong, each as a sentence.
func (j *kubeJob) check(rs []review, pod, who string) []string {
	argv, stdin := j.kc("create", "-f", "-", "-o", "json"), reviewList(rs)
	if pod != "" {
		req := cellsReq{Op: "exec", Argv: argv, Env: j.podEnv}.encode()
		argv, stdin = j.execArgv(pod), append(req, stdin...)
	}
	out, err := j.run(argv, j.env, stdin)
	if err != nil {
		return []string{"can't check " + who + " (" + err.Error() + ")"}
	}
	return reviewProblems(out, rs, who)
}

// sweepJobs deletes the Jobs of this gate's pod whose gate no longer runs (one killed before it
// could delete its own). Best-effort: the owner reference and the deadline catch the rest.
func (g *Gate) sweepJobs(j *kubeJob) {
	out, err := j.run(j.kc("get", "jobs", "-n", j.ns, "-l", "app.kubernetes.io/name=md-runbook-cells,md-runbook-ops-pod="+j.opsUID, "-o", "json"), j.env, nil)
	if err != nil {
		return
	}
	names := orphanJobs(out, gateAlive)
	if len(names) == 0 {
		return
	}
	_, err = j.run(j.kc(append([]string{"delete", "job", "-n", j.ns, "--ignore-not-found", "--wait=false"}, names...)...), j.env, nil)
	status := "swept"
	if err != nil {
		status = "sweep-failed"
	}
	g.log.Event("event", "job", "status", status, "jobs", strings.Join(names, " "))
}

// gateAlive: pid is a running gate (this program), or a process the gate can't look into.
func gateAlive(pid int) bool {
	if pid <= 1 {
		return false
	}
	if err := syscall.Kill(pid, 0); err != nil && err != syscall.EPERM {
		return false
	}
	x := procs.Exe(pid)
	return x == "" || x == procs.Exe(os.Getpid())
}

// jobCleanup: the follower, then the Job (its pod goes with it). Once.
func (g *Gate) jobCleanup() {
	j := g.job
	if j == nil {
		return
	}
	j.cleaned.Do(func() {
		j.closing.Store(true)
		if j.follow != nil && j.follow.Process != nil {
			syscall.Kill(-j.follow.Process.Pid, syscall.SIGKILL)
		}
		_, err := j.quick(j.kc("delete", "job", j.name, "-n", j.ns, "--ignore-not-found", "--wait=false"), j.env, nil)
		status := "deleted"
		if err != nil {
			status = "delete-failed"
		}
		g.log.Event("event", "job", "status", status, "job", j.name)
	})
}

// ---- the shells, in the Job's pod ----

// startJobShell: a shell that starts once the pod is Ready. Its pipe takes the exec request now
// and the cells from then on, so that nothing waits for the pod but the cells themselves.
func (g *Gate) startJobShell(i int) {
	g.shells++
	r, w, err := os.Pipe()
	if err != nil {
		say("can't create a pipe")
		g.exit(2)
	}
	sh := &shell{n: g.shells, w: w, done: make(chan struct{}), r: r, abort: make(chan struct{})}
	req := cellsReq{Op: "exec", Argv: append([]string{g.cellsBin}, g.cellsArgs...), Env: g.cellsEnv(), Dir: g.cellsDir(), Shell: sh.n}
	w.Write(req.encode())
	g.liveMu.Lock()
	g.live[sh] = true
	g.liveMu.Unlock()
	go g.runJobShell(sh)
	s := &g.slots[i]
	s.sh, s.hash, s.dirty = sh, "", false
}

// runJobShell waits for the pod, runs the shell there, and then does what the watcher does.
func (g *Gate) runJobShell(sh *shell) {
	j := g.job
	select {
	case <-j.ready:
	case <-sh.abort:
	}
	sh.mu.Lock()
	pod := j.podName()
	var cmd *exec.Cmd
	var err error
	if !sh.aborted && pod != "" {
		cmd = exec.Command(j.kubectl, j.execArgv(pod)[1:]...)
		cmd.Env = j.env
		cmd.WaitDelay = waitDelay
		cmd.Stdin = sh.r
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		err = cmd.Start()
	}
	sh.r.Close()
	if cmd == nil || err != nil {
		sh.aborted = true
		sh.mu.Unlock()
		if err != nil {
			say("can't start " + j.kubectl)
		}
		g.shellEnded(sh)
		return
	}
	sh.started = true
	pid := cmd.Process.Pid
	sh.leader, sh.pid, sh.pgid = pid, pid, pid
	sh.mu.Unlock()
	cmd.Wait()
	g.stopShells(sh)
	g.shellEnded(sh)
}

// shellEnded: a shell is gone. One that wasn't retired ends the session.
func (g *Gate) shellEnded(sh *shell) {
	g.liveMu.Lock()
	delete(g.live, sh)
	g.liveMu.Unlock()
	if !sh.retired.Load() {
		select {
		case g.endCh <- struct{}{}:
		default:
		}
	}
	close(sh.done)
}

// abortJobShell: a shell that hasn't started won't.
func (sh *shell) abortJobShell() {
	sh.mu.Lock()
	defer sh.mu.Unlock()
	if !sh.started {
		sh.abortOnce.Do(func() { close(sh.abort) })
	}
}

// jobStopShells: shells not started are dropped; the others' groups and descendants end in the
// pod (not when the whole session ends: deleting the Job ends them).
func (g *Gate) jobStopShells(shs []*shell) {
	var remote []int
	for _, sh := range shs {
		sh.mu.Lock()
		started := sh.started
		sh.mu.Unlock()
		if !started {
			sh.abortJobShell()
		} else if !g.ending.Load() {
			remote = append(remote, sh.n)
		}
	}
	if pod := g.job.podName(); len(remote) > 0 && pod != "" {
		g.job.quick(g.job.execArgv(pod), g.job.env, cellsReq{Op: "end", Shells: remote}.encode())
	}
}

// noteWaiting: once, while the first block waits for the pod, a line that says why.
func (j *kubeJob) noteWaiting() {
	select {
	case <-j.ready:
		return
	default:
	}
	if j.noted.CompareAndSwap(false, true) {
		say("this session's blocks run in a Kubernetes Job of their own (" + j.name + "): the first one waits for its pod")
	}
}

// jobStopRequest: a stop request for a session whose cells run in a Job: `__cells stop` in its
// pod signals the descendants of its current shell.
func (g *Gate) jobStopRequest(ns, name, n, sig string) {
	if !config.ValidKubeName(ns) || !config.ValidKubeName(name) || !textutil.IsNum(n) {
		g.fatal("bad stop request")
	}
	g.plan = g.basePlan()
	j := g.newKubeJob()
	j.ns, j.name = ns, name
	g.log.Event("event", "stop", "shell", name+"/"+n, "signal", sig)
	if j.kubectl == "" || j.exe == "" {
		return
	}
	out, err := j.quick(j.kc("get", "jobs,pods", "-n", ns, "-l", "md-runbook-job="+name, "-o", "json"), j.env, nil)
	if err != nil {
		return
	}
	pod, _, _ := podState(out)
	if pod == "" {
		return
	}
	s := syscall.SIGTERM
	if sig == "KILL" {
		s = syscall.SIGKILL
	}
	j.quick(j.execArgv(pod), j.env, cellsReq{Op: "stop", Shell: atoi(n), Sig: int(s)}.encode())
}

// ---- exits and probe events, from the pod ----

// startFollower: `__cells follow` in the pod, read until it ends ("" when it started).
func (g *Gate) startFollower(j *kubeJob, pod string) string {
	cmd := exec.Command(j.kubectl, j.execArgv(pod)[1:]...)
	cmd.Env = j.env
	cmd.WaitDelay = waitDelay
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	in, err := cmd.StdinPipe()
	if err != nil {
		return "can't start " + j.kubectl
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return "can't start " + j.kubectl
	}
	if err := cmd.Start(); err != nil {
		return "can't start " + j.kubectl
	}
	in.Write(cellsReq{Op: "follow", Paths: []string{jobExits}, Events: true}.encode())
	j.follow, j.followIn, j.followDone = cmd, in, make(chan struct{})
	go func() {
		g.followLines(out)
		cmd.Wait()
		close(j.followDone)
	}()
	return ""
}

// finishFollower: the shells are done; what the follower still has, then its end (at most 5
// seconds).
func (g *Gate) finishFollower() {
	j := g.job
	if j == nil || j.follow == nil {
		return
	}
	j.closing.Store(true)
	j.followIn.Close()
	select {
	case <-j.followDone:
	case <-time.After(5 * time.Second):
		syscall.Kill(-j.follow.Process.Pid, syscall.SIGKILL)
	}
}

// followLines reads the follower: `0<TAB>LINE` from the exits file, `1<TAB>LINE` from the pod's
// log file, `!N<TAB>WHY` when file N changed in a way no shell writes (it got shorter, a line too
// long). A block can write into the pod's files and into that stream. So, as for separated mode's
// exits file (review of 0.28.0, M1), anything but an expected exit line ends the session and no
// run report goes out: a line of the stream that doesn't parse, an exit line junkExits refuses,
// a changed exits file, more than exitsMax, or the stream's end before the gate ends it. Probe
// events are only logged again, under the gate's own names, when they are probe events of this
// session's runs; other lines of that file are dropped.
func (g *Gate) followLines(r io.Reader) {
	br := bufio.NewReaderSize(r, followLineMax+64)
	var read int64
	junk := func(why string) {
		g.exitsMu.Lock()
		g.junkExits(why)
		g.exitsMu.Unlock()
	}
	for {
		line, err := br.ReadSlice('\n')
		read += int64(len(line))
		switch {
		case err == bufio.ErrBufferFull:
			junk("the stream from the pod has a line over " + itoa(followLineMax) + " bytes")
			io.Copy(io.Discard, br)
			return
		case err != nil:
			if !g.job.closing.Load() {
				junk("the exits follower in the pod ended")
			}
			return
		case read > exitsMax:
			junk("over " + itoa(exitsMax>>20) + " MiB from the pod")
			io.Copy(io.Discard, br)
			return
		}
		src, text, ok := strings.Cut(strings.TrimSuffix(string(line), "\n"), "\t")
		g.exitsMu.Lock()
		switch {
		case !ok:
			g.junkExits("a line from the pod that doesn't parse")
		case src == "0" && len(text) > 4096:
			g.junkExits("a line is over 4096 bytes")
		case src == "0":
			g.exitLine(text)
		case src == "!0":
			g.junkExits(textutil.Cut(text, 200))
		case src == "1":
			runs := map[string]bool{}
			for _, r := range g.sepRuns {
				runs[r.rid] = true
			}
			if kv, ok := probeEvent(text, runs); ok {
				g.log.Event(kv...)
			}
		case src == "!1":
		default:
			g.junkExits("a line from the pod that doesn't parse")
		}
		g.exitsMu.Unlock()
	}
}

// What a probe event may say, in md-runbook-probe's order.
var probeKeys = []string{"run", "target", "address", "result", "detail", "days_left", "not_after", "cert_sha256"}

// probeEvent: a line of the pod's log as the gate logs it: an md-runbook-probe event (string
// values only, each cut to 1024 bytes) of no run, or of one of this session's. The time, account,
// key and client are the gate's.
func probeEvent(line string, runs map[string]bool) ([]string, bool) {
	var m map[string]any
	if len(line) > 8192 || json.Unmarshal([]byte(line), &m) != nil || m["event"] != "probe" {
		return nil, false
	}
	kv := []string{"event", "probe"}
	for _, k := range probeKeys {
		v, ok := m[k].(string)
		if !ok || v == "" {
			continue
		}
		if k == "run" && !runs[v] {
			return nil, false
		}
		kv = append(kv, k, textutil.Cut(v, 1024))
	}
	return kv, true
}

// ---- the cells' mode in the Job's pod ----

func shellFile(n int) string { return jobShells + "/" + itoa(n) }

// shellPid: the pid shell n wrote (0 for none).
func shellPid(n int) int {
	if n <= 0 {
		return 0
	}
	b, err := os.ReadFile(shellFile(n))
	if err != nil {
		return 0
	}
	s := strings.TrimSpace(string(b))
	if !textutil.IsPID(s) {
		return 0
	}
	return atoi(s)
}

// markShell: the exec request of a shell in the pod: a session (and group) of its own, and its
// pid where stop and end find it.
func markShell(n int) {
	syscall.Setsid()
	if os.MkdirAll(jobShells, 0o700) == nil {
		os.WriteFile(shellFile(n), []byte(itoa(os.Getpid())+"\n"), 0o600)
	}
}

// stopShell: sig to every process under shell n (never the shell itself).
func stopShell(n int, sig syscall.Signal) int {
	pid := shellPid(n)
	if pid <= 1 {
		return 1
	}
	list, err := procs.List()
	if err != nil {
		return 1
	}
	for _, p := range procs.Descendants(list, pid) {
		syscall.Kill(p, sig)
	}
	return 0
}

// endShells: the shells' groups and descendants get TERM; what is left a second later, KILL.
func endShells(ns []int) {
	var pids []int
	for _, n := range ns {
		if p := shellPid(n); p > 1 {
			pids = append(pids, p)
		}
		os.Remove(shellFile(n))
	}
	if len(pids) == 0 {
		return
	}
	signal := func(sig syscall.Signal) bool {
		hit := false
		list, _ := procs.List()
		for _, p := range pids {
			targets := append([]int{-p, p}, procs.Descendants(list, p)...)
			for _, t := range targets {
				if syscall.Kill(t, sig) == nil {
					hit = true
				}
			}
		}
		return hit
	}
	if !signal(syscall.SIGTERM) {
		return
	}
	for i := 0; i < 5; i++ {
		nap()
		if !signal(0) {
			return
		}
	}
	signal(syscall.SIGKILL)
}

// followFiles writes each new complete line of the files as `INDEX<TAB>LINE`, until in ends
// (then once more). A file that doesn't exist yet is read once it does. A file that shrank, or a
// line longer than followLineMax, is said as `!INDEX<TAB>WHY` (the gate ends the session for the
// exits file), and then read on from the file's start, or the next line.
func followFiles(paths []string, in io.Reader, out io.Writer, pause time.Duration) {
	done := make(chan struct{})
	go func() {
		io.Copy(io.Discard, in)
		close(done)
	}()
	off := make([]int64, len(paths))
	part := make([][]byte, len(paths))
	skip := make([]bool, len(paths))
	pass := func() {
		for i, p := range paths {
			f, err := os.Open(p)
			if err != nil {
				continue
			}
			if st, err := f.Stat(); err == nil && st.Size() < off[i] {
				out.Write([]byte("!" + itoa(i) + "\tit got shorter\n"))
				off[i], part[i], skip[i] = 0, nil, false
			}
			buf := make([]byte, 64<<10)
			for {
				n, _ := f.ReadAt(buf, off[i])
				if n <= 0 {
					break
				}
				off[i] += int64(n)
				data := buf[:n]
				for len(data) > 0 {
					k := bytes.IndexByte(data, '\n')
					if k < 0 {
						if !skip[i] {
							part[i] = append(part[i], data...)
							if len(part[i]) > followLineMax {
								out.Write([]byte("!" + itoa(i) + "\ta line is over " + itoa(followLineMax) + " bytes\n"))
								part[i], skip[i] = nil, true
							}
						}
						break
					}
					switch {
					case skip[i]:
					case len(part[i])+k > followLineMax:
						out.Write([]byte("!" + itoa(i) + "\ta line is over " + itoa(followLineMax) + " bytes\n"))
					default:
						line := append(append([]byte(itoa(i)+"\t"), part[i]...), data[:k]...)
						out.Write(append(line, '\n'))
					}
					part[i], skip[i] = nil, false
					data = data[k+1:]
				}
			}
			f.Close()
		}
	}
	for {
		finished := false
		select {
		case <-done:
			finished = true
		default:
		}
		pass()
		if finished {
			return
		}
		select {
		case <-done:
		case <-time.After(pause):
		}
	}
}

// followPaths: the follow request's files, and with Events the pod's own log = file (where
// md-runbook-probe writes its events).
func followPaths(req cellsReq) []string {
	paths := append([]string{}, req.Paths...)
	if req.Events {
		c := config.Defaults()
		if c.ReadFile(config.Default) == nil && strings.HasPrefix(c.Log, "/") {
			paths = append(paths, c.Log)
		}
	}
	return paths
}

// ---- what the gate sends and reads, as data (tested) ----

// jobSpec: what the Job is made of.
type jobSpec struct {
	Name, NS, OpsPod, OpsUID, Image, SA, Context, GatePID string
}

// jobManifest: the cells' Job, as JSON for kubectl create. Pod Security "restricted": non-root,
// no privilege escalation, no capabilities, seccomp RuntimeDefault; a read-only root file
// system with emptyDirs for the home folder, /tmp and the probe's log.
func jobManifest(s jobSpec) []byte {
	type obj = map[string]any
	labels := obj{"app.kubernetes.io/name": "md-runbook-cells", "app.kubernetes.io/managed-by": "md-runbook-gate", "md-runbook-job": s.Name, "md-runbook-ops-pod": s.OpsUID, "md-runbook-gate-pid": s.GatePID}
	mounts := []obj{{"name": "home", "mountPath": "/home/ops"}, {"name": "tmp", "mountPath": "/tmp"}, {"name": "log", "mountPath": "/var/log/md-runbook"}}
	volumes := []obj{{"name": "home", "emptyDir": obj{}}, {"name": "tmp", "emptyDir": obj{}}, {"name": "log", "emptyDir": obj{}}}
	container := obj{
		"name":            jobContainer,
		"image":           s.Image,
		"imagePullPolicy": "IfNotPresent",
		"command":         []string{"/usr/bin/tini", "--", "/usr/local/bin/md-runbook-ops-start", "cells"},
		"env":             []obj{{"name": "CLUSTER_NAME", "value": s.Context}},
		"securityContext": obj{"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "runAsNonRoot": true, "capabilities": obj{"drop": []string{"ALL"}}},
		"readinessProbe":  obj{"exec": obj{"command": []string{"/bin/sh", "-c", `test -s "$HOME/.kube/config"`}}, "periodSeconds": 1},
		"resources":       obj{"requests": obj{"cpu": "50m", "memory": "64Mi"}, "limits": obj{"memory": "512Mi", "ephemeral-storage": "1Gi"}},
		"volumeMounts":    mounts,
	}
	pod := obj{
		"restartPolicy":                 "Never",
		"serviceAccountName":            s.SA,
		"automountServiceAccountToken":  true,
		"enableServiceLinks":            false,
		"terminationGracePeriodSeconds": 2,
		"securityContext":               obj{"runAsNonRoot": true, "runAsUser": 10001, "runAsGroup": 10001, "fsGroup": 10001, "seccompProfile": obj{"type": "RuntimeDefault"}},
		"containers":                    []obj{container},
		"volumes":                       volumes,
	}
	job := obj{
		"apiVersion": "batch/v1",
		"kind":       "Job",
		"metadata": obj{
			"name": s.Name, "namespace": s.NS, "labels": labels,
			// Deleting the gate's pod deletes its Jobs.
			"ownerReferences": []obj{{"apiVersion": "v1", "kind": "Pod", "name": s.OpsPod, "uid": s.OpsUID}},
		},
		"spec": obj{
			"backoffLimit":            0,
			"activeDeadlineSeconds":   jobDeadline,
			"ttlSecondsAfterFinished": jobTTL,
			"template":                obj{"metadata": obj{"labels": obj{"app.kubernetes.io/name": "md-runbook-cells", "md-runbook-job": s.Name}}, "spec": pod},
		},
	}
	data, _ := json.Marshal(job)
	return data
}

// kubeObj: what the gate reads of the objects kubectl prints.
type kubeObj struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name              string            `json:"name"`
		UID               string            `json:"uid"`
		Labels            map[string]string `json:"labels"`
		DeletionTimestamp string            `json:"deletionTimestamp"`
	} `json:"metadata"`
	Spec struct {
		Containers []struct {
			Name  string `json:"name"`
			Image string `json:"image"`
		} `json:"containers"`
		ResourceAttributes map[string]string `json:"resourceAttributes"`
	} `json:"spec"`
	Status struct {
		Phase      string `json:"phase"`
		Allowed    bool   `json:"allowed"`
		Conditions []struct {
			Type    string `json:"type"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
		} `json:"conditions"`
		ContainerStatuses []struct {
			State struct {
				Waiting *struct {
					Reason  string `json:"reason"`
					Message string `json:"message"`
				} `json:"waiting"`
				Terminated *struct {
					Reason   string `json:"reason"`
					ExitCode int    `json:"exitCode"`
				} `json:"terminated"`
			} `json:"state"`
		} `json:"containerStatuses"`
	} `json:"status"`
	Items []kubeObj `json:"items"`
}

// kubeObjects: the objects in kubectl's output: one or more JSON values, each an object or a
// List of them.
func kubeObjects(out []byte) ([]kubeObj, error) {
	var objs []kubeObj
	d := json.NewDecoder(bytes.NewReader(out))
	for {
		var o kubeObj
		err := d.Decode(&o)
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if o.Kind == "List" || strings.HasSuffix(o.Kind, "List") {
			objs = append(objs, o.Items...)
		} else {
			objs = append(objs, o)
		}
	}
	return objs, nil
}

// parseContext: kubectl config view --minify: the current context and its namespace.
func parseContext(out []byte) (context, ns string, err error) {
	var c struct {
		Current  string `json:"current-context"`
		Contexts []struct {
			Name    string `json:"name"`
			Context struct {
				Namespace string `json:"namespace"`
			} `json:"context"`
		} `json:"contexts"`
	}
	if err := json.Unmarshal(out, &c); err != nil {
		return "", "", errors.New("can't read kubectl config view")
	}
	if c.Current == "" {
		return "", "", errors.New("no current-context")
	}
	ns = "default"
	for _, x := range c.Contexts {
		if x.Name == c.Current && x.Context.Namespace != "" {
			ns = x.Context.Namespace
		}
	}
	if !config.ValidKubeName(ns) {
		return "", "", errors.New("namespace " + ns)
	}
	return c.Current, ns, nil
}

// parseOwnPod: the gate's pod: its uid, and its image (the container ops, else the only one).
func parseOwnPod(out []byte) (uid, image string, err error) {
	objs, err := kubeObjects(out)
	if err != nil || len(objs) != 1 || objs[0].Kind != "Pod" || objs[0].Metadata.UID == "" {
		return "", "", errors.New("not a pod")
	}
	p := objs[0]
	cs := p.Spec.Containers
	for _, c := range cs {
		if c.Name == "ops" {
			image = c.Image
		}
	}
	if image == "" && len(cs) == 1 {
		image = cs[0].Image
	}
	if image == "" {
		return "", "", errors.New("it has no container ops: set job_image")
	}
	if !config.ValidImage(image) {
		return "", "", errors.New("its image " + image + " is not one the gate can name: set job_image")
	}
	return p.Metadata.UID, image, nil
}

// Waiting reasons that won't pass by themselves.
var podFatal = map[string]bool{"ImagePullBackOff": true, "InvalidImageName": true, "ErrImageNeverPull": true, "CreateContainerConfigError": true, "CreateContainerError": true, "CrashLoopBackOff": true}

// podState: the Job's pod (jobs,pods with its label): its name, whether it is Ready, and why it
// never will be ("" while it may).
func podState(out []byte) (pod string, ready bool, fail string) {
	objs, err := kubeObjects(out)
	if err != nil {
		return "", false, ""
	}
	for _, o := range objs {
		if o.Kind != "Job" {
			continue
		}
		for _, c := range o.Status.Conditions {
			if c.Type == "Failed" && c.Status == "True" {
				return "", false, "the Job failed (" + c.Reason + ": " + textutil.Cut(c.Message, 300) + ")"
			}
		}
	}
	for _, o := range objs {
		if o.Kind != "Pod" || o.Metadata.DeletionTimestamp != "" {
			continue
		}
		pod = o.Metadata.Name
		switch o.Status.Phase {
		case "Failed", "Succeeded":
			return pod, false, "its pod ended (" + o.Status.Phase + ")"
		}
		for _, cs := range o.Status.ContainerStatuses {
			if w := cs.State.Waiting; w != nil && podFatal[w.Reason] {
				return pod, false, "its pod can't start (" + w.Reason + ": " + textutil.Cut(w.Message, 300) + ")"
			}
			if t := cs.State.Terminated; t != nil {
				return pod, false, "its pod's container ended (" + t.Reason + ", exit " + itoa(t.ExitCode) + ")"
			}
		}
		for _, c := range o.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" && o.Status.Phase == "Running" {
				return pod, true, ""
			}
		}
	}
	return pod, false, ""
}

// orphanJobs: the Jobs whose gate (label md-runbook-gate-pid) no longer runs.
func orphanJobs(out []byte, alive func(pid int) bool) []string {
	objs, err := kubeObjects(out)
	if err != nil {
		return nil
	}
	var names []string
	for _, o := range objs {
		if o.Kind != "Job" || o.Metadata.DeletionTimestamp != "" || !config.ValidKubeName(o.Metadata.Name) {
			continue
		}
		pid := o.Metadata.Labels["md-runbook-gate-pid"]
		if textutil.IsPID(pid) && alive(atoi(pid)) {
			continue
		}
		names = append(names, o.Metadata.Name)
	}
	return names
}

// review: may the account VERB GROUP/RESOURCE/SUB in NS ("" for every namespace, or a
// cluster-wide resource)? want is the answer the gate needs.
type review struct {
	verb, group, resource, sub, ns string
	want                           bool
}

func (r review) key() string {
	return r.verb + "|" + r.group + "|" + r.resource + "|" + r.sub + "|" + r.ns
}

func (r review) String() string {
	s := r.verb + " " + r.resource
	if r.sub != "" {
		s += "/" + r.sub
	}
	if r.group != "" {
		s += " (" + r.group + ")"
	}
	if r.ns == "" {
		return s + " in every namespace"
	}
	return s + " in " + r.ns
}

// reviewList: the reviews as one List of SelfSubjectAccessReviews.
func reviewList(rs []review) []byte {
	items := make([]map[string]any, 0, len(rs))
	for _, r := range rs {
		attrs := map[string]string{"verb": r.verb, "resource": r.resource}
		if r.group != "" {
			attrs["group"] = r.group
		}
		if r.sub != "" {
			attrs["subresource"] = r.sub
		}
		if r.ns != "" {
			attrs["namespace"] = r.ns
		}
		items = append(items, map[string]any{"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview", "spec": map[string]any{"resourceAttributes": attrs}})
	}
	data, _ := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "List", "items": items})
	return data
}

// reviewProblems: each review whose answer is not the one wanted (or missing), as a sentence.
func reviewProblems(out []byte, rs []review, who string) []string {
	objs, err := kubeObjects(out)
	if err != nil {
		return []string{"can't read the answers about " + who}
	}
	got := map[string]bool{}
	for _, o := range objs {
		a := o.Spec.ResourceAttributes
		if o.Kind != "SelfSubjectAccessReview" || a == nil {
			continue
		}
		r := review{verb: a["verb"], group: a["group"], resource: a["resource"], sub: a["subresource"], ns: a["namespace"]}
		got[r.key()] = o.Status.Allowed
	}
	var p []string
	for _, r := range rs {
		allowed, ok := got[r.key()]
		switch {
		case !ok:
			p = append(p, "no answer whether "+who+" may "+r.String())
		case allowed && !r.want:
			p = append(p, who+" may "+r.String())
		case !allowed && r.want:
			p = append(p, who+" may not "+r.String())
		}
	}
	return p
}

// opsReviews: the gate's service account runs the Jobs in its namespace, and holds none of the
// cells' rights (reading across namespaces, Secrets, workloads, tokens, roles).
func opsReviews(ns string) []review {
	return []review{
		{"create", "batch", "jobs", "", ns, true},
		{"list", "batch", "jobs", "", ns, true},
		{"delete", "batch", "jobs", "", ns, true},
		{"get", "", "pods", "", ns, true},
		{"list", "", "pods", "", ns, true},
		{"create", "", "pods", "exec", ns, true},
		{"list", "", "pods", "", "", false},
		{"get", "", "secrets", "", ns, false},
		{"create", "", "pods", "", ns, false},
		{"patch", "apps", "deployments", "", ns, false},
		{"create", "", "serviceaccounts", "token", ns, false},
		{"create", "rbac.authorization.k8s.io", "rolebindings", "", ns, false},
		{"impersonate", "", "serviceaccounts", "", "", false},
	}
}

// cellsReviews: in the gate's namespace the cells' service account can't reach the gate's pod
// (exec, attach, its log: the gate's events), its Secrets and ConfigMaps (host key, gate.conf,
// keys), nor run anything as another account there (workloads, tokens, roles).
func cellsReviews(ns string) []review {
	no := func(verb, group, resource, sub string) review { return review{verb, group, resource, sub, ns, false} }
	return []review{
		no("create", "", "pods", "exec"),
		no("get", "", "pods", "exec"),
		no("create", "", "pods", "attach"),
		no("get", "", "pods", "log"),
		no("get", "", "secrets", ""),
		no("list", "", "secrets", ""),
		no("create", "", "pods", ""),
		no("patch", "", "pods", ""),
		no("create", "batch", "jobs", ""),
		no("create", "batch", "cronjobs", ""),
		no("create", "apps", "deployments", ""),
		no("patch", "apps", "deployments", ""),
		no("create", "apps", "statefulsets", ""),
		no("create", "apps", "daemonsets", ""),
		no("create", "apps", "replicasets", ""),
		no("create", "", "serviceaccounts", "token"),
		no("update", "", "configmaps", ""),
		no("patch", "", "configmaps", ""),
		no("create", "rbac.authorization.k8s.io", "rolebindings", ""),
		{"impersonate", "", "serviceaccounts", "", "", false},
	}
}

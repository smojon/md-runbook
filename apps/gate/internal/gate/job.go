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
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/config"
	"github.com/smojon/md-runbook/apps/gate/internal/procs"
	"github.com/smojon/md-runbook/apps/gate/internal/proto"
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
// logs, Secrets or ConfigMaps, or start workloads in the gate's namespace, and every namespace
// where they may start or change workloads must enforce Pod Security baseline or restricted
// (else a privileged pod reaches the node, and through it the gate's pod). No kube-* namespace
// may be among them, labels or not: their service accounts run the cluster. Where they may
// change workloads, the admission policy md-runbook-ops-workloads must be bound (it keeps a
// patch from changing a pod template's service account, volumes or the like). The gate's
// namespace must hold the ops host alone: no other app's pods or service accounts. The admission
// policy md-runbook-ops-jobs must refuse any other Job from the gate's account (a dry run as its
// own account). A wrong answer: no session.
//
// When the follower's stdin ends (the session ended, or the gate is gone) it ends the pod: a
// dead-man switch, so that nothing of a session outlives it by more than the pod's grace period.

// In the Job's pod: the exits file and the shells' pids (fresh with each pod). (Variables: tests
// use folders of their own.)
var (
	jobExits  = "/tmp/.md-runbook-gate-exits"
	jobShells = "/tmp/.md-runbook-gate-shells"
)

const (
	// The Job's container, and its limits.
	jobContainer = "cells"
	// A cap on a live session (an on-call window stays open for hours). Leftovers don't wait for
	// it: the follower's dead-man switch ends the pod when the gate goes.
	jobDeadline = 86400
	jobTTL      = 60
	// How long the pod may take to be Ready, and how often the gate asks. The app waits for the
	// pod at most POD_WAIT_MAX_MS (packages/ssh/src/remoteShell.ts, 5 min): keep that above this
	// plus the kubectl calls around it (podWaitWorst). Raise both together: TestPodWaitBound.
	jobReadyMax  = 3 * time.Minute
	jobReadyPoll = 500 * time.Millisecond
	// The longest line the follower forwards (an exit, or a probe event).
	followLineMax = 16 << 10
)

// podWaitWorst: the longest a request can wait for the pod before its final notice. The last
// look of waitPod starts just before jobReadyMax ends; then the checks in the pod: check (1 call)
// and checkNamespaces (2). Each kubectl call: runLimit, then waitDelay for its output.
const podWaitWorst = jobReadyMax + jobReadyPoll + 4*(runLimit+waitDelay)

// kubeJob is the session's Job: how the gate reaches Kubernetes, and what it learned.
type kubeJob struct {
	kubectl string
	env     []string // the gate's kubectl's environment (its kubeconfig: the pod's account)
	podEnv  []string // kubectl's in the Job's pod (the cells' kubeconfig)
	run     runFunc
	quick   runFunc // on the paths that stop and clean up: bounded (killFor)
	exe     string  // this program, in the Job's image too

	ns, context, opsPod, opsUID, opsSA, image, sa, name string
	// workloads: why md-runbook-ops-workloads isn't in force ("" when it is), asked before the
	// Job (so the pod's wait has no call more); it counts once the cells may change workloads.
	workloads string

	ready chan struct{} // closed once the pod is Ready (pod set) or can't be (err set)
	mu    sync.Mutex
	pod   string
	err   string
	// What the client hears of the pod's start (under mu, so that no `starting` follows the
	// end): out is the gate's stderr. notices: its hello takes pod notices (protocol 4); announced:
	// its hello said PodJob, so it reads notices until `ready` or `failed`; final: that one was
	// said; settled: the pod is Ready or won't be; waiting: a request heard `starting`; queued: a
	// request went to a shell before the pod was ready; answered: the client sent a line after
	// the pod settled (it had that request's reply), or that request's exit came back; noted: the
	// gate's line for other clients was said.
	out                                                                  io.Writer
	notices, announced, final, settled, waiting, queued, answered, noted bool
	// queuedRun: the run number of the queued request when it is a signed run ("" otherwise, or
	// when more than one was queued); ran is closed once its exit comes back (ranExit).
	queuedRun string
	ran       chan struct{}
	// settledAt: when the pod settled, and the waiting request heard so (its final notice, or the
	// gate's line before protocol 4, comes at that moment).
	settledAt time.Time
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
	if p := runnerProblem(g.cfg, g.configPath); p != "" {
		g.fatal(p)
	}
}

// runnerProblem: "" when gate.conf's cells_runner settings go together, else what to change.
// configPath: gate.conf, on the ops host a ConfigMap: report_token_file must not be next to it
// (a Secret, mounted on a folder of its own).
func runnerProblem(c config.Config, configPath string) string {
	if c.CellsRunner != "kubernetes-job" {
		if c.JobServiceAccount != "" || c.JobImage != "" {
			return "job_service_account and job_image are for cells_runner = kubernetes-job only: add it, or remove them"
		}
		return ""
	}
	switch {
	case c.JobServiceAccount == "":
		return "cells_runner = kubernetes-job needs job_service_account = NAME: the service account the cells' Jobs run as"
	case len(c.CellsPool()) > 0:
		return "cells_runner = kubernetes-job and " + c.CellsKey() + " don't go together: the Job's pod keeps the cells apart. Remove " + c.CellsKey()
	case c.Isolation == "scope" || c.Isolation == "bwrap":
		return "isolation = " + c.Isolation + " doesn't go with cells_runner = kubernetes-job: the Job's pod is the isolation. Use auto or none"
	case c.ReportToken != "" && strings.HasPrefix(filepath.Clean(c.ReportToken), filepath.Dir(filepath.Clean(configPath))+"/"):
		return "report_token_file = " + c.ReportToken + " is in the folder of " + configPath + ", a ConfigMap on the ops host: put the token in a Secret mounted on a folder of its own (apps/ops/README.md)"
	}
	return ""
}

func (g *Gate) newKubeJob() *kubeJob {
	home := os.Getenv("HOME")
	// kubectl as the gate's other programs: from root's system folders only (helpers.go).
	j := &kubeJob{kubectl: g.helper("kubectl"), run: runCmd, quick: killFor, exe: g.plan.exe, sa: g.cfg.JobServiceAccount, ready: make(chan struct{}), out: os.Stderr}
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
	if !config.ValidKubeName(host) {
		g.fatal("cells_runner = kubernetes-job: this host's name " + host + " is no pod name")
	}
	out, err = j.run(j.kc("get", "pod", host, "-n", j.ns, "-o", "json"), j.env, nil)
	if err == nil {
		j.opsUID, j.image, err = parseOwnPod(out)
	}
	if err != nil {
		g.fatal("cells_runner = kubernetes-job: this gate runs in no pod " + host + " of namespace " + j.ns + " (" + err.Error() + ")")
	}
	j.opsPod, j.opsSA = host, podServiceAccount(out)
	if g.cfg.JobImage != "" {
		j.image = g.cfg.JobImage
	}
	if p := j.check(opsReviews(j.ns), "", "the gate's service account"); len(p) > 0 {
		msg := "cells_runner = kubernetes-job: " + strings.Join(p, "; ") + ". See apps/ops/README.md (RBAC)."
		g.log.Event("event", "self-check", "status", "refused", "reason", msg)
		g.fatal(msg)
	}
	for _, check := range []func() string{j.checkOwnNamespace, j.checkPolicy} {
		if p := check(); p != "" {
			msg := "cells_runner = kubernetes-job: " + p
			g.log.Event("event", "self-check", "status", "refused", "reason", msg)
			g.fatal(msg)
		}
	}
	j.workloads = j.checkWorkloadPolicy()
	g.sweepJobs(j)
	j.name = "md-runbook-cells-" + randHex(5)
	spec := jobSpec{Name: j.name, NS: j.ns, OpsPod: j.opsPod, OpsUID: j.opsUID, Image: j.image, SA: j.sa, Context: j.context, GateID: gateID(os.Getpid())}
	if _, err := j.run(j.kc("create", "-f", "-", "-o", "name"), j.env, jobManifest(spec)); err != nil {
		g.fatal("cells_runner = kubernetes-job: " + createProblem(err))
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
		p := j.check(cellsReviews(j.ns), pod, "the cells' service account "+j.sa)
		if len(p) == 0 {
			p = j.checkNamespaces(pod)
		}
		if len(p) > 0 {
			why = strings.Join(p, "; ") + ". See apps/ops/README.md (RBAC)."
			g.log.Event("event", "self-check", "status", "refused", "reason", "cells_runner = kubernetes-job: "+why)
		}
	}
	if why == "" {
		why = g.startFollower(j, pod)
	}
	if why == "" {
		g.log.Event("event", "job", "status", "ready", "job", j.name, "pod", pod, "seconds", strconv.FormatFloat(time.Since(t0).Seconds(), 'f', 1, 64))
	} else {
		g.log.Event("event", "job", "status", "failed", "job", j.name, "reason", why)
	}
	j.settle(pod, why)
}

// settle: the pod is Ready (why "") or won't be. A request that waits for it hears so first
// (PodReady, or PodFailed with the reason); a client told PodJob hears a failure at once (no
// shell will print anything); else a failure is the gate's line, as before protocol 4. Then the
// shells start, or end. A client told PodJob that waits for nothing hears PodReady with its next
// request (waitFor), before the shell gets it.
func (j *kubeJob) settle(pod, why string) {
	j.mu.Lock()
	if why == "" {
		j.pod = pod
	} else {
		j.err = why
		why = "this session's cells can't start: " + why
	}
	j.settled, j.settledAt = true, time.Now()
	switch {
	case j.waiting || j.announced && why != "":
		j.sayFinal()
	case why != "" && !j.announced:
		io.WriteString(j.out, "md-runbook-gate: "+why+"\n")
	}
	j.mu.Unlock()
	close(j.ready)
}

// sayFinal: PodReady, or PodFailed with the reason, once (under mu, once settled). After it the
// client reads no more notices: whatever a block prints is its output (review of 0.30.0, H1).
func (j *kubeJob) sayFinal() {
	if j.final {
		return
	}
	j.final = true
	if j.err == "" {
		io.WriteString(j.out, proto.Pod(proto.PodReady, ""))
	} else {
		io.WriteString(j.out, proto.Pod(proto.PodFailed, "this session's cells can't start: "+j.err))
	}
}

// hello: what the hello's answer says after the banner. To a client that takes pod notices
// (protocol 4), while the pod isn't ready: PodJob, so that it reads pod notices until it is.
func (j *kubeJob) hello(notices bool) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	// Told PodJob once, the client reads notices until the final one: a later hello doesn't take
	// that back (no request may then reach a shell before it).
	j.notices = notices || j.announced
	if notices && !j.settled {
		j.announced = true
		return proto.Pod(proto.PodJob, "")
	}
	return ""
}

// waitFor: a request whose reply the Job's shell prints (run, step, raw, context), before it
// goes to the shell. While the pod isn't ready, a client that takes pod notices hears
// PodStarting (its time limit waits for PodReady); another gets the gate's line, once. Once it
// is, a client told PodJob that hasn't heard PodReady yet hears it now: before any output of
// the shell, so that a block can't fake a notice (review of 0.30.0, H1). run: the request's run
// number when it is a signed run (its exit comes back through the follower), else "".
func (j *kubeJob) waitFor(run string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if !j.settled {
		if j.queued {
			// A second one (the client sends one at a time): which reply it had is unknown.
			j.queuedRun = ""
		} else if run != "" {
			j.queuedRun, j.ran = run, make(chan struct{})
		}
		j.queued = true
	}
	switch {
	case j.settled:
		if j.announced {
			j.sayFinal()
		}
	case j.notices:
		j.waiting = true
		io.WriteString(j.out, proto.Pod(proto.PodStarting, ""))
	case !j.noted:
		j.noted = true
		io.WriteString(j.out, "md-runbook-gate: this session's blocks run in a Kubernetes Job of their own ("+j.name+"): the first one waits for its pod\n")
	}
}

// isSettled: the pod is Ready, or won't be.
func (j *kubeJob) isSettled() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.settled
}

// spoke: the client sent a line. After the pod settled, it means the client had the reply of the
// request that waited for the pod (it sends one request at a time, and none can be answered
// before the pod settled).
func (j *kubeJob) spoke() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.settled {
		j.answered = true
	}
}

// ranExit: the exit of run n came back through the follower. When n is the queued request, it
// ended: the client's leaving no longer cuts the session short (review of 0.30.0, round 2, L-1).
func (j *kubeJob) ranExit(n string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.queuedRun != "" && n == j.queuedRun && !j.answered {
		j.answered = true
		close(j.ran)
	}
}

// leftGrace: how long after the pod settled the client's leaving may still be a Stop that came as
// the pod got ready (review of 0.30.0, L5). After it, the request that waited for the pod runs to
// its end when the client goes (a dropped connection), as any later block does (M1).
const leftGrace = 5 * time.Second

// leftWaiting: whether the client's leaving cuts the session short (its shells end now, and the
// Job goes), and what to log about it ("" for nothing).
//   - It left while the pod was starting: cut.
//   - It left within leftGrace of the pod settling, before the gate saw the end of a request sent
//     before the pod was ready: cut. A stop then closes the session (L5): what it sent would run
//     for no one. The gate doesn't see the shell's end markers (the shell writes to the client).
//     So that request counts as open until the client's next line, or, for a signed run, its
//     exit: the gate waits up to wait for that one (the follower polls). Logged for a signed run
//     only: a raw or context request's reply is quick, and a client that leaves after it most
//     likely left as it always does (round 1, L2).
//   - Else: not cut.
func (j *kubeJob) leftWaiting(wait time.Duration) (bool, string) {
	j.mu.Lock()
	settled, open, run, ran, since := j.settled, j.queued && !j.answered, j.queuedRun, j.ran, time.Since(j.settledAt)
	j.mu.Unlock()
	switch {
	case !settled:
		return true, "the client left while the pod was starting"
	case !open || since > leftGrace:
		return false, ""
	case run == "":
		return true, ""
	}
	select {
	case <-ran:
		return false, ""
	case <-time.After(wait):
	}
	return true, "the client left within " + itoa(int(leftGrace/time.Second)) + " s of the pod getting ready, before run " + run + " (which waited for the pod) ended: the session is cut short, as for a stop"
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
			return "", "the session's pod wasn't ready after " + itoa(int(jobReadyMax/time.Second)) + " s: see kubectl -n " + j.ns + " describe job " + j.name
		}
		sleep(jobReadyPoll)
	}
}

// check runs the reviews as the gate's service account (pod "") or, in the Job's pod, as the
// cells'; what is wrong, each as a sentence.
func (j *kubeJob) check(rs []review, pod, who string) []string {
	out, err := j.kubectlAs(pod, reviewList(rs), "create", "-f", "-", "-o", "json")
	if err != nil {
		return []string{"can't check " + who + " (" + err.Error() + ")"}
	}
	return reviewProblems(out, rs, who)
}

// kubectlAs runs kubectl as the gate's service account (pod "") or in the Job's pod as the
// cells' (through the cells' mode, before any block ran there).
func (j *kubeJob) kubectlAs(pod string, stdin []byte, args ...string) ([]byte, error) {
	argv := j.kc(args...)
	if pod != "" {
		req := cellsReq{Op: "exec", Argv: argv, Env: j.podEnv}.encode()
		argv, stdin = j.execArgv(pod), append(req, stdin...)
	}
	return j.run(argv, j.env, stdin)
}

// checkNamespaces: in every namespace where the cells may start or change workloads (a
// SelfSubjectRulesReview each, from the Job's pod), Pod Security must enforce baseline or
// restricted. Else a block starts a privileged pod there, with the node's file system, and
// reads the gate's pod's token and files on that node (review of 0.29.0, H2).
func (j *kubeJob) checkNamespaces(pod string) []string {
	out, err := j.kubectlAs(pod, nil, "get", "namespaces", "-o", "json")
	if err != nil {
		return []string{"can't list the namespaces as the cells' service account (" + err.Error() + ")"}
	}
	nss, err := kubeObjects(out)
	if err != nil {
		return []string{"can't read the namespaces"}
	}
	var names []string
	for _, n := range nss {
		if n.Kind == "Namespace" && config.ValidKubeName(n.Metadata.Name) {
			names = append(names, n.Metadata.Name)
		}
	}
	rules, err := j.kubectlAs(pod, rulesReviewList(names), "create", "-f", "-", "-o", "json")
	if err != nil {
		return []string{"can't check the cells' rights per namespace (" + err.Error() + ")"}
	}
	if p := unguardedNamespaces(nss, names, rules); len(p) > 0 {
		return p
	}
	if p := unpolicedNamespaces(names, rules, j.workloads); p != "" {
		return []string{p}
	}
	return nil
}

// The admission policy that keeps the cells' patches from changing a pod template's service
// account, volumes, env sources, security context, host or node (apps/ops/kubernetes/
// admission-policy.yaml). Without it, a runbook in a bound namespace acts as any service account
// there (security review of 0.31, H2).
const workloadPolicy = "md-runbook-ops-workloads"

// checkWorkloadPolicy: the policy md-runbook-ops-workloads and its binding, as the gate's service
// account (a get by name: the ClusterRole md-runbook-ops-gate allows that and nothing more). ""
// when they are in force, else why not.
func (j *kubeJob) checkWorkloadPolicy() string {
	out, err := j.run(j.kc("get", "validatingadmissionpolicy/"+workloadPolicy, "validatingadmissionpolicybinding/"+workloadPolicy, "-o", "json"), j.env, nil)
	return workloadPolicyProblem(out, err)
}

// workloadPolicyProblem: "" when kubectl's output has the policy md-runbook-ops-workloads, failing
// closed, and its binding, denying in every namespace; else why not, with what to apply.
func workloadPolicyProblem(out []byte, err error) string {
	apply := "Apply apps/ops/kubernetes/admission-policy.yaml"
	switch {
	case err != nil && strings.Contains(err.Error(), "(Forbidden)"):
		return "the gate's service account can't read the admission policy " + workloadPolicy + " (" + err.Error() + "). Apply apps/ops/kubernetes/md-runbook-ops.yaml (ClusterRole md-runbook-ops-gate)"
	case err != nil && strings.Contains(err.Error(), "(NotFound)"):
		return "the admission policy " + workloadPolicy + " or its binding is missing. " + apply
	case err != nil:
		return "can't tell whether the admission policy " + workloadPolicy + " is in force (" + err.Error() + ")"
	}
	type selector struct {
		MatchLabels      map[string]string `json:"matchLabels"`
		MatchExpressions []json.RawMessage `json:"matchExpressions"`
	}
	type item struct {
		Kind     string `json:"kind"`
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Spec struct {
			FailurePolicy     string   `json:"failurePolicy"`
			PolicyName        string   `json:"policyName"`
			ValidationActions []string `json:"validationActions"`
			MatchResources    *struct {
				NamespaceSelector    *selector         `json:"namespaceSelector"`
				ObjectSelector       *selector         `json:"objectSelector"`
				ResourceRules        []json.RawMessage `json:"resourceRules"`
				ExcludeResourceRules []json.RawMessage `json:"excludeResourceRules"`
			} `json:"matchResources"`
		} `json:"spec"`
		Items []item `json:"items"`
	}
	var items []item
	d := json.NewDecoder(bytes.NewReader(out))
	for {
		var o item
		if e := d.Decode(&o); e == io.EOF {
			break
		} else if e != nil {
			return "can't read the admission policy " + workloadPolicy
		}
		if strings.HasSuffix(o.Kind, "List") {
			items = append(items, o.Items...)
		} else {
			items = append(items, o)
		}
	}
	empty := func(s *selector) bool { return s == nil || len(s.MatchLabels) == 0 && len(s.MatchExpressions) == 0 }
	var policy, binding bool
	for _, o := range items {
		if o.Metadata.Name != workloadPolicy {
			continue
		}
		s := o.Spec
		switch o.Kind {
		case "ValidatingAdmissionPolicy":
			if s.FailurePolicy != "" && s.FailurePolicy != "Fail" {
				return "the admission policy " + workloadPolicy + " has failurePolicy " + s.FailurePolicy + ": an error would let a change through. " + apply
			}
			policy = true
		case "ValidatingAdmissionPolicyBinding":
			m := s.MatchResources
			if s.PolicyName != workloadPolicy || !has(s.ValidationActions, "Deny") ||
				m != nil && (!empty(m.NamespaceSelector) || !empty(m.ObjectSelector) || len(m.ResourceRules) > 0 || len(m.ExcludeResourceRules) > 0) {
				return "the binding " + workloadPolicy + " doesn't deny for the policy " + workloadPolicy + " in every namespace. " + apply
			}
			binding = true
		}
	}
	if !policy || !binding {
		return "the admission policy " + workloadPolicy + " or its binding is missing. " + apply
	}
	return ""
}

// unpolicedNamespaces: "" when the cells may change workloads nowhere (by the rules reviews of
// unguardedNamespaces, which passed) or the policy md-runbook-ops-workloads is in force (why is
// "": checkWorkloadPolicy), else the refusal, with up to 5 of those namespaces.
func unpolicedNamespaces(names []string, rulesOut []byte, why string) string {
	if why == "" {
		return ""
	}
	rights, _, _ := namespaceRights(names, rulesOut)
	var may []string
	for _, n := range names {
		if _, ok := rights[n]; ok {
			may = append(may, n)
		}
	}
	if len(may) == 0 {
		return ""
	}
	return "the cells' service account may change workloads in namespaces " + firstFew(may) + ", but " + why
}

// checkOwnNamespace: the gate's namespace holds the ops host alone. The gate may exec into every
// pod there and start Jobs as every service account there: in a namespace shared with other apps
// (a relay, a web app), a compromised gate would get their rights too (nevis-rest-api's review,
// 2026-11-17). "" when alone, else what to change.
func (j *kubeJob) checkOwnNamespace() string {
	out, err := j.run(j.kc("get", "pods,serviceaccounts", "-n", j.ns, "-o", "json"), j.env, nil)
	if err != nil {
		return "can't list the pods and service accounts of namespace " + j.ns + " (" + err.Error() + "). See apps/ops/README.md (RBAC)."
	}
	return foreignObjects(out, j.ns, j.opsSA, j.sa)
}

// The admission policy that holds the gate's Jobs to jobManifest's shape (apps/ops/kubernetes/
// admission-policy.yaml), and how the API server's refusal names it. (Its sibling
// md-runbook-ops-exec lets the gate exec only into pods named md-runbook-cells-*: the Jobs'.)
const (
	jobPolicy       = "md-runbook-ops-jobs"
	jobPolicyDenied = "ValidatingAdmissionPolicy '" + jobPolicy + "'"
)

// checkPolicy: the admission policy guards this namespace's Jobs. RBAC lets the gate create any
// Job here: as any service account, with the Secrets as volumes. The policy lets it create only
// the cells' Job. A dry run (nothing is created) of that Job as the gate's own service account
// must be refused by the policy. "" when it is, else what to change.
func (j *kubeJob) checkPolicy() string {
	spec := jobSpec{Name: "md-runbook-cells-check-" + randHex(5), NS: j.ns, OpsPod: j.opsPod, OpsUID: j.opsUID, Image: j.image, SA: j.opsSA, Context: j.context, GateID: "check"}
	_, err := j.run(j.kc("create", "--dry-run=server", "-f", "-", "-o", "name"), j.env, jobManifest(spec))
	fix := "Apply apps/ops/kubernetes/admission-policy.yaml (Kubernetes 1.30 or later)."
	cant := "can't tell whether the admission policy " + jobPolicy + " guards the Jobs of namespace " + j.ns + ": "
	switch {
	case err == nil:
		return "the admission policy " + jobPolicy + " doesn't guard the Jobs of namespace " + j.ns + ": a test Job as the gate's own service account " + j.opsSA + " passed. " + fix
	case strings.Contains(err.Error(), jobPolicyDenied):
		return ""
	case errors.Is(err, errTimeout):
		return cant + "kubectl didn't answer (" + err.Error() + ")"
	case !strings.Contains(err.Error(), "Error from server"):
		return cant + "kubectl failed (" + err.Error() + ")"
	}
	return cant + "a test Job as the gate's own service account was refused for another reason (" + err.Error() + "). " + fix
}

// createProblem: why the cells' Job wasn't created. Refused by the admission policy:
// job_service_account or job_image isn't what the policy allows.
func createProblem(err error) string {
	msg := "can't create the cells' Job (" + err.Error() + ")"
	if strings.Contains(err.Error(), jobPolicyDenied) {
		msg += ": job_service_account and job_image must match the policy " + jobPolicy + " in apps/ops/kubernetes/admission-policy.yaml. Change them together"
	}
	return msg
}

// podServiceAccount: the service account of the pod in kubectl's output ("default" when the
// spec names none, as the API server does).
func podServiceAccount(out []byte) string {
	objs, err := kubeObjects(out)
	if err != nil || len(objs) != 1 {
		return ""
	}
	return objs[0].serviceAccount()
}

func (o kubeObj) serviceAccount() string {
	if o.Spec.ServiceAccountName == "" {
		return "default"
	}
	return o.Spec.ServiceAccountName
}

// foreignObjects: what in namespace ns isn't the ops host's: pods that run as another service
// account than the gate's (own) or the cells', and service accounts other than those two and
// default. "" when there is none, else the problem with up to 5 names of each.
func foreignObjects(out []byte, ns, own, cells string) string {
	objs, err := kubeObjects(out)
	if err != nil {
		return "can't read the pods and service accounts of namespace " + ns
	}
	if own == "" {
		return "can't tell the gate's own service account"
	}
	ours := map[string]bool{own: true, cells: true}
	var pods, sas []string
	for _, o := range objs {
		switch o.Kind {
		case "Pod":
			if sa := o.serviceAccount(); !ours[sa] {
				pods = append(pods, o.Metadata.Name+" (as "+sa+")")
			}
		case "ServiceAccount":
			if n := o.Metadata.Name; !ours[n] && n != "default" {
				sas = append(sas, n)
			}
		}
	}
	if len(pods) == 0 && len(sas) == 0 {
		return ""
	}
	var what, could []string
	if len(pods) > 0 {
		what = append(what, "pods "+firstFew(pods))
		could = append(could, "exec into those pods")
	}
	if len(sas) > 0 {
		what = append(what, "service accounts "+firstFew(sas))
		could = append(could, "run Jobs as those accounts")
	}
	return "namespace " + ns + " also has " + strings.Join(what, " and ") + ": the gate could " + strings.Join(could, " and ") + ". Give the ops host a namespace of its own (apps/ops/README.md)."
}

// firstFew: up to 5 names, then how many more.
func firstFew(names []string) string {
	if len(names) <= 5 {
		return strings.Join(names, ", ")
	}
	return strings.Join(names[:5], ", ") + " and " + itoa(len(names)-5) + " more"
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

// gateID: a gate process, as a Job's label names it: its pid and its start time after boot.
// A pid alone could be another program's by now.
func gateID(pid int) string { return itoa(pid) + "." + procs.StartTime(pid) }

// gateAlive: the gate that label id names still runs: that pid, started then, this program.
func gateAlive(id string) bool {
	pidS, start, ok := strings.Cut(id, ".")
	if !ok || !textutil.IsPID(pidS) || start == "" {
		return false
	}
	pid := atoi(pidS)
	if pid <= 1 || procs.StartTime(pid) != start {
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
		var err error
		for i, pause := 0, 500*time.Millisecond; i < 3; i, pause = i+1, pause*2 {
			if _, err = j.quick(j.kc("delete", "job", j.name, "-n", j.ns, "--ignore-not-found", "--wait=false"), j.env, nil); err == nil {
				break
			}
			if i < 2 {
				time.Sleep(pause)
			}
		}
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
	in.Write(cellsReq{Op: "follow", Paths: []string{jobExits}, Events: true, EndPod: true}.encode())
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

// jobMissingExits: at the end of a session that wasn't cut short, every signed run has its exit
// (each shell ran all it was sent, and the follower read to the end). One that hasn't: its line
// was kept from the gate, so the session's exits count for nothing (no run report).
func (g *Gate) jobMissingExits(cut bool) {
	if g.job == nil || cut {
		return
	}
	g.exitsMu.Lock()
	defer g.exitsMu.Unlock()
	for n := 1; n <= g.runs; n++ {
		if _, run := g.sepRuns[itoa(n)]; !run {
			continue
		}
		if _, ok := g.sepExits[itoa(n)]; !ok {
			g.junkExits("no exit came back for run " + itoa(n))
			return
		}
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
			// A request that waited for the pod has ended: its exit is in.
			if n, _, _ := strings.Cut(text, "\t"); g.exitsBad == "" {
				if _, ok := g.sepExits[n]; ok {
					g.job.ranExit(n)
				}
			}
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

// probeEvent: a line of the pod's log as the gate logs it: an md-runbook-probe event of one of
// this session's signed runs (string values only, each cut to 1024 bytes), marked source job.
// The time, account, key and client are the gate's.
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
	if len(kv) < 4 || kv[2] != "run" {
		return nil, false
	}
	return append(kv, "source", "job"), true
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
	Name, NS, OpsPod, OpsUID, Image, SA, Context, GateID string
}

// jobManifest: the cells' Job, as JSON for kubectl create. Pod Security "restricted": non-root,
// no privilege escalation, no capabilities, seccomp RuntimeDefault; a read-only root file
// system with emptyDirs for the home folder, /tmp and the probe's log.
func jobManifest(s jobSpec) []byte {
	type obj = map[string]any
	labels := obj{"app.kubernetes.io/name": "md-runbook-cells", "app.kubernetes.io/managed-by": "md-runbook-gate", "md-runbook-job": s.Name, "md-runbook-ops-pod": s.OpsUID, "md-runbook-gate-id": s.GateID}
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
		"resources":       obj{"requests": obj{"cpu": "50m", "memory": "64Mi"}, "limits": obj{"cpu": "1", "memory": "512Mi", "ephemeral-storage": "1Gi"}},
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
		ServiceAccountName string            `json:"serviceAccountName"`
		ResourceAttributes map[string]string `json:"resourceAttributes"`
		Namespace          string            `json:"namespace"`
	} `json:"spec"`
	Status struct {
		Phase         string     `json:"phase"`
		Allowed       bool       `json:"allowed"`
		ResourceRules []kubeRule `json:"resourceRules"`
		Incomplete    bool       `json:"incomplete"`
		Conditions    []struct {
			Type    string `json:"type"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
		} `json:"conditions"`
		ContainerStatuses []struct {
			Name    string `json:"name"`
			ImageID string `json:"imageID"`
			State   struct {
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

// parseOwnPod: the gate's pod: its uid, and its image (the container ops, else the only one),
// by digest where the image is a registry's (pinImage).
func parseOwnPod(out []byte) (uid, image string, err error) {
	objs, err := kubeObjects(out)
	if err != nil || len(objs) != 1 || objs[0].Kind != "Pod" || objs[0].Metadata.UID == "" {
		return "", "", errors.New("not a pod")
	}
	p := objs[0]
	cs := p.Spec.Containers
	name := ""
	for _, c := range cs {
		if c.Name == "ops" {
			image, name = c.Image, c.Name
		}
	}
	if image == "" && len(cs) == 1 {
		image, name = cs[0].Image, cs[0].Name
	}
	for _, st := range p.Status.ContainerStatuses {
		if image != "" && st.Name == name {
			image = pinImage(image, st.ImageID)
		}
	}
	if image == "" {
		return "", "", errors.New("it has no container ops: set job_image")
	}
	if !config.ValidImage(image) {
		return "", "", errors.New("its image " + image + " is not one the gate can name: set job_image")
	}
	return p.Metadata.UID, image, nil
}

// pinImage: the image by the digest the gate's pod runs (status imageID), so that the Job runs
// the same gate whatever its tag points to now. Only for an image of a registry (a host with a
// dot or a port first) named the same: a local image (kind, a node's own) has no digest to pull
// by. Else the spec's image.
func pinImage(image, imageID string) string {
	id := strings.TrimPrefix(imageID, "docker-pullable://")
	repo, digest, ok := strings.Cut(id, "@sha256:")
	if !ok || len(digest) != 64 || !textutil.IsHex64(digest) {
		return image
	}
	host, _, _ := strings.Cut(repo, "/")
	if !strings.Contains(repo, "/") || !strings.ContainsAny(host, ".:") {
		return image
	}
	name := image
	if i := strings.Index(name, "@"); i >= 0 {
		name = name[:i]
	}
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		name = name[:i]
	}
	if name != repo {
		return image
	}
	return repo + "@sha256:" + digest
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

// orphanJobs: the Jobs whose gate (label md-runbook-gate-id: pid and start time) no longer runs.
func orphanJobs(out []byte, alive func(id string) bool) []string {
	objs, err := kubeObjects(out)
	if err != nil {
		return nil
	}
	var names []string
	for _, o := range objs {
		if o.Kind != "Job" || o.Metadata.DeletionTimestamp != "" || !config.ValidKubeName(o.Metadata.Name) {
			continue
		}
		if id := o.Metadata.Labels["md-runbook-gate-id"]; id != "" && alive(id) {
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
// cells' rights (reading across namespaces, Secrets, workloads, tokens, roles). Of the admission
// policies it may only get md-runbook-ops-workloads and its binding by name (checkWorkloadPolicy):
// a get without a name, a list or a change is refused, so it can't weaken them.
func opsReviews(ns string) []review {
	var policies []review
	for _, res := range []string{"validatingadmissionpolicies", "validatingadmissionpolicybindings"} {
		for _, verb := range []string{"get", "list", "create", "update", "patch", "delete"} {
			policies = append(policies, review{verb, "admissionregistration.k8s.io", res, "", "", false})
		}
	}
	return append([]review{
		{"create", "batch", "jobs", "", ns, true},
		{"list", "batch", "jobs", "", ns, true},
		{"delete", "batch", "jobs", "", ns, true},
		{"get", "", "pods", "", ns, true},
		{"list", "", "pods", "", ns, true},
		{"create", "", "pods", "exec", ns, true},
		{"list", "", "serviceaccounts", "", ns, true},
		{"list", "", "pods", "", "", false},
		{"get", "", "secrets", "", ns, false},
		{"create", "", "pods", "", ns, false},
		{"patch", "apps", "deployments", "", ns, false},
		{"create", "", "serviceaccounts", "token", ns, false},
		{"create", "rbac.authorization.k8s.io", "rolebindings", "", ns, false},
		{"impersonate", "", "serviceaccounts", "", "", false},
	}, policies...)
}

// cellsReviews: in the gate's namespace the cells' service account can't reach the gate's pod
// (exec, attach, ephemeral containers, its log: the gate's events), its Secrets and ConfigMaps
// (host key, report token, gate.conf, keys), nor run or change anything there (workloads, pods,
// Jobs, tokens, roles); nowhere can it impersonate, bind or escalate roles, change the admission
// policies, or reach a node's kubelet. Impersonation and bindings are asked with the namespace too: a RoleBinding is
// invisible to a review without one.
func cellsReviews(ns string) []review {
	no := func(verb, group, resource, sub string) review { return review{verb, group, resource, sub, ns, false} }
	anywhere := func(verb, group, resource, sub string) review { return review{verb, group, resource, sub, "", false} }
	rbac := "rbac.authorization.k8s.io"
	return []review{
		no("create", "", "pods", "exec"),
		no("get", "", "pods", "exec"),
		no("create", "", "pods", "attach"),
		no("patch", "", "pods", "ephemeralcontainers"),
		no("update", "", "pods", "ephemeralcontainers"),
		no("get", "", "pods", "log"),
		no("get", "", "secrets", ""),
		no("list", "", "secrets", ""),
		no("watch", "", "secrets", ""),
		no("get", "", "configmaps", ""),
		no("list", "", "configmaps", ""),
		no("watch", "", "configmaps", ""),
		no("create", "", "configmaps", ""),
		no("update", "", "configmaps", ""),
		no("patch", "", "configmaps", ""),
		no("delete", "", "configmaps", ""),
		no("create", "", "pods", ""),
		no("patch", "", "pods", ""),
		no("update", "", "pods", ""),
		no("delete", "", "pods", ""),
		no("create", "batch", "jobs", ""),
		no("patch", "batch", "jobs", ""),
		no("delete", "batch", "jobs", ""),
		no("create", "batch", "cronjobs", ""),
		no("create", "apps", "deployments", ""),
		no("patch", "apps", "deployments", ""),
		no("create", "apps", "statefulsets", ""),
		no("create", "apps", "daemonsets", ""),
		no("create", "apps", "replicasets", ""),
		no("create", "", "serviceaccounts", "token"),
		no("create", rbac, "rolebindings", ""),
		no("bind", rbac, "roles", ""),
		no("escalate", rbac, "roles", ""),
		no("bind", rbac, "clusterroles", ""),
		no("escalate", rbac, "clusterroles", ""),
		anywhere("create", rbac, "clusterrolebindings", ""),
		anywhere("bind", rbac, "clusterroles", ""),
		anywhere("escalate", rbac, "clusterroles", ""),
		// The admission policies that hold the cells' changes and the gate's Jobs.
		anywhere("update", "admissionregistration.k8s.io", "validatingadmissionpolicies", ""),
		anywhere("patch", "admissionregistration.k8s.io", "validatingadmissionpolicies", ""),
		anywhere("delete", "admissionregistration.k8s.io", "validatingadmissionpolicies", ""),
		anywhere("update", "admissionregistration.k8s.io", "validatingadmissionpolicybindings", ""),
		anywhere("patch", "admissionregistration.k8s.io", "validatingadmissionpolicybindings", ""),
		anywhere("delete", "admissionregistration.k8s.io", "validatingadmissionpolicybindings", ""),
		anywhere("get", "", "nodes", "proxy"),
		anywhere("impersonate", "", "users", ""),
		anywhere("impersonate", "", "groups", ""),
		anywhere("impersonate", "", "serviceaccounts", ""),
		no("impersonate", "", "users", ""),
		no("impersonate", "", "groups", ""),
		no("impersonate", "", "serviceaccounts", ""),
	}
}

// kubeRule: a rule of a SelfSubjectRulesReview.
type kubeRule struct {
	Verbs     []string `json:"verbs"`
	APIGroups []string `json:"apiGroups"`
	Resources []string `json:"resources"`
}

// rulesReviewList: one SelfSubjectRulesReview per namespace, as one List.
func rulesReviewList(names []string) []byte {
	items := make([]map[string]any, 0, len(names))
	for _, n := range names {
		items = append(items, map[string]any{"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectRulesReview", "spec": map[string]any{"namespace": n}})
	}
	data, _ := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "List", "items": items})
	return data
}

// What starts or changes a pod's spec: create, patch or update of these (group/resource).
var workloads = []string{"/pods", "/pods/ephemeralcontainers", "/replicationcontrollers", "batch/jobs", "batch/cronjobs",
	"apps/deployments", "apps/statefulsets", "apps/daemonsets", "apps/replicasets"}

func ruleHas(list []string, v string) bool {
	for _, x := range list {
		if x == "*" || x == v {
			return true
		}
	}
	return false
}

// startsWorkloads: a rule lets its holder create, patch or update a workload.
func startsWorkloads(r kubeRule) bool {
	if !ruleHas(r.Verbs, "create") && !ruleHas(r.Verbs, "patch") && !ruleHas(r.Verbs, "update") {
		return false
	}
	for _, w := range workloads {
		group, res, _ := strings.Cut(w, "/")
		if !ruleHas(r.APIGroups, group) {
			continue
		}
		top, _, hasSub := strings.Cut(res, "/")
		for _, x := range r.Resources {
			if x == "*" || x == res || (hasSub && x == top+"/*") {
				return true
			}
		}
	}
	return false
}

// namespaceRights: from the rules reviews (one per name, in that order), each namespace where the
// cells may start or change workloads, or the review can't say (incomplete), with why; starts:
// those where a rule says so. The API server answers a SelfSubjectRulesReview without its spec:
// the answers are matched to names by their place; a count that differs is a problem.
func namespaceRights(names []string, rulesOut []byte) (why map[string]string, starts map[string]bool, problem string) {
	objs, err := kubeObjects(rulesOut)
	if err != nil {
		return nil, nil, "can't read the cells' rights per namespace"
	}
	var reviews []kubeObj
	for _, r := range objs {
		if r.Kind == "SelfSubjectRulesReview" {
			reviews = append(reviews, r)
		}
	}
	if len(reviews) != len(names) {
		return nil, nil, "can't check the cells' rights per namespace: " + itoa(len(reviews)) + " answers for " + itoa(len(names)) + " namespaces"
	}
	why, starts = map[string]string{}, map[string]bool{}
	for i, r := range reviews {
		ns := names[i]
		if r.Spec.Namespace != "" && r.Spec.Namespace != ns {
			return nil, nil, "can't check the cells' rights per namespace: an answer for " + r.Spec.Namespace + " in the place of " + ns
		}
		if r.Status.Incomplete {
			why[ns] = "may have rights the API server can't list (an incomplete answer)"
		}
		for _, rule := range r.Status.ResourceRules {
			if startsWorkloads(rule) {
				why[ns], starts[ns] = "may start workloads", true
			}
		}
	}
	return why, starts, ""
}

// kubeNamespace: kube-system, kube-public, kube-node-lease and the like: the cluster's own. Their
// service accounts run the cluster's controllers (cluster-admin, in effect).
func kubeNamespace(name string) bool { return strings.HasPrefix(name, "kube-") }

// unguardedNamespaces: each namespace where the cells may start or change workloads (or the
// review can't say: incomplete, missing) without Pod Security baseline or restricted enforced;
// and each kube-* namespace where a rule lets them, whatever its labels: a workload there can
// run as a controller's service account (security review of 0.31, H1).
func unguardedNamespaces(nss []kubeObj, names []string, rulesOut []byte) []string {
	why, starts, problem := namespaceRights(names, rulesOut)
	if problem != "" {
		return []string{problem}
	}
	const never = "never bind md-runbook-ops-operate (or any workload rights) in kube-* namespaces; their service accounts run the cluster"
	var p []string
	for _, n := range nss {
		name := n.Metadata.Name
		if n.Kind != "Namespace" || !config.ValidKubeName(name) {
			continue
		}
		w, ok := why[name]
		if !has(names, name) {
			w, ok = "may start workloads (no answer)", true
		}
		if !ok {
			continue
		}
		if kubeNamespace(name) && starts[name] {
			p = append(p, "the cells' service account may start workloads in namespace "+name+": "+never)
			continue
		}
		switch n.Metadata.Labels["pod-security.kubernetes.io/enforce"] {
		case "baseline", "restricted":
			continue
		}
		if kubeNamespace(name) {
			// No label to suggest here: the fix is to bind nothing.
			p = append(p, "the cells' service account "+w+" in namespace "+name+", which doesn't enforce Pod Security baseline or restricted: "+never)
			continue
		}
		p = append(p, "the cells' service account "+w+" in namespace "+name+", which doesn't enforce Pod Security baseline or restricted: kubectl label namespace "+name+" pod-security.kubernetes.io/enforce=baseline")
	}
	return p
}

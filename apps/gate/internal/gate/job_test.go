//go:build unix

package gate

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/smojon/md-runbook/apps/gate/internal/config"
	"github.com/smojon/md-runbook/apps/gate/internal/logx"
	"github.com/smojon/md-runbook/apps/gate/internal/procs"
	"github.com/smojon/md-runbook/apps/gate/internal/report"
)

var testSpec = jobSpec{Name: "md-runbook-cells-0a1b2c3d4e", NS: "md-runbook-ops", OpsPod: "md-runbook-ops-7c9f-x2", OpsUID: "1b4e28ba-2fa1-11d2-883f-0016d3cca427",
	Image: "ghcr.io/smojon/md-runbook-ops:0.29.0", SA: "md-runbook-cells", Context: "prod-eu", GateID: "4242.987654"}

// at: the value at a path of keys and indexes in decoded JSON.
func at(t *testing.T, v any, path ...any) any {
	t.Helper()
	for _, p := range path {
		switch k := p.(type) {
		case string:
			m, ok := v.(map[string]any)
			if !ok {
				t.Fatalf("%v: not an object at %q", path, k)
			}
			v = m[k]
		case int:
			a, ok := v.([]any)
			if !ok || k >= len(a) {
				t.Fatalf("%v: no item %d", path, k)
			}
			v = a[k]
		}
	}
	return v
}

// The Job the gate creates: the cells' account and image, Pod Security "restricted", a read-only
// root file system, limits, cleanup (owner, deadline, TTL), and nothing from a host.
func TestJobManifest(t *testing.T) {
	var job map[string]any
	if err := json.Unmarshal(jobManifest(testSpec), &job); err != nil {
		t.Fatal(err)
	}
	pod := at(t, job, "spec", "template", "spec")
	c := at(t, pod, "containers", 0)
	for _, w := range []struct {
		got  any
		want any
	}{
		{at(t, job, "apiVersion"), "batch/v1"},
		{at(t, job, "kind"), "Job"},
		{at(t, job, "metadata", "name"), testSpec.Name},
		{at(t, job, "metadata", "namespace"), "md-runbook-ops"},
		{at(t, job, "metadata", "labels", "md-runbook-job"), testSpec.Name},
		{at(t, job, "metadata", "labels", "md-runbook-ops-pod"), testSpec.OpsUID},
		{at(t, job, "metadata", "labels", "md-runbook-gate-id"), "4242.987654"},
		{at(t, job, "metadata", "labels", "app.kubernetes.io/name"), "md-runbook-cells"},
		{at(t, job, "metadata", "ownerReferences", 0, "kind"), "Pod"},
		{at(t, job, "metadata", "ownerReferences", 0, "name"), testSpec.OpsPod},
		{at(t, job, "metadata", "ownerReferences", 0, "uid"), testSpec.OpsUID},
		{at(t, job, "spec", "backoffLimit"), 0.0},
		{at(t, job, "spec", "activeDeadlineSeconds"), 86400.0},
		{at(t, job, "spec", "ttlSecondsAfterFinished"), 60.0},
		{at(t, job, "spec", "template", "metadata", "labels", "md-runbook-job"), testSpec.Name},
		{at(t, pod, "restartPolicy"), "Never"},
		{at(t, pod, "serviceAccountName"), "md-runbook-cells"},
		{at(t, pod, "automountServiceAccountToken"), true},
		{at(t, pod, "enableServiceLinks"), false},
		{at(t, pod, "securityContext", "runAsNonRoot"), true},
		{at(t, pod, "securityContext", "runAsUser"), 10001.0},
		{at(t, pod, "securityContext", "seccompProfile", "type"), "RuntimeDefault"},
		{at(t, c, "name"), "cells"},
		{at(t, c, "image"), testSpec.Image},
		{at(t, c, "env", 0, "name"), "CLUSTER_NAME"},
		{at(t, c, "env", 0, "value"), "prod-eu"},
		{at(t, c, "securityContext", "allowPrivilegeEscalation"), false},
		{at(t, c, "securityContext", "readOnlyRootFilesystem"), true},
		{at(t, c, "securityContext", "capabilities", "drop", 0), "ALL"},
		{at(t, c, "resources", "limits", "memory"), "512Mi"},
		{at(t, c, "resources", "limits", "cpu"), "1"},
		{at(t, c, "resources", "limits", "ephemeral-storage"), "1Gi"},
		{at(t, c, "resources", "requests", "cpu"), "50m"},
	} {
		if !reflect.DeepEqual(w.got, w.want) {
			t.Errorf("got %#v, want %#v", w.got, w.want)
		}
	}
	if cmd := at(t, c, "command"); !reflect.DeepEqual(cmd, []any{"/usr/bin/tini", "--", "/usr/local/bin/md-runbook-ops-start", "cells"}) {
		t.Errorf("command %v", cmd)
	}
	// Only emptyDirs: nothing of the node, nothing of the gate's pod.
	for _, v := range at(t, pod, "volumes").([]any) {
		m := v.(map[string]any)
		if _, ok := m["emptyDir"]; !ok || len(m) != 2 {
			t.Errorf("volume %v", m)
		}
	}
	for _, k := range []string{"hostNetwork", "hostPID", "hostIPC", "nodeName", "volumes.hostPath"} {
		if _, ok := pod.(map[string]any)[k]; ok {
			t.Errorf("pod has %s", k)
		}
	}
}

func testJob(run runFunc) *kubeJob {
	return &kubeJob{kubectl: "/usr/bin/kubectl", env: []string{"PATH=" + sysPath, "LC_ALL=C", "HOME=/home/ops"},
		podEnv: []string{"PATH=/usr/local/bin:/usr/bin:/bin", "LC_ALL=C", "HOME=/home/ops"}, run: run, quick: run, exe: "/usr/local/bin/md-runbook-gate",
		ns: "md-runbook-ops", name: testSpec.Name, ready: make(chan struct{})}
}

func TestExecArgv(t *testing.T) {
	want := []string{"/usr/bin/kubectl", "exec", "-i", "-q", "-n", "md-runbook-ops", "md-runbook-cells-0a1b2c3d4e-x7k2p", "-c", "cells", "--", "/usr/local/bin/md-runbook-gate", "__cells"}
	if got := testJob(nil).execArgv("md-runbook-cells-0a1b2c3d4e-x7k2p"); !reflect.DeepEqual(got, want) {
		t.Errorf("%q", got)
	}
}

func TestRunnerProblem(t *testing.T) {
	job := config.Defaults()
	job.CellsRunner, job.JobServiceAccount = "kubernetes-job", "md-runbook-cells"
	const conf = "/etc/md-runbook/gate.conf"
	if p := runnerProblem(job, conf); p != "" {
		t.Errorf("good: %s", p)
	}
	if p := runnerProblem(config.Defaults(), conf); p != "" {
		t.Errorf("local: %s", p)
	}
	for name, c := range map[string]struct {
		change func(c *config.Config)
		want   string
	}{
		"no account":             {func(c *config.Config) { c.JobServiceAccount = "" }, "needs job_service_account"},
		"cells_account":          {func(c *config.Config) { c.CellsAccount = "mdrb-cells" }, "Remove cells_account"},
		"cells_accounts":         {func(c *config.Config) { c.CellsAccounts = []string{"mdrb-cells-1", "mdrb-cells-2"} }, "and cells_accounts don't go together: the Job's pod keeps the cells apart. Remove cells_accounts"},
		"scope":                  {func(c *config.Config) { c.Isolation = "scope" }, "isolation = scope doesn't go"},
		"bwrap":                  {func(c *config.Config) { c.Isolation = "bwrap" }, "isolation = bwrap doesn't go"},
		"local with keys":        {func(c *config.Config) { c.CellsRunner = "local" }, "for cells_runner = kubernetes-job only"},
		"token in the ConfigMap": {func(c *config.Config) { c.ReportToken = "/etc/md-runbook/report-token" }, "a ConfigMap on the ops host: put the token in a Secret"},
		"token below it":         {func(c *config.Config) { c.ReportToken = "/etc/md-runbook/x/../token" }, "a ConfigMap on the ops host"},
		"local with image":       {func(c *config.Config) { c.CellsRunner, c.JobServiceAccount, c.JobImage = "local", "", "x:1" }, "for cells_runner = kubernetes-job only"},
	} {
		cfg := job
		c.change(&cfg)
		if p := runnerProblem(cfg, conf); !strings.Contains(p, c.want) {
			t.Errorf("%s: %q", name, p)
		}
	}
	tok := job
	tok.ReportToken = "/etc/md-runbook-ops/report/token"
	if p := runnerProblem(tok, conf); p != "" {
		t.Errorf("token in a Secret: %s", p)
	}
	for _, iso := range []string{"auto", "none"} {
		cfg := job
		cfg.Isolation = iso
		if p := runnerProblem(cfg, conf); p != "" {
			t.Errorf("%s: %s", iso, p)
		}
	}
}

func TestParseContext(t *testing.T) {
	view := `{"kind":"Config","current-context":"prod-eu","contexts":[{"name":"prod-eu","context":{"cluster":"prod-eu","user":"md-runbook-ops","namespace":"md-runbook-ops"}}]}`
	if ctx, ns, err := parseContext([]byte(view)); err != nil || ctx != "prod-eu" || ns != "md-runbook-ops" {
		t.Errorf("%q %q %v", ctx, ns, err)
	}
	if _, ns, err := parseContext([]byte(`{"current-context":"x","contexts":[{"name":"x","context":{}}]}`)); err != nil || ns != "default" {
		t.Errorf("no namespace: %q %v", ns, err)
	}
	for _, bad := range []string{`{"current-context":""}`, `not json`, `{"current-context":"x","contexts":[{"name":"x","context":{"namespace":"A B"}}]}`} {
		if _, _, err := parseContext([]byte(bad)); err == nil {
			t.Errorf("%s: read", bad)
		}
	}
}

func TestParseOwnPod(t *testing.T) {
	pod := func(containers string) []byte {
		return []byte(`{"kind":"Pod","metadata":{"name":"ops-1","uid":"u-1"},"spec":{"containers":[` + containers + `]}}`)
	}
	if uid, img, err := parseOwnPod(pod(`{"name":"istio-proxy","image":"istio/proxy:1"},{"name":"ops","image":"ghcr.io/smojon/md-runbook-ops:0.29.0"}`)); err != nil || uid != "u-1" || img != "ghcr.io/smojon/md-runbook-ops:0.29.0" {
		t.Errorf("ops: %q %q %v", uid, img, err)
	}
	if _, img, err := parseOwnPod(pod(`{"name":"main","image":"md-runbook-ops:ci"}`)); err != nil || img != "md-runbook-ops:ci" {
		t.Errorf("only one: %q %v", img, err)
	}
	for name, out := range map[string][]byte{
		"two, none ops": pod(`{"name":"a","image":"a:1"},{"name":"b","image":"b:1"}`),
		"odd image":     pod(`{"name":"ops","image":"a b"}`),
		"not a pod":     []byte(`{"kind":"Job","metadata":{"uid":"u"}}`),
		"no uid":        []byte(`{"kind":"Pod","metadata":{},"spec":{"containers":[{"name":"ops","image":"x"}]}}`),
	} {
		if _, _, err := parseOwnPod(out); err == nil {
			t.Errorf("%s: read", name)
		}
	}
}

// What kubectl get jobs,pods prints, in each state the gate tells apart.
func TestPodState(t *testing.T) {
	list := func(items ...string) []byte {
		return []byte(`{"kind":"List","items":[` + strings.Join(items, ",") + `]}`)
	}
	job := `{"kind":"Job","metadata":{"name":"j"},"status":{"active":1}}`
	pod := func(phase, extra string) string {
		return `{"kind":"Pod","metadata":{"name":"j-x"},"status":{"phase":"` + phase + `"` + extra + `}}`
	}
	ready := `,"conditions":[{"type":"Ready","status":"True"}]`
	waiting := func(reason string) string {
		return `,"containerStatuses":[{"state":{"waiting":{"reason":"` + reason + `","message":"m"}}}]`
	}
	for name, c := range map[string]struct {
		out   []byte
		pod   string
		ready bool
		fail  string
	}{
		"no pod yet":       {list(job), "", false, ""},
		"creating":         {list(job, pod("Pending", waiting("ContainerCreating"))), "j-x", false, ""},
		"pulling, retried": {list(job, pod("Pending", waiting("ErrImagePull"))), "j-x", false, ""},
		"running, not yet": {list(job, pod("Running", `,"conditions":[{"type":"Ready","status":"False"}]`)), "j-x", false, ""},
		"ready":            {list(job, pod("Running", ready)), "j-x", true, ""},
		"two values":       {[]byte(job + "\n" + pod("Running", ready)), "j-x", true, ""},
		"terminating":      {list(job, `{"kind":"Pod","metadata":{"name":"old","deletionTimestamp":"2026-11-16T10:00:00Z"},"status":{"phase":"Running"`+ready+`}}`), "", false, ""},
		"bad image":        {list(job, pod("Pending", waiting("ImagePullBackOff"))), "j-x", false, "its pod can't start (ImagePullBackOff: m)"},
		"crash":            {list(job, pod("Running", waiting("CrashLoopBackOff"))), "j-x", false, "its pod can't start (CrashLoopBackOff"},
		"pod failed":       {list(job, pod("Failed", "")), "j-x", false, "its pod ended (Failed)"},
		"exited":           {list(job, pod("Running", `,"containerStatuses":[{"state":{"terminated":{"reason":"Error","exitCode":1}}}]`)), "j-x", false, "its pod's container ended (Error, exit 1)"},
		"job failed":       {list(`{"kind":"Job","status":{"conditions":[{"type":"Failed","status":"True","reason":"DeadlineExceeded","message":"too long"}]}}`), "", false, "the Job failed (DeadlineExceeded: too long)"},
		"not json":         {[]byte("error"), "", false, ""},
	} {
		p, r, f := podState(c.out)
		if p != c.pod || r != c.ready || !strings.HasPrefix(f, c.fail) || (c.fail == "") != (f == "") {
			t.Errorf("%s: %q %v %q", name, p, r, f)
		}
	}
}

// waitPod asks every half second, until the pod is Ready, can't be, or 3 minutes passed.
func TestWaitPod(t *testing.T) {
	answers := func(outs ...string) (runFunc, *int) {
		n := 0
		return func(argv, env []string, stdin []byte) ([]byte, error) {
			want := []string{"/usr/bin/kubectl", "get", "jobs,pods", "-n", "md-runbook-ops", "-l", "md-runbook-job=" + testSpec.Name, "-o", "json"}
			if !reflect.DeepEqual(argv, want) {
				return nil, errors.New("unexpected " + strings.Join(argv, " "))
			}
			o := outs[min(n, len(outs)-1)]
			n++
			if o == "" {
				return nil, errors.New("exit status 1: connection refused")
			}
			return []byte(o), nil
		}, &n
	}
	pending := `{"kind":"List","items":[{"kind":"Pod","metadata":{"name":"p"},"status":{"phase":"Pending"}}]}`
	readyOut := `{"kind":"List","items":[{"kind":"Pod","metadata":{"name":"p"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}`
	bad := `{"kind":"List","items":[{"kind":"Pod","metadata":{"name":"p"},"status":{"phase":"Pending","containerStatuses":[{"state":{"waiting":{"reason":"InvalidImageName"}}}]}}]}`
	clock := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	now := func() time.Time { return clock }
	sleep := func(d time.Duration) { clock = clock.Add(d) }

	run, n := answers(pending, "", pending, readyOut)
	if pod, why := testJob(run).waitPod(sleep, now); pod != "p" || why != "" || *n != 4 {
		t.Errorf("ready: %q %q after %d", pod, why, *n)
	}
	run, _ = answers(pending, bad)
	if pod, why := testJob(run).waitPod(sleep, now); pod != "" || !strings.Contains(why, "InvalidImageName") || !strings.Contains(why, "kubectl -n md-runbook-ops describe job "+testSpec.Name) {
		t.Errorf("bad image: %q %q", pod, why)
	}
	run, n = answers(pending)
	if pod, why := testJob(run).waitPod(sleep, now); pod != "" || !strings.Contains(why, "within 3 minutes") || *n < 300 || *n > 400 {
		t.Errorf("timeout: %q %q after %d", pod, why, *n)
	}
}

func TestOrphanJobs(t *testing.T) {
	out := []byte(`{"kind":"List","items":[
		{"kind":"Job","metadata":{"name":"md-runbook-cells-live","labels":{"md-runbook-gate-id":"100.5"}}},
		{"kind":"Job","metadata":{"name":"md-runbook-cells-dead","labels":{"md-runbook-gate-id":"200.5"}}},
		{"kind":"Job","metadata":{"name":"md-runbook-cells-nopid","labels":{}}},
		{"kind":"Job","metadata":{"name":"md-runbook-cells-gone","labels":{"md-runbook-gate-id":"300.5"},"deletionTimestamp":"2026-11-16T10:00:00Z"}},
		{"kind":"Job","metadata":{"name":"--all","labels":{"md-runbook-gate-id":"200.5"}}}]}`)
	got := orphanJobs(out, func(id string) bool { return id == "100.5" })
	if !reflect.DeepEqual(got, []string{"md-runbook-cells-dead", "md-runbook-cells-nopid"}) {
		t.Errorf("%q", got)
	}
	if orphanJobs([]byte("oops"), nil) != nil {
		t.Error("unreadable output: orphans")
	}
	// A gate is its pid and start time: the same pid, started another time, is not it.
	me := gateID(os.Getpid())
	if procs.HaveProc() && (!gateAlive(me) || gateAlive(itoa(os.Getpid())+".1") || gateAlive("1."+procs.StartTime(1)) || gateAlive(itoa(os.Getpid())) || gateAlive("")) {
		t.Errorf("gateAlive (%s)", me)
	}
}

// answersFor: a List of reviews as the API server answers them, allowed where allow says.
func answersFor(t *testing.T, stdin []byte, allow func(attrs map[string]any) bool) []byte {
	t.Helper()
	var list map[string]any
	if err := json.Unmarshal(stdin, &list); err != nil || list["kind"] != "List" {
		t.Fatalf("reviews: %s", stdin)
	}
	var out bytes.Buffer
	// kubectl create prints one object per review.
	for _, it := range list["items"].([]any) {
		item := it.(map[string]any)
		attrs := item["spec"].(map[string]any)["resourceAttributes"].(map[string]any)
		item["status"] = map[string]any{"allowed": allow(attrs)}
		b, _ := json.Marshal(item)
		out.Write(append(b, '\n'))
	}
	return out.Bytes()
}

// The self-check of both accounts: the reviews it sends, through which transport, and what it
// refuses.
func TestJobChecks(t *testing.T) {
	ns := "md-runbook-ops"
	ops := opsReviews(ns)
	// The gate's rules: Jobs, pods and exec in its namespace, nothing else.
	opsRBAC := func(a map[string]any) bool {
		if a["namespace"] != ns {
			return false
		}
		switch a["resource"].(string) + "/" + str(a["subresource"]) + " " + a["verb"].(string) {
		case "jobs/ create", "jobs/ list", "jobs/ delete", "pods/ get", "pods/ list", "pods/exec create":
			return true
		}
		return false
	}
	var gotArgv []string

	extra := ""
	run := func(argv, env []string, stdin []byte) ([]byte, error) {
		gotArgv = argv
		return answersFor(t, stdin, func(a map[string]any) bool {
			return opsRBAC(a) || (extra != "" && a["resource"] == extra)
		}), nil
	}
	j := testJob(run)
	if p := j.check(ops, "", "the gate's service account"); len(p) != 0 {
		t.Errorf("good ops account: %q", p)
	}
	if !reflect.DeepEqual(gotArgv, []string{"/usr/bin/kubectl", "create", "-f", "-", "-o", "json"}) {
		t.Errorf("ops argv %q", gotArgv)
	}
	// The cells' rights given to the gate's account too: refused, naming them.
	extra = "secrets"
	if p := j.check(ops, "", "the gate's service account"); len(p) != 1 || p[0] != "the gate's service account may get secrets in md-runbook-ops" {
		t.Errorf("ops with secrets: %q", p)
	}
	extra = "deployments"
	if p := j.check(ops, "", "the gate's service account"); len(p) != 1 || p[0] != "the gate's service account may patch deployments (apps) in md-runbook-ops" {
		t.Errorf("ops with deployments: %q", p)
	}
	extra = ""

	// The cells' account: checked in the Job's pod, through the cells' mode, before any block.
	cells := cellsReviews(ns)
	cellsAllowed := map[string]bool{}
	run2 := func(argv, env []string, stdin []byte) ([]byte, error) {
		gotArgv = argv
		r := bytes.NewReader(stdin)
		req, err := readCellsReq(r)
		if err != nil {
			t.Fatal(err)
		}
		if req.Op != "exec" || !reflect.DeepEqual(req.Argv, []string{"/usr/bin/kubectl", "create", "-f", "-", "-o", "json"}) || req.Env[0] != "PATH=/usr/local/bin:/usr/bin:/bin" {
			t.Errorf("request %+v", req)
		}
		rest, _ := io.ReadAll(r)
		return answersFor(t, rest, func(a map[string]any) bool {
			return cellsAllowed[a["verb"].(string)+" "+a["resource"].(string)+"/"+str(a["subresource"])+" "+str(a["namespace"])]
		}), nil
	}
	j = testJob(run2)
	if p := j.check(cells, "pod-1", "the cells' service account md-runbook-cells"); len(p) != 0 {
		t.Errorf("good cells account: %q", p)
	}
	if !reflect.DeepEqual(gotArgv, j.execArgv("pod-1")) {
		t.Errorf("cells argv %q", gotArgv)
	}
	for right, want := range map[string]string{
		"create pods/exec md-runbook-ops":               "may create pods/exec in md-runbook-ops",
		"get pods/log md-runbook-ops":                   "may get pods/log in md-runbook-ops",
		"list secrets/ md-runbook-ops":                  "may list secrets in md-runbook-ops",
		"watch secrets/ md-runbook-ops":                 "may watch secrets in md-runbook-ops",
		"get configmaps/ md-runbook-ops":                "may get configmaps in md-runbook-ops",
		"patch configmaps/ md-runbook-ops":              "may patch configmaps in md-runbook-ops",
		"patch pods/ephemeralcontainers md-runbook-ops": "may patch pods/ephemeralcontainers in md-runbook-ops",
		"delete jobs/ md-runbook-ops":                   "may delete jobs (batch) in md-runbook-ops",
		"create jobs/ md-runbook-ops":                   "may create jobs (batch) in md-runbook-ops",
		"create serviceaccounts/token md-runbook-ops":   "may create serviceaccounts/token in md-runbook-ops",
		"create clusterrolebindings/ ":                  "may create clusterrolebindings (rbac.authorization.k8s.io) in every namespace",
		"escalate roles/ md-runbook-ops":                "may escalate roles (rbac.authorization.k8s.io) in md-runbook-ops",
		"get nodes/proxy ":                              "may get nodes/proxy in every namespace",
		"impersonate serviceaccounts/ ":                 "may impersonate serviceaccounts in every namespace",
		"impersonate users/ md-runbook-ops":             "may impersonate users in md-runbook-ops",
	} {
		cellsAllowed = map[string]bool{right: true}
		p := j.check(cells, "pod-1", "the cells' service account md-runbook-cells")
		if len(p) != 1 || p[0] != "the cells' service account md-runbook-cells "+want {
			t.Errorf("%s: %q", right, p)
		}
	}
	// No answer, a failed kubectl, or garbage: refused.
	for name, run := range map[string]runFunc{
		"failed": func(argv, env []string, stdin []byte) ([]byte, error) {
			return nil, errors.New("exit status 1: forbidden")
		},
		"garbage": func(argv, env []string, stdin []byte) ([]byte, error) { return []byte("{"), nil },
		"partial": func(argv, env []string, stdin []byte) ([]byte, error) {
			return []byte(`{"kind":"SelfSubjectAccessReview","spec":{"resourceAttributes":{"verb":"create","group":"batch","resource":"jobs","namespace":"md-runbook-ops"}},"status":{"allowed":true}}`), nil
		},
	} {
		if p := testJob(run).check(ops, "", "the gate's service account"); len(p) == 0 {
			t.Errorf("%s: accepted", name)
		}
	}
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// The reviews themselves: the gate's account must run Jobs and exec; the cells' account gets no
// exec, logs, Secrets or workloads in the gate's namespace.
func TestReviewLists(t *testing.T) {
	var list struct {
		Kind  string `json:"kind"`
		Items []struct {
			Kind string `json:"kind"`
			Spec struct {
				ResourceAttributes map[string]string `json:"resourceAttributes"`
			} `json:"spec"`
		} `json:"items"`
	}
	rs := cellsReviews("ops")
	if err := json.Unmarshal(reviewList(rs), &list); err != nil || list.Kind != "List" || len(list.Items) != len(rs) {
		t.Fatalf("%+v %v", list, err)
	}
	if a := list.Items[0].Spec.ResourceAttributes; list.Items[0].Kind != "SelfSubjectAccessReview" || !reflect.DeepEqual(a, map[string]string{"verb": "create", "resource": "pods", "subresource": "exec", "namespace": "ops"}) {
		t.Errorf("first: %+v", list.Items[0])
	}
	seen := map[string]bool{}
	for _, r := range rs {
		if r.want {
			t.Errorf("cells may %s", r)
		}
		seen[r.verb+" "+r.resource+"/"+r.sub] = true
	}
	for _, must := range []string{"create pods/exec", "get pods/exec", "get pods/log", "get secrets/", "create pods/", "patch pods/", "create jobs/", "patch deployments/", "update configmaps/", "create serviceaccounts/token"} {
		if !seen[must] {
			t.Errorf("cells' check lacks %s", must)
		}
	}
	need := map[string]bool{}
	for _, r := range opsReviews("ops") {
		need[r.verb+" "+r.resource+"/"+r.sub+" "+r.ns] = r.want
	}
	for k, want := range map[string]bool{"create jobs/ ops": true, "delete jobs/ ops": true, "create pods/exec ops": true, "list pods/ ": false, "get secrets/ ops": false, "create pods/ ops": false} {
		if got, ok := need[k]; !ok || got != want {
			t.Errorf("ops check: %s = %v, %v", k, got, ok)
		}
	}
}

// Probe events from the pod are logged as the gate's, for this session's runs only.
func TestProbeEvent(t *testing.T) {
	runs := map[string]bool{"0000aa01": true}
	line := `{"time":"2026-11-16T10:00:00Z","account":"root","who":"forged","client":"1.2.3.4","event":"probe","run":"0000aa01","target":"api:443","address":"10.0.0.1","result":"ok","detail":"fine","days_left":"30","not_after":"2026-12-16","cert_sha256":"ab","extra":"x","port":443}`
	kv, ok := probeEvent(line, runs)
	want := []string{"event", "probe", "run", "0000aa01", "target", "api:443", "address", "10.0.0.1", "result", "ok", "detail", "fine", "days_left", "30", "not_after", "2026-12-16", "cert_sha256", "ab", "source", "job"}
	if !ok || !reflect.DeepEqual(kv, want) {
		t.Errorf("%q %v", kv, ok)
	}
	// Only events of this session's signed runs.
	if kv, ok := probeEvent(`{"event":"probe","target":"x:1","result":"fail"}`, runs); ok {
		t.Errorf("no run: %q", kv)
	}
	for name, l := range map[string]string{
		"another run": `{"event":"probe","run":"0000bb02","target":"x"}`,
		"not a probe": `{"event":"end","id":"0000aa01","exit":0}`,
		"not json":    `{"event":"probe"`,
		"too long":    `{"event":"probe","detail":"` + strings.Repeat("x", 9000) + `"}`,
		"an exit":     "1\t0\t2026-11-16T10:00:00Z\tn1\t",
	} {
		if _, ok := probeEvent(l, runs); ok {
			t.Errorf("%s: logged", name)
		}
	}
}

// What the follower forwards from the pod's files, and what the gate takes of it.
func TestFollowFiles(t *testing.T) {
	dir := t.TempDir()
	a, b := dir+"/exits", dir+"/probe.log"
	in, inW := io.Pipe()
	var out bytes.Buffer
	done := make(chan struct{})
	go func() {
		// (out is read only after the follower ended.)
		followFiles([]string{a, b}, in, &out, 10*time.Millisecond)
		close(done)
	}()
	app := func(p, s string) {
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		f.WriteString(s)
		f.Close()
	}
	app(a, "1\t0\tT\tn1\t\n2\t")
	time.Sleep(50 * time.Millisecond)
	app(a, "3\tT\tn2\t\n"+strings.Repeat("x", followLineMax+10)+"\nafter\n")
	app(b, `{"event":"probe"}`+"\n")
	time.Sleep(50 * time.Millisecond)
	// Truncated: read again from its start.
	os.WriteFile(a, []byte("again\n"), 0o600)
	time.Sleep(50 * time.Millisecond)
	app(b, "last\n")
	inW.Close()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the follower didn't end with its stdin")
	}
	// The long line and the shorter file are said, for the gate to end the session.
	want := "0\t1\t0\tT\tn1\t\n0\t2\t3\tT\tn2\t\n!0\ta line is over 16384 bytes\n0\tafter\n1\t{\"event\":\"probe\"}\n!0\tit got shorter\n0\tagain\n1\tlast\n"
	if out.String() != want {
		t.Errorf("forwarded:\n%q\nwant\n%q", out.String(), want)
	}
}

// What the gate takes of the follower's stream: exits as from separated mode's exits file, probe
// events of this session's runs under its own names; anything else ends the session (M1).
func TestFollowLines(t *testing.T) {
	newGate := func(dir string) *Gate {
		g := &Gate{log: &logx.Logger{Dest: dir + "/gate.log", Account: "ops", Who: "SHA256:key", Client: "10.0.0.9"}, job: &kubeJob{}}
		g.sepRuns = map[string]sepRun{"1": {"0000aa01", "n1"}, "2": {"0000aa02", "n2"}}
		g.sepExits = map[string]report.Exit{}
		g.endCh = make(chan struct{}, 1)
		return g
	}
	dir := t.TempDir()
	g := newGate(dir)
	g.job.closing.Store(true)
	good := "1\t" + `{"event":"probe","who":"forged","run":"0000aa01","target":"api:443","result":"ok"}` + "\n" +
		"0\t1\t0\t2026-11-16T10:00:01Z\tn1\t\n" +
		"1\tnot a probe event\n" +
		"!1\tit got shorter\n" +
		"1\t" + `{"event":"probe","run":"0000ff99","target":"x"}` + "\n"
	g.followLines(strings.NewReader(good))
	if ex := g.sepExitsCopy(); g.exitsBadNow() != "" || ex["1"] != (report.Exit{RC: "0", Time: "2026-11-16T10:00:01Z"}) || len(ex) != 1 {
		t.Errorf("exits: %+v (%s)", ex, g.exitsBadNow())
	}
	data, _ := os.ReadFile(dir + "/gate.log")
	log := string(data)
	if !strings.Contains(log, `"account":"ops","who":"SHA256:key","client":"10.0.0.9","event":"probe","run":"0000aa01","target":"api:443","result":"ok","source":"job"}`) ||
		strings.Count(log, `"event":"probe"`) != 1 || strings.Contains(log, "forged") || !strings.Contains(log, `"event":"end","id":"0000aa01","exit":0}`) {
		t.Errorf("log:\n%s", log)
	}
	for name, c := range map[string]struct {
		stream  string
		closing bool
		want    string
	}{
		"forged random number": {"0\t2\t3\t2026-11-16T10:00:00Z\tforged\t\n", true, "without its random number"},
		"a second line":        {"0\t1\t0\t2026-11-16T10:00:01Z\tn1\t\n0\t1\t0\t2026-11-16T10:00:01Z\tn1\t\n", true, "a second line for run 1"},
		"no tab":               {"garbage\n", true, "doesn't parse"},
		"unknown source":       {"7\tx\n", true, "doesn't parse"},
		"long exit line":       {"0\t" + strings.Repeat("1", 5000) + "\n", true, "over 4096 bytes"},
		"long stream line":     {strings.Repeat("y", followLineMax+100) + "\n", true, "over 16384 bytes"},
		"exits file shorter":   {"!0\tit got shorter\n", true, "it got shorter"},
		"follower killed":      {"0\t1\t0\t2026-11-16T10:00:01Z\tn1\t\n", false, "the exits follower in the pod ended"},
	} {
		g := newGate(t.TempDir())
		g.job.closing.Store(c.closing)
		g.followLines(strings.NewReader(c.stream))
		if !strings.Contains(g.exitsBadNow(), c.want) {
			t.Errorf("%s: %q", name, g.exitsBadNow())
		}
		select {
		case <-g.endCh:
		default:
			t.Errorf("%s: the session goes on", name)
		}
	}
}

// In the pod: a shell's pid where stop and end find it; stop reaches what runs under it, end its
// whole group too.
func TestShellsInPod(t *testing.T) {
	if !procs.HaveProc() {
		t.Skip("needs /proc")
	}
	jobShells = t.TempDir() + "/shells"
	defer func() { jobShells = "/tmp/.md-runbook-gate-shells" }()
	start := func() *exec.Cmd {
		cmd := exec.Command("/bin/sh", "-c", "sleep 30 & sleep 30 & wait")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		return cmd
	}
	write := func(n, pid int) {
		os.MkdirAll(jobShells, 0o700)
		os.WriteFile(shellFile(n), []byte(itoa(pid)+"\n"), 0o600)
	}
	kids := func(pid int) []int {
		for i := 0; i < 50; i++ {
			list, _ := procs.List()
			if d := procs.Descendants(list, pid); len(d) == 2 {
				return d
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("no children")
		return nil
	}
	gone := func(pids ...int) bool {
		for i := 0; i < 100; i++ {
			left := 0
			for _, p := range pids {
				var ws syscall.WaitStatus
				syscall.Wait4(p, &ws, syscall.WNOHANG, nil)
				if syscall.Kill(p, 0) == nil {
					left++
				}
			}
			if left == 0 {
				return true
			}
			time.Sleep(20 * time.Millisecond)
		}
		return false
	}
	// stop: the children end, the shell lives on (its `wait` returns).
	a := start()
	write(1, a.Process.Pid)
	ka := kids(a.Process.Pid)
	if shellPid(1) != a.Process.Pid || shellPid(2) != 0 || shellPid(0) != 0 {
		t.Errorf("shellPid")
	}
	if rc := stopShell(1, syscall.SIGTERM); rc != 0 {
		t.Errorf("stop: %d", rc)
	}
	a.Wait()
	if !gone(ka...) {
		t.Error("stop left children")
	}
	// end: the shell and its group.
	b := start()
	write(2, b.Process.Pid)
	kb := kids(b.Process.Pid)
	go b.Wait()
	endShells([]int{2})
	if !gone(append(kb, b.Process.Pid)...) {
		t.Error("end left processes")
	}
	if _, err := os.Stat(shellFile(2)); err == nil {
		t.Error("end kept the pid file")
	}
	if rc := stopShell(9, syscall.SIGTERM); rc != 1 {
		t.Errorf("stop of no shell: %d", rc)
	}
}

// A shell request in a Job carries its number; the framing is the sudo one.
func TestJobShellRequest(t *testing.T) {
	req := cellsReq{Op: "exec", Argv: []string{"/usr/bin/bash", "--noprofile", "--norc"}, Env: []string{"PATH=/usr/bin"}, Shell: 3}
	got := decodeHeader(t, req.encode())
	if !reflect.DeepEqual(got, req) {
		t.Errorf("%+v", got)
	}
	for _, r := range []cellsReq{{Op: "stop", Shell: 2, Sig: 15}, {Op: "end", Shells: []int{1, 2}}, {Op: "follow", Paths: []string{"/tmp/x"}, Events: true}} {
		if got := decodeHeader(t, r.encode()); !reflect.DeepEqual(got, r) {
			t.Errorf("%+v", got)
		}
	}
}

// The image the Job runs: the gate's pod's own, by digest where a registry can serve it.
func TestPinImage(t *testing.T) {
	d := strings.Repeat("ab", 32)
	for _, c := range []struct{ image, id, want string }{
		{"ghcr.io/smojon/md-runbook-ops:latest", "ghcr.io/smojon/md-runbook-ops@sha256:" + d, "ghcr.io/smojon/md-runbook-ops@sha256:" + d},
		{"ghcr.io/smojon/md-runbook-ops:latest", "docker-pullable://ghcr.io/smojon/md-runbook-ops@sha256:" + d, "ghcr.io/smojon/md-runbook-ops@sha256:" + d},
		{"localhost:5000/ops", "localhost:5000/ops@sha256:" + d, "localhost:5000/ops@sha256:" + d},
		// A local image (kind load): no registry to pull the digest from.
		{"md-runbook-ops:ci", "docker.io/library/md-runbook-ops@sha256:" + d, "md-runbook-ops:ci"},
		{"md-runbook-ops:ci", "sha256:" + d, "md-runbook-ops:ci"},
		// Another repository than the spec names, or no digest: the spec's.
		{"ghcr.io/smojon/md-runbook-ops:latest", "ghcr.io/evil/ops@sha256:" + d, "ghcr.io/smojon/md-runbook-ops:latest"},
		{"ghcr.io/smojon/md-runbook-ops:latest", "", "ghcr.io/smojon/md-runbook-ops:latest"},
		{"ghcr.io/smojon/md-runbook-ops:latest", "ghcr.io/smojon/md-runbook-ops@sha256:short", "ghcr.io/smojon/md-runbook-ops:latest"},
	} {
		if got := pinImage(c.image, c.id); got != c.want {
			t.Errorf("pinImage(%q, %q) = %q", c.image, c.id, got)
		}
	}
	pod := `{"kind":"Pod","metadata":{"uid":"u"},"spec":{"containers":[{"name":"ops","image":"ghcr.io/smojon/md-runbook-ops:0.29.0"}]},` +
		`"status":{"containerStatuses":[{"name":"ops","imageID":"ghcr.io/smojon/md-runbook-ops@sha256:` + d + `"}]}}`
	if _, img, err := parseOwnPod([]byte(pod)); err != nil || img != "ghcr.io/smojon/md-runbook-ops@sha256:"+d {
		t.Errorf("parseOwnPod: %q %v", img, err)
	}
}

// Every namespace where the cells may start or change workloads enforces Pod Security baseline
// or restricted (review of 0.29.0, H2).
func TestUnguardedNamespaces(t *testing.T) {
	nsList := []byte(`{"kind":"List","items":[
		{"kind":"Namespace","metadata":{"name":"default","labels":{"pod-security.kubernetes.io/enforce":"baseline"}}},
		{"kind":"Namespace","metadata":{"name":"shop"}},
		{"kind":"Namespace","metadata":{"name":"kube-system"}},
		{"kind":"Namespace","metadata":{"name":"lab","labels":{"pod-security.kubernetes.io/enforce":"privileged"}}},
		{"kind":"Namespace","metadata":{"name":"gone"}}]}`)
	nss, _ := kubeObjects(nsList)
	read := `{"verbs":["get","list","watch"],"apiGroups":["","apps"],"resources":["pods","deployments"]}`
	rr := func(ns, rules string, incomplete bool) string {
		inc := ""
		if incomplete {
			inc = `,"incomplete":true`
		}
		// As the API server answers it: no spec (the namespace asked isn't in the answer).
		return `{"kind":"SelfSubjectRulesReview","spec":{},"status":{"resourceRules":[` + rules + `]` + inc + `}}` + "\n"
	}
	operate := read + `,{"verbs":["patch"],"apiGroups":["apps"],"resources":["deployments"]}`
	names := []string{"default", "shop", "kube-system", "lab"} // "gone": not asked
	out := rr("default", operate, false) + rr("shop", operate, false) + rr("kube-system", read, false) +
		rr("lab", `{"verbs":["*"],"apiGroups":["batch"],"resources":["*"]}`, false)
	p := unguardedNamespaces(nss, names, []byte(out))
	got := strings.Join(p, "\n")
	for _, ns := range []string{"namespace shop,", "namespace lab,", "namespace gone,"} {
		if !strings.Contains(got, ns) {
			t.Errorf("lacks %s:\n%s", ns, got)
		}
	}
	if strings.Contains(got, "default") || strings.Contains(got, "kube-system") || len(p) != 3 {
		t.Errorf("refused:\n%s", got)
	}
	if !strings.Contains(got, "kubectl label namespace shop pod-security.kubernetes.io/enforce=baseline") {
		t.Errorf("no command:\n%s", got)
	}
	// An incomplete answer counts as may.
	if p := unguardedNamespaces(nss[2:3], names[2:3], []byte(rr("kube-system", read, true))); len(p) != 1 || !strings.Contains(p[0], "incomplete") {
		t.Errorf("incomplete: %q", p)
	}
	// Read-only namespaces without a label pass (kind's kube-system, kube-public, ...).
	if p := unguardedNamespaces(nss[1:3], []string{"shop", "kube-system"}, []byte(rr("shop", read, false)+rr("kube-system", read, false))); len(p) != 0 {
		t.Errorf("read only: %q", p)
	}
	// Answers that don't add up: refused.
	if p := unguardedNamespaces(nss, names, []byte(rr("default", read, false))); len(p) != 1 || !strings.Contains(p[0], "1 answers for 4 namespaces") {
		t.Errorf("short: %q", p)
	}
	wrong := `{"kind":"SelfSubjectRulesReview","spec":{"namespace":"lab"},"status":{}}` + "\n"
	if p := unguardedNamespaces(nss[2:3], names[2:3], []byte(wrong)); len(p) != 1 || !strings.Contains(p[0], "in the place of kube-system") {
		t.Errorf("misplaced: %q", p)
	}
	for _, c := range []struct {
		rule string
		may  bool
	}{
		{`{"verbs":["create"],"apiGroups":[""],"resources":["pods"]}`, true},
		{`{"verbs":["update"],"apiGroups":[""],"resources":["pods/*"]}`, true},
		{`{"verbs":["patch"],"apiGroups":[""],"resources":["pods/ephemeralcontainers"]}`, true},
		{`{"verbs":["*"],"apiGroups":["*"],"resources":["*"]}`, true},
		{`{"verbs":["create"],"apiGroups":["batch"],"resources":["cronjobs"]}`, true},
		{`{"verbs":["patch","update"],"apiGroups":["apps"],"resources":["deployments/scale"]}`, false},
		{`{"verbs":["create"],"apiGroups":[""],"resources":["pods/exec"]}`, false},
		{`{"verbs":["get","list"],"apiGroups":["*"],"resources":["*"]}`, false},
		{`{"verbs":["create"],"apiGroups":["apps"],"resources":["pods"]}`, false},
	} {
		var r kubeRule
		json.Unmarshal([]byte(c.rule), &r)
		if startsWorkloads(r) != c.may {
			t.Errorf("%s: %v", c.rule, !c.may)
		}
	}
	var list struct {
		Items []struct {
			Kind string `json:"kind"`
			Spec struct {
				Namespace string `json:"namespace"`
			} `json:"spec"`
		} `json:"items"`
	}
	if json.Unmarshal(rulesReviewList([]string{"a", "b"}), &list) != nil || len(list.Items) != 2 || list.Items[1].Kind != "SelfSubjectRulesReview" || list.Items[1].Spec.Namespace != "b" {
		t.Errorf("rules reviews: %+v", list)
	}
}

// A session not cut short: each signed run has its exit, or the exits count for nothing.
func TestJobMissingExits(t *testing.T) {
	newGate := func() *Gate {
		g := &Gate{log: &logx.Logger{Dest: t.TempDir() + "/gate.log"}, job: &kubeJob{}}
		g.sepRuns = map[string]sepRun{"1": {"0000aa01", "n1"}, "2": {"0000aa02", "n2"}}
		g.sepExits = map[string]report.Exit{"1": {RC: "0"}}
		g.runs = 2
		g.endCh = make(chan struct{}, 1)
		return g
	}
	g := newGate()
	g.jobMissingExits(false)
	if !strings.Contains(g.exitsBadNow(), "no exit came back for run 2") {
		t.Errorf("missing: %q", g.exitsBadNow())
	}
	g = newGate()
	g.jobMissingExits(true)
	if g.exitsBadNow() != "" {
		t.Errorf("cut short: %q", g.exitsBadNow())
	}
	g = newGate()
	g.sepExits["2"] = report.Exit{RC: "1"}
	g.jobMissingExits(false)
	if g.exitsBadNow() != "" {
		t.Errorf("complete: %q", g.exitsBadNow())
	}
}

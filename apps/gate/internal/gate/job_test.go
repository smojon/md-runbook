//go:build unix

package gate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"reflect"
	"regexp"
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
		"local with audit who":   {func(c *config.Config) { c.CellsRunner, c.JobServiceAccount, c.JobAuditWho = "local", "", true }, "job_audit_who is for cells_runner = kubernetes-job only"},
		"audit who, kubeconfig":  {func(c *config.Config) { c.JobAuditWho, c.Kubeconfig = true, "/etc/kube/config" }, "job_audit_who = yes doesn't go with kubeconfig ="},
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
	audit := job
	audit.JobAuditWho = true
	if p := runnerProblem(audit, conf); p != "" {
		t.Errorf("job_audit_who: %s", p)
	}
}

// job_audit_who: the Job's env carries the impersonation for md-runbook-ops-start; without it,
// only CLUSTER_NAME.
func TestJobManifestAuditWho(t *testing.T) {
	envOf := func(s jobSpec) []any {
		var job map[string]any
		if err := json.Unmarshal(jobManifest(s), &job); err != nil {
			t.Fatal(err)
		}
		return at(t, job, "spec", "template", "spec", "containers", 0, "env").([]any)
	}
	if env := envOf(testSpec); len(env) != 1 {
		t.Errorf("without job_audit_who: %v", env)
	}
	s := testSpec
	s.As, s.Who = "system:serviceaccount:md-runbook-ops:md-runbook-cells", "alice@example 'x'"
	want := []any{
		map[string]any{"name": "CLUSTER_NAME", "value": "prod-eu"},
		map[string]any{"name": "MD_RUNBOOK_KUBE_AS", "value": s.As},
		map[string]any{"name": "MD_RUNBOOK_KUBE_WHO", "value": s.Who},
	}
	if env := envOf(s); !reflect.DeepEqual(env, want) {
		t.Errorf("with job_audit_who: %v", env)
	}
	// The kubelet expands $(VAR) in env values, and $$ is a $: each $ doubles (review, L1).
	s.Who = "a$(HOME)$$b$"
	if env := envOf(s); at(t, env, 2, "value") != "a$$(HOME)$$$$b$$" {
		t.Errorf("a who with $: %v", env)
	}
}

// md-runbook-ops-start cells writes the impersonation into the kubeconfig as YAML single-quoted
// strings: a who with the characters YAML, sh or the kubelet would read comes back as it was.
func TestStartImpersonation(t *testing.T) {
	src, err := os.ReadFile("../../../ops/start.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(src), "\r\n", "\n")
	i := strings.Index(text, "\nimpersonation() {\n")
	if i < 0 {
		t.Fatal("start.sh: no impersonation()")
	}
	fn := text[i : i+strings.Index(text[i:], "\n}\n")+3]
	run := func(mode, as, who string) string {
		cmd := exec.Command("/bin/sh", "-c", fn+`impersonation "$1"`, "sh", mode)
		cmd.Env = []string{"PATH=/usr/bin:/bin", "MD_RUNBOOK_KUBE_AS=" + as, "MD_RUNBOOK_KUBE_WHO=" + who}
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	const as = "system:serviceaccount:md-runbook-ops:md-runbook-cells"
	who := `o'brien #1: {x} $HOME $(id) \n "q" ''`
	got := run("cells", as, who)
	quoted := "'" + strings.ReplaceAll(who, "'", "''") + "'"
	want := "    as: '" + as + "'\n    as-user-extra:\n      md-runbook.dev/operator:\n      - " + quoted + "\n"
	if got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
	// Unquoted as YAML reads it: the same who.
	if back := strings.ReplaceAll(quoted[1:len(quoted)-1], "''", "'"); back != who {
		t.Errorf("back %q", back)
	}
	// The ops pod (no cells), or no job_audit_who: nothing.
	if got := run("", as, who); got != "" {
		t.Errorf("ops: %q", got)
	}
	if got := run("cells", "", ""); got != "" {
		t.Errorf("without: %q", got)
	}
}

// What who may be in the impersonation's extra.
func TestAuditWhoProblem(t *testing.T) {
	for _, ok := range []string{"alice@example", "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU", "Alice Smith (on-call)", "a'b\"c\\d", strings.Repeat("x", 256)} {
		if p := auditWhoProblem(ok); p != "" {
			t.Errorf("%q: %s", ok, p)
		}
	}
	for who, want := range map[string]string{
		"":                       "no name",
		strings.Repeat("x", 257): "longer than 256",
		" alice":                 "space at either end",
		"alice ":                 "space at either end",
		"alice\nbob":             "printable ASCII",
		"al\tice":                "printable ASCII",
		"alicé":                  "printable ASCII",
		"alice\x7f":              "printable ASCII",
	} {
		if p := auditWhoProblem(who); !strings.Contains(p, want) {
			t.Errorf("%q: %q, want %s", who, p, want)
		}
	}
}

// The check in the Job's pod: kubectl auth whoami, through the cells' mode, before any block.
func TestCheckAuditWho(t *testing.T) {
	const as = "system:serviceaccount:md-runbook-ops:md-runbook-cells"
	good := `{"kind":"SelfSubjectReview","apiVersion":"authentication.k8s.io/v1","status":{"userInfo":{"username":"` + as + `","groups":["system:serviceaccounts","system:serviceaccounts:md-runbook-ops","system:authenticated"],"extra":{"md-runbook.dev/operator":["alice@example"]}}}}`
	var argv []string
	out, fail := good, error(nil)
	run := func(a, env []string, stdin []byte) ([]byte, error) {
		argv = a
		req, err := readCellsReq(bytes.NewReader(stdin))
		if err != nil || req.Op != "exec" || !reflect.DeepEqual(req.Argv, []string{"/usr/bin/kubectl", "auth", "whoami", "-o", "json"}) {
			t.Errorf("request %+v %v", req, err)
		}
		return []byte(out), fail
	}
	j := testJob(run)
	j.as, j.who = as, "alice@example"
	if p := j.checkAuditWho("pod-1"); p != "" {
		t.Errorf("good: %s", p)
	}
	if !reflect.DeepEqual(argv, j.execArgv("pod-1")) {
		t.Errorf("argv %q", argv)
	}
	fail = errors.New(`exit status 1: users "system:serviceaccount:md-runbook-ops:md-runbook-cells" is forbidden: User "system:serviceaccount:md-runbook-ops:md-runbook-cells" cannot impersonate resource "serviceaccounts"`)
	if p := j.checkAuditWho("pod-1"); !strings.Contains(p, "kubectl auth whoami failed") || !strings.Contains(p, "impersonation.yaml") {
		t.Errorf("refused: %s", p)
	}
	fail = nil
	// Not impersonating (an older image): the pod's own extras, no who.
	plain := `{"kind":"SelfSubjectReview","status":{"userInfo":{"username":"` + as + `","extra":{"authentication.kubernetes.io/pod-name":["md-runbook-cells-x"]}}}}`
	for name, c := range map[string]struct{ out, want string }{
		"plain":      {plain, "doesn't carry who"},
		"other who":  {strings.Replace(good, "alice@example", "mallory@example", 1), "doesn't carry who"},
		"two values": {strings.Replace(good, `["alice@example"]`, `["alice@example","bob"]`, 1), "doesn't carry who"},
		"more extra": {strings.Replace(good, `"extra":{`, `"extra":{"scopes":["x"],`, 1), "other extras"},
		"other user": {strings.Replace(good, as, "system:serviceaccount:md-runbook-ops:md-runbook-ops", 1), "not " + as},
		"garbage":    {"{", "can't read"},
		"other kind": {strings.Replace(good, "SelfSubjectReview", "Status", 1), "can't read"},
	} {
		out = c.out
		if p := j.checkAuditWho("pod-1"); !strings.Contains(p, c.want) {
			t.Errorf("%s: %q, want %s", name, p, c.want)
		}
	}
}

// The cells' impersonation beyond job_audit_who's rule: refused, by name too.
func TestCellsImpersonationReviews(t *testing.T) {
	rs := cellsReviews("md-runbook-ops", "md-runbook-cells", "md-runbook-ops")
	byKey := map[string]review{}
	for _, r := range rs {
		byKey[r.verb+" "+r.group+" "+r.resource+"/"+r.sub+" "+r.ns+" "+r.name] = r
	}
	for _, k := range []string{
		"impersonate  serviceaccounts/ md-runbook-ops ",                                        // any of the namespace (no resourceNames)
		"impersonate  serviceaccounts/  ",                                                      // any, anywhere
		"impersonate  serviceaccounts/ md-runbook-ops md-runbook-ops",                          // the gate's own
		"impersonate  groups/  system:masters",                                                 // by name
		"impersonate  users/  ",                                                                // any user
		"impersonate authentication.k8s.io uids/  ",                                            // uids
		"impersonate authentication.k8s.io userextras/authentication.kubernetes.io/pod-name  ", // the API server's extras
		"impersonate authentication.k8s.io userextras/authentication.kubernetes.io/node-uid  ",
		"impersonate:serviceaccount authentication.k8s.io serviceaccounts/  ", // constrained impersonation
		"impersonate:serviceaccount authentication.k8s.io serviceaccounts/ md-runbook-ops ",
		"impersonate:user-info authentication.k8s.io users/  ",
		"impersonate:associated-node authentication.k8s.io nodes/  ",
	} {
		if r, ok := byKey[k]; !ok || r.want {
			t.Errorf("no refusing review %q", k)
		}
	}
	// A named allowance is reported with its name.
	j := testJob(func(argv, env []string, stdin []byte) ([]byte, error) {
		return answersFor(t, stdin, func(a map[string]any) bool {
			return a["verb"] == "impersonate" && a["name"] == "md-runbook-ops"
		}), nil
	})
	p := j.check(rs, "", "the cells' service account md-runbook-cells")
	if len(p) != 1 || p[0] != "the cells' service account md-runbook-cells may impersonate serviceaccounts md-runbook-ops in md-runbook-ops" {
		t.Errorf("%q", p)
	}
	// Without the gate's account's name (its pod named none), that review is left out.
	for _, r := range cellsReviews("md-runbook-ops", "md-runbook-cells", "") {
		if r.ns == "md-runbook-ops" && r.name != "" {
			t.Errorf("review %s", r)
		}
	}
	// Nothing about service accounts of other namespaces: Kubernetes' edit role there grants
	// that (impersonationRules and namespaceRights handle it).
	for _, r := range rs {
		if r.resource == "serviceaccounts" && r.ns != "" && r.ns != "md-runbook-ops" {
			t.Errorf("review %s", r)
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

// The gate's namespace holds the ops host alone: its pods (the gate's and the Jobs'), and the
// service accounts ops, cells and default (nevis-rest-api's review, 2026-11-17).
func TestOwnNamespace(t *testing.T) {
	pod := func(name, sa string) string {
		spec := `{}`
		if sa != "" {
			spec = `{"serviceAccountName":"` + sa + `"}`
		}
		return `{"kind":"Pod","metadata":{"name":"` + name + `"},"spec":` + spec + `}`
	}
	account := func(name string) string { return `{"kind":"ServiceAccount","metadata":{"name":"` + name + `"}}` }
	list := func(items ...string) []byte {
		return []byte(`{"kind":"List","items":[` + strings.Join(items, ",") + `]}`)
	}
	alone := []string{pod("md-runbook-ops-5d8f-abcde", "md-runbook-ops"), pod("md-runbook-cells-0a1b2c3d4e-x7k2p", "md-runbook-cells"),
		account("md-runbook-ops"), account("md-runbook-cells"), account("default")}
	if p := foreignObjects(list(alone...), "md-runbook-ops", "md-runbook-ops", "md-runbook-cells"); p != "" {
		t.Errorf("alone: %s", p)
	}
	// nevis-rest-api's lab before: the relay and the web app next to the ops host.
	shared := append(alone, pod("relay-7c9d-xyz12", ""), pod("web-6b5a-qwe34", "web"), account("web"))
	p := foreignObjects(list(shared...), "md-runbook", "md-runbook-ops", "md-runbook-cells")
	if p != "namespace md-runbook also has pods relay-7c9d-xyz12 (as default), web-6b5a-qwe34 (as web) and service accounts web: the gate could exec into those pods and run Jobs as those accounts. Give the ops host a namespace of its own (apps/ops/README.md)." {
		t.Errorf("shared: %s", p)
	}
	// An account alone (no pod yet) is enough: the gate could run a Job as it.
	if p := foreignObjects(list(append(alone, account("backup"))...), "md-runbook-ops", "md-runbook-ops", "md-runbook-cells"); !strings.Contains(p, "also has service accounts backup: the gate could run Jobs as those accounts. ") {
		t.Errorf("account: %s", p)
	}
	var many []string
	for i := 0; i < 7; i++ {
		many = append(many, account("sa-"+itoa(i)))
	}
	if p := foreignObjects(list(many...), "ns", "md-runbook-ops", "md-runbook-cells"); !strings.Contains(p, "service accounts sa-0, sa-1, sa-2, sa-3, sa-4 and 2 more:") {
		t.Errorf("many: %s", p)
	}
	// Unreadable output, or no own account: refused.
	if p := foreignObjects([]byte("{"), "ns", "md-runbook-ops", "md-runbook-cells"); p == "" {
		t.Error("garbage: accepted")
	}
	if p := foreignObjects(list(alone...), "ns", "", "md-runbook-cells"); p == "" {
		t.Error("no own account: accepted")
	}
	if sa := podServiceAccount([]byte(pod("ops-1", "md-runbook-ops"))); sa != "md-runbook-ops" {
		t.Errorf("own: %q", sa)
	}
	if sa := podServiceAccount([]byte(pod("ops-1", ""))); sa != "default" {
		t.Errorf("own, none named: %q", sa)
	}
	if sa := podServiceAccount([]byte("{")); sa != "" {
		t.Errorf("own, garbage: %q", sa)
	}

	// Through kubectl: one call for both kinds, as the gate's account; a failure refuses.
	var gotArgv []string
	j := testJob(func(argv, env []string, stdin []byte) ([]byte, error) {
		gotArgv = argv
		return list(alone...), nil
	})
	j.opsSA, j.sa = "md-runbook-ops", "md-runbook-cells"
	if p := j.checkOwnNamespace(); p != "" || !reflect.DeepEqual(gotArgv, []string{"/usr/bin/kubectl", "get", "pods,serviceaccounts", "-n", "md-runbook-ops", "-o", "json"}) {
		t.Errorf("%s %q", p, gotArgv)
	}
	j.run = func(argv, env []string, stdin []byte) ([]byte, error) {
		return nil, errors.New("exit status 1: forbidden")
	}
	if p := j.checkOwnNamespace(); !strings.Contains(p, "can't list the pods and service accounts of namespace md-runbook-ops") {
		t.Errorf("failed: %s", p)
	}
}

// The admission policy md-runbook-ops-jobs guards the namespace's Jobs: a dry run of the cells'
// Job as the gate's own service account must be refused by it.
func TestJobPolicy(t *testing.T) {
	denied := errors.New(`exit status 1: Error from server (Invalid): error when creating "STDIN": jobs.batch "md-runbook-cells-check-0a1b2c3d4e" is invalid: : ValidatingAdmissionPolicy 'md-runbook-ops-jobs' with binding 'md-runbook-ops-jobs' denied request: the gate's Jobs run as the service account md-runbook-cells only`)
	var gotArgv []string
	var gotJob map[string]any
	answer := func(err error) runFunc {
		return func(argv, env []string, stdin []byte) ([]byte, error) {
			gotArgv, gotJob = argv, nil
			if e := json.Unmarshal(stdin, &gotJob); e != nil {
				t.Fatal(e)
			}
			if err != nil {
				return nil, err
			}
			return []byte("job.batch/x (server dry run)\n"), nil
		}
	}
	j := testJob(answer(denied))
	j.opsSA, j.sa, j.opsPod, j.opsUID, j.image, j.context = "md-runbook-ops", "md-runbook-cells", testSpec.OpsPod, testSpec.OpsUID, testSpec.Image, "prod-eu"
	if p := j.checkPolicy(); p != "" {
		t.Errorf("refused by the policy: %s", p)
	}
	if !reflect.DeepEqual(gotArgv, []string{"/usr/bin/kubectl", "create", "--dry-run=server", "-f", "-", "-o", "name"}) {
		t.Errorf("argv %q", gotArgv)
	}
	// The cells' Job in all but its account (the gate's own) and its name.
	pod := at(t, gotJob, "spec", "template", "spec")
	if sa := at(t, pod, "serviceAccountName"); sa != "md-runbook-ops" {
		t.Errorf("account %v", sa)
	}
	if name := at(t, gotJob, "metadata", "name").(string); !regexp.MustCompile(`^md-runbook-cells-check-[0-9a-f]{10}$`).MatchString(name) || !config.ValidKubeName(name) {
		t.Errorf("name %q", name)
	}
	if img := at(t, pod, "containers", 0, "image"); img != testSpec.Image {
		t.Errorf("image %v", img)
	}
	if l := at(t, gotJob, "spec", "template", "metadata", "labels", "app.kubernetes.io/name"); l != "md-runbook-cells" {
		t.Errorf("label %v", l)
	}

	// Accepted: no policy (or no binding) guards the namespace.
	j.run = answer(nil)
	if p := j.checkPolicy(); p != "the admission policy md-runbook-ops-jobs doesn't guard the Jobs of namespace md-runbook-ops: a test Job as the gate's own service account md-runbook-ops passed. Apply apps/ops/kubernetes/admission-policy.yaml (Kubernetes 1.30 or later)." {
		t.Errorf("accepted: %s", p)
	}
	// Refused by the API server for another reason (another policy, a webhook, RBAC): refused,
	// with that reason.
	const cant = "can't tell whether the admission policy md-runbook-ops-jobs guards the Jobs of namespace md-runbook-ops: "
	for _, err := range []error{
		errors.New(`exit status 1: Error from server (Forbidden): error when creating "STDIN": jobs.batch "x" is forbidden: ValidatingAdmissionPolicy 'other-policy' with binding 'other' denied request: no`),
		errors.New(`exit status 1: Error from server (Forbidden): jobs.batch is forbidden: User "system:serviceaccount:md-runbook-ops:md-runbook-ops" cannot create resource "jobs"`),
	} {
		j.run = answer(err)
		if p := j.checkPolicy(); p != cant+"a test Job as the gate's own service account was refused for another reason ("+err.Error()+"). Apply apps/ops/kubernetes/admission-policy.yaml (Kubernetes 1.30 or later)." {
			t.Errorf("%v: %s", err, p)
		}
	}
	// kubectl failed, or didn't answer in time: it says so.
	failed := errors.New("exit status 1: error: You must be logged in to the server (Unauthorized)")
	j.run = answer(failed)
	if p := j.checkPolicy(); p != cant+"kubectl failed ("+failed.Error()+")" {
		t.Errorf("failed: %s", p)
	}
	late := fmt.Errorf("%w after 20s (%w)", errTimeout, errors.New("signal: killed"))
	j.run = answer(late)
	if p := j.checkPolicy(); p != cant+"kubectl didn't answer ("+late.Error()+")" {
		t.Errorf("timeout: %s", p)
	}

	// The real Job refused by the policy: job_service_account or job_image doesn't match it.
	if p := createProblem(denied); !strings.HasPrefix(p, "can't create the cells' Job (exit status 1: ") ||
		!strings.HasSuffix(p, "): job_service_account and job_image must match the policy md-runbook-ops-jobs in apps/ops/kubernetes/admission-policy.yaml. Change them together") {
		t.Errorf("create, policy: %s", p)
	}
	if p := createProblem(errors.New("exit status 1: quota")); p != "can't create the cells' Job (exit status 1: quota)" {
		t.Errorf("create: %s", p)
	}
}

// kubectl prints the API server's warnings before its error: the error is what the gate says.
func TestFirstErrLine(t *testing.T) {
	for in, want := range map[string]string{
		"Error from server (Forbidden): no\n":                          "Error from server (Forbidden): no",
		"Warning: would violate x\nWarning: y\nError from server: z\n": "Error from server: z",
		"Warning: only a warning\n":                                    "Warning: only a warning",
		"\n  first\nsecond":                                            "first",
		"":                                                             "",
	} {
		if got := firstErrLine(in); got != want {
			t.Errorf("%q: %q", in, got)
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
	if pod, why := testJob(run).waitPod(sleep, now); pod != "" || !strings.Contains(why, "the session's pod wasn't ready after 180 s") || *n < 300 || *n > 400 {
		t.Errorf("timeout: %q %q after %d", pod, why, *n)
	}
}

// What the client hears of the pod's start (protocol 4): with pod notices, `job` after the
// banner, `starting` before each request that waits, then `ready` or `failed` with the reason,
// once, and nothing after; without them, the gate's line once, and a failure's reason.
func TestPodNotices(t *testing.T) {
	const (
		job      = "\x1e__MDRB_POD__ job\n"
		starting = "\x1e__MDRB_POD__ starting\n"
		ready    = "\x1e__MDRB_POD__ ready\n"
	)
	newJob := func() (*kubeJob, *bytes.Buffer) {
		var out bytes.Buffer
		j := testJob(nil)
		j.out = &out
		return j, &out
	}
	closed := func(j *kubeJob) bool {
		select {
		case <-j.ready:
			return true
		default:
			return false
		}
	}

	// A client that takes pod notices: its probe waits, then runs.
	j, out := newJob()
	if got := j.hello(true); got != job {
		t.Errorf("hello: %q", got)
	}
	j.waitFor("")
	j.waitFor("")
	if out.String() != starting+starting || closed(j) || j.isSettled() {
		t.Errorf("waiting: %q", out.String())
	}
	out.Reset()
	j.settle("md-runbook-cells-0a1b2c3d4e-x7k2p", "")
	j.waitFor("")
	if out.String() != ready || !closed(j) || j.podName() != "md-runbook-cells-0a1b2c3d4e-x7k2p" || !j.isSettled() {
		t.Errorf("ready: %q", out.String())
	}
	if got := j.hello(true); got != "" {
		t.Errorf("hello once the pod is ready: %q", got)
	}

	// The pod won't come: the waiting request hears why, and no second line says it.
	j, out = newJob()
	j.hello(true)
	j.waitFor("")
	j.settle("", "the session's pod wasn't ready after 180 s: see kubectl -n md-runbook-ops describe job x")
	want := starting + "\x1e__MDRB_POD__ failed this session's cells can't start: the session's pod wasn't ready after 180 s: see kubectl -n md-runbook-ops describe job x\n"
	if out.String() != want || !closed(j) || j.podName() != "" {
		t.Errorf("failed: %q", out.String())
	}

	// Told `job`, the pod ready before any request waits: the first request hears `ready` before
	// the shell gets it, and only it (review of 0.30.0, H1: the client reads notices until then,
	// so a block could otherwise fake one).
	j, out = newJob()
	j.hello(true)
	j.settle("p", "")
	if out.String() != "" {
		t.Errorf("ready, nothing waiting yet: %q", out.String())
	}
	j.waitFor("")
	j.waitFor("")
	if out.String() != ready {
		t.Errorf("ready, then requests: %q", out.String())
	}
	// A failure, nothing waiting: the notice at once (no shell will print anything), once.
	j, out = newJob()
	j.hello(true)
	j.settle("", "its pod can't start (ImagePullBackOff: x)")
	j.waitFor("")
	if out.String() != "\x1e__MDRB_POD__ failed this session's cells can't start: its pod can't start (ImagePullBackOff: x)\n" {
		t.Errorf("failed, nothing waiting: %q", out.String())
	}
	// Not told `job` (the pod was ready at the hello): no notice ever.
	j, out = newJob()
	j.settle("p", "")
	if got := j.hello(true); got != "" {
		t.Errorf("hello once settled: %q", got)
	}
	j.waitFor("")
	if out.String() != "" {
		t.Errorf("not told job: %q", out.String())
	}

	// A client before protocol 4 (no pod notices): the gate's line once, as before.
	j, out = newJob()
	if got := j.hello(false); got != "" {
		t.Errorf("hello without notices: %q", got)
	}
	j.waitFor("")
	j.waitFor("")
	j.settle("p", "")
	j.waitFor("")
	if out.String() != "md-runbook-gate: this session's blocks run in a Kubernetes Job of their own ("+testSpec.Name+"): the first one waits for its pod\n" {
		t.Errorf("without notices: %q", out.String())
	}
	j, out = newJob()
	j.hello(false)
	j.waitFor("")
	out.Reset()
	j.settle("", "its pod ended (Failed)")
	if out.String() != "md-runbook-gate: this session's cells can't start: its pod ended (Failed)\n" {
		t.Errorf("failed without notices: %q", out.String())
	}

	// A second hello without pod notices doesn't take `job` back: the request still hears
	// `starting`, and `ready` before the shell gets it (round 2, M-1: the client relies on it).
	j, out = newJob()
	j.hello(true)
	j.hello(false)
	j.waitFor("")
	j.settle("p", "")
	if out.String() != starting+ready {
		t.Errorf("a second hello: %q", out.String())
	}

	// The pod gets ready while requests come: one `ready`, never a `starting` after it.
	for i := 0; i < 200; i++ {
		j, out = newJob()
		j.hello(true)
		go j.settle("p", "")
		for k := 0; k < 3; k++ {
			j.waitFor("")
		}
		<-j.ready
		j.mu.Lock()
		s := out.String()
		j.mu.Unlock()
		if !strings.HasSuffix(s, ready) || strings.Count(s, ready) != 1 {
			t.Fatalf("race: %q", s)
		}
	}
}

// TestLeftWaiting: the client's leaving cuts the session short while the pod starts, and until
// the client had the reply of a request that waited for it (review of 0.30.0, L5: a stop just as
// the pod got ready).
func TestLeftWaiting(t *testing.T) {
	newJob := func() *kubeJob {
		j := testJob(nil)
		j.out = io.Discard
		return j
	}
	// cut: whether leaving cuts the session short, without a wait (wait 0).
	cut := func(j *kubeJob) bool {
		c, _ := j.leftWaiting(0)
		return c
	}
	// Nothing waited: cut until the pod settles, then not.
	j := newJob()
	j.hello(true)
	if c, why := j.leftWaiting(0); !c || why != "the client left while the pod was starting" {
		t.Errorf("before the pod settled: %v %q", c, why)
	}
	j.settle("p", "")
	j.waitFor("")
	if cut(j) {
		t.Error("a request after the pod was ready")
	}
	// A request waited; the pod got ready; the client left before its next line (its stop): cut,
	// and not logged (not a signed run: round 1, L2).
	j = newJob()
	j.hello(true)
	j.spoke()
	j.waitFor("")
	j.spoke() // a line before the pod settled says nothing of the reply
	j.settle("p", "")
	if c, why := j.leftWaiting(0); !c || why != "" {
		t.Errorf("the waiting request's reply not had: %v %q", c, why)
	}
	// Its next line: it had the reply.
	j.spoke()
	if cut(j) {
		t.Error("after the client's next line")
	}
	// A client before protocol 4 (no notices): the same.
	j = newJob()
	j.hello(false)
	j.waitFor("")
	j.settle("p", "")
	if !cut(j) {
		t.Error("without notices, the reply not had")
	}
	j.spoke()
	if cut(j) {
		t.Error("without notices, after the client's next line")
	}

	// A signed run waited: its exit, back through the follower, is its end. A one-shot client
	// that leaves after the reply cuts nothing short and isn't logged as gone (round 2, L-1).
	const notSeen = "the client left within 5 s of the pod getting ready, before run 1 (which waited for the pod) ended: the session is cut short, as for a stop"
	left := func(g *Gate, wait time.Duration) string {
		c, why := g.job.leftWaiting(wait)
		if c != (why != "") {
			t.Errorf("cut %v, logged %q", c, why)
		}
		return why
	}
	newGate := func() *Gate {
		g := &Gate{log: &logx.Logger{Dest: t.TempDir() + "/gate.log"}, job: newJob()}
		g.sepRuns = map[string]sepRun{"1": {"0000aa01", "n1"}, "2": {"0000aa02", "n2"}}
		g.sepExits = map[string]report.Exit{}
		g.endCh = make(chan struct{}, 1)
		g.job.closing.Store(true)
		g.job.hello(true)
		return g
	}
	exit := func(n, nonce string) string { return "0\t" + n + "\t0\t2026-11-16T10:00:01Z\t" + nonce + "\t\n" }
	g := newGate()
	g.job.waitFor("1")
	g.job.settle("p", "")
	if why := left(g, 0); why != notSeen {
		t.Errorf("no exit yet: %q", why)
	}
	// It comes while the gate waits for it.
	go func() {
		time.Sleep(50 * time.Millisecond)
		g.followLines(strings.NewReader(exit("1", "n1")))
	}()
	if why := left(g, 10*time.Second); why != "" {
		t.Errorf("exit while waiting: %q", why)
	}
	// The run still pending: the gate waits, then the session is cut short.
	g = newGate()
	g.job.waitFor("1")
	g.job.settle("p", "")
	t0 := time.Now()
	if why := left(g, 150*time.Millisecond); why != notSeen || time.Since(t0) < 140*time.Millisecond {
		t.Errorf("pending: %q after %v", why, time.Since(t0))
	}
	// Another run's exit, or one the gate refuses (no random number), is not that end.
	g.followLines(strings.NewReader(exit("2", "n2")))
	if why := left(g, 0); why != notSeen {
		t.Errorf("another run's exit: %q", why)
	}
	g = newGate()
	g.job.waitFor("1")
	g.job.settle("p", "")
	g.followLines(strings.NewReader(exit("1", "forged")))
	if why := left(g, 0); why != notSeen || g.exitsBadNow() == "" {
		t.Errorf("a refused exit: %q", why)
	}
	// Not a signed run (raw, context): no exit comes back, so no wait. Cut, but not logged as cut
	// short: the client most likely had the reply and left (round 1, L2).
	g = newGate()
	g.job.waitFor("")
	g.job.settle("p", "")
	t0 = time.Now()
	if c, why := g.job.leftWaiting(10 * time.Second); !c || why != "" || time.Since(t0) > 5*time.Second {
		t.Errorf("raw: %v %q after %v", c, why, time.Since(t0))
	}
	// Two requests sent before the pod was ready: which reply the client had is unknown.
	g = newGate()
	g.job.waitFor("1")
	g.job.waitFor("2")
	g.job.settle("p", "")
	g.followLines(strings.NewReader(exit("1", "n1")))
	if c, _ := g.job.leftWaiting(0); !c {
		t.Error("two queued: not cut")
	}

	// A disconnect later than leftGrace after the pod settled, during the run that waited for it
	// (a dropped network, 10 minutes into the block): the run goes on to its end, as any later
	// block does, and nothing is logged (review of 0.30.0, M1).
	long := func(run string) *Gate {
		g := newGate()
		g.job.waitFor(run)
		g.job.settle("p", "")
		g.job.mu.Lock()
		g.job.settledAt = time.Now().Add(-10 * time.Minute)
		g.job.mu.Unlock()
		return g
	}
	t0 = time.Now()
	if c, why := long("1").job.leftWaiting(10 * time.Second); c || why != "" || time.Since(t0) > 5*time.Second {
		t.Errorf("a signed run, later: %v %q after %v", c, why, time.Since(t0))
	}
	if c, why := long("").job.leftWaiting(0); c || why != "" {
		t.Errorf("raw, later: %v %q", c, why)
	}
	// Just inside the grace (a stop as the pod got ready, L5): still cut.
	g = long("1")
	g.job.mu.Lock()
	g.job.settledAt = time.Now().Add(-leftGrace + time.Second)
	g.job.mu.Unlock()
	if why := left(g, 0); why != notSeen {
		t.Errorf("within the grace: %q", why)
	}
	// Before the pod settled, however long the wait: cut, logged.
	g = newGate()
	g.job.waitFor("1")
	if c, why := g.job.leftWaiting(0); !c || why != "the client left while the pod was starting" {
		t.Errorf("starting: %v %q", c, why)
	}
}

// The app's bound on the wait for the pod (POD_WAIT_MAX_MS) is above the gate's own, with a
// margin for the notice's way: raise both together.
func TestPodWaitBound(t *testing.T) {
	src, err := os.ReadFile("../../../../packages/ssh/src/remoteShell.ts")
	if err != nil {
		t.Skip("no packages/ssh here: ", err)
	}
	m := regexp.MustCompile(`export const POD_WAIT_MAX_MS = (\d+) \* 60_000;`).FindSubmatch(src)
	if m == nil {
		t.Fatal("no POD_WAIT_MAX_MS = N * 60_000 in remoteShell.ts")
	}
	app := time.Duration(atoi(string(m[1]))) * time.Minute
	if podWaitWorst+15*time.Second > app {
		t.Errorf("the gate may wait %v for the pod; the app gives up after %v", podWaitWorst, app)
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
		case "jobs/ create", "jobs/ list", "jobs/ delete", "pods/ get", "pods/ list", "pods/exec create", "serviceaccounts/ list":
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
	if p := j.check(ops, "", "the gate's service account"); !reflect.DeepEqual(p, []string{
		"the gate's service account may create deployments (apps) in md-runbook-ops",
		"the gate's service account may patch deployments (apps) in md-runbook-ops",
	}) {
		t.Errorf("ops with deployments: %q", p)
	}
	// More of the admission policies than a get by name (which a review without a name can't
	// see): refused, each verb named.
	extra = "validatingadmissionpolicybindings"
	if p := j.check(ops, "", "the gate's service account"); len(p) != 6 || p[0] != "the gate's service account may get validatingadmissionpolicybindings (admissionregistration.k8s.io) in every namespace" ||
		p[5] != "the gate's service account may delete validatingadmissionpolicybindings (admissionregistration.k8s.io) in every namespace" {
		t.Errorf("ops with the policies' bindings: %q", p)
	}
	// Of RBAC, more than the list of ClusterRoleBindings: refused.
	extra = "clusterrolebindings"
	if p := j.check(ops, "", "the gate's service account"); len(p) != 5 || p[0] != "the gate's service account may get clusterrolebindings (rbac.authorization.k8s.io) in every namespace" {
		t.Errorf("ops with clusterrolebindings: %q", p)
	}
	extra = "clusterroles"
	if p := j.check(ops, "", "the gate's service account"); len(p) != 8 || !strings.Contains(strings.Join(p, "\n"), "may escalate clusterroles (rbac.authorization.k8s.io) in every namespace") {
		t.Errorf("ops with clusterroles: %q", p)
	}
	extra = ""

	// The cells' account: checked in the Job's pod, through the cells' mode, before any block.
	cells := cellsReviews(ns, "md-runbook-cells", "md-runbook-ops")
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
		"delete validatingadmissionpolicybindings/ ":    "may delete validatingadmissionpolicybindings (admissionregistration.k8s.io) in every namespace",
		"patch validatingadmissionpolicies/ ":           "may patch validatingadmissionpolicies (admissionregistration.k8s.io) in every namespace",
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
	rs := cellsReviews("ops", "cells", "ops-sa")
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
	for k, want := range map[string]bool{"create jobs/ ops": true, "delete jobs/ ops": true, "create pods/exec ops": true, "list serviceaccounts/ ops": true, "list pods/ ": false, "get secrets/ ops": false, "create pods/ ops": false,
		"get validatingadmissionpolicybindings/ ": false, "list validatingadmissionpolicies/ ": false, "update validatingadmissionpolicybindings/ ": false, "delete validatingadmissionpolicies/ ": false,
		"get clusterrolebindings/ ": false, "create clusterrolebindings/ ": false, "bind clusterroles/ ": false, "escalate roles/ ": false, "list rolebindings/ ": false,
		"create deployments/ ops": false, "create cronjobs/ ops": false, "create replicationcontrollers/ ops": false, "patch pods/ ops": false,
		"patch pods/ephemeralcontainers ops": false, "create pods/attach ops": false, "create pods/portforward ops": false} {
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
	p := unguardedNamespaces(nss, names, []byte(out), "md-runbook-ops", "md-runbook-cells")
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
	if p := unguardedNamespaces(nss[2:3], names[2:3], []byte(rr("kube-system", read, true)), "md-runbook-ops", "md-runbook-cells"); len(p) != 1 || !strings.Contains(p[0], "incomplete") {
		t.Errorf("incomplete: %q", p)
	}
	// Read-only namespaces without a label pass (kind's kube-system, kube-public, ...).
	if p := unguardedNamespaces(nss[1:3], []string{"shop", "kube-system"}, []byte(rr("shop", read, false)+rr("kube-system", read, false)), "md-runbook-ops", "md-runbook-cells"); len(p) != 0 {
		t.Errorf("read only: %q", p)
	}
	// kube-* namespaces where a rule lets the cells change workloads: refused whatever their
	// labels, and the message doesn't suggest one (security review of 0.31, H1). Read-only ones
	// pass, labels or not.
	kube, _ := kubeObjects([]byte(`{"kind":"List","items":[
		{"kind":"Namespace","metadata":{"name":"kube-system","labels":{"pod-security.kubernetes.io/enforce":"baseline"}}},
		{"kind":"Namespace","metadata":{"name":"kube-node-lease","labels":{"pod-security.kubernetes.io/enforce":"restricted"}}},
		{"kind":"Namespace","metadata":{"name":"kube-public"}},
		{"kind":"Namespace","metadata":{"name":"kubeflow","labels":{"pod-security.kubernetes.io/enforce":"baseline"}}}]}`))
	kubeNames := []string{"kube-system", "kube-node-lease", "kube-public", "kubeflow"}
	p = unguardedNamespaces(kube, kubeNames, []byte(rr("", operate, false)+rr("", `{"verbs":["*"],"apiGroups":["*"],"resources":["*"]}`, false)+rr("", operate, false)+rr("", operate, false)), "md-runbook-ops", "md-runbook-cells")
	never := ": never bind md-runbook-ops-operate (or any workload rights) in kube-* namespaces; their service accounts run the cluster"
	if want := []string{
		"the cells' service account may start workloads in namespace kube-system" + never,
		"the cells' service account may start workloads in namespace kube-node-lease" + never,
		"the cells' service account may start workloads in namespace kube-public" + never,
	}; !reflect.DeepEqual(p, want) {
		t.Errorf("kube-*: %q", p)
	}
	if p := unguardedNamespaces(kube, kubeNames, []byte(rr("", read, false)+rr("", read, false)+rr("", read, false)+rr("", read, false)), "md-runbook-ops", "md-runbook-cells"); len(p) != 0 {
		t.Errorf("kube-*, read only: %q", p)
	}
	// Unlabelled, an incomplete answer: refused as before, without the label command.
	if p := unguardedNamespaces(kube[2:3], kubeNames[2:3], []byte(rr("", read, true)), "md-runbook-ops", "md-runbook-cells"); len(p) != 1 || !strings.Contains(p[0], "incomplete") ||
		!strings.HasSuffix(p[0], never) || strings.Contains(p[0], "kubectl label") {
		t.Errorf("kube-public, incomplete: %q", p)
	}
	// Answers that don't add up: refused.
	if p := unguardedNamespaces(nss, names, []byte(rr("default", read, false)), "md-runbook-ops", "md-runbook-cells"); len(p) != 1 || !strings.Contains(p[0], "1 answers for 4 namespaces") {
		t.Errorf("short: %q", p)
	}
	wrong := `{"kind":"SelfSubjectRulesReview","spec":{"namespace":"lab"},"status":{}}` + "\n"
	if p := unguardedNamespaces(nss[2:3], names[2:3], []byte(wrong), "md-runbook-ops", "md-runbook-cells"); len(p) != 1 || !strings.Contains(p[0], "in the place of kube-system") {
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

// The admission policy md-runbook-ops-workloads, read by name as the gate's account: in force
// only with its binding denying in every namespace; it counts where the cells may change
// workloads (security review of 0.31, H2).
func TestWorkloadPolicy(t *testing.T) {
	const rule = `"validations":[{"expression":"variables.update"},{"expression":"namespaceObject != null && namespaceObject.metadata.labels['pod-security.kubernetes.io/enforce'] in ['baseline']"}]`
	const pol = `{"apiVersion":"admissionregistration.k8s.io/v1","kind":"ValidatingAdmissionPolicy","metadata":{"name":"md-runbook-ops-workloads"},"spec":{"failurePolicy":"Fail",` + rule + `}}`
	bind := func(spec string) string {
		return `{"apiVersion":"admissionregistration.k8s.io/v1","kind":"ValidatingAdmissionPolicyBinding","metadata":{"name":"md-runbook-ops-workloads"},"spec":` + spec + `}`
	}
	good := bind(`{"policyName":"md-runbook-ops-workloads","validationActions":["Deny"]}`)
	list := func(items ...string) []byte {
		return []byte(`{"apiVersion":"v1","kind":"List","items":[` + strings.Join(items, ",") + `]}`)
	}
	var gotArgv []string
	j := testJob(func(argv, env []string, stdin []byte) ([]byte, error) {
		gotArgv = argv
		return list(pol, good), nil
	})
	if p := j.checkWorkloadPolicy(); p != "" {
		t.Errorf("in force: %s", p)
	}
	if !reflect.DeepEqual(gotArgv, []string{"/usr/bin/kubectl", "get", "validatingadmissionpolicy/md-runbook-ops-workloads", "validatingadmissionpolicybinding/md-runbook-ops-workloads", "-o", "json"}) {
		t.Errorf("argv %q", gotArgv)
	}
	apply := "Apply apps/ops/kubernetes/admission-policy.yaml"
	missing := "the admission policy md-runbook-ops-workloads or its binding is missing. " + apply
	narrowed := "the binding md-runbook-ops-workloads doesn't deny for the policy md-runbook-ops-workloads in every namespace. " + apply
	for name, c := range map[string]struct {
		out  []byte
		err  error
		want string
	}{
		// The API server's defaults: empty selectors, matchPolicy.
		"defaulted":        {list(pol, bind(`{"policyName":"md-runbook-ops-workloads","validationActions":["Deny"],"matchResources":{"namespaceSelector":{},"objectSelector":{},"matchPolicy":"Equivalent"}}`)), nil, ""},
		"no failurePolicy": {list(`{"kind":"ValidatingAdmissionPolicy","metadata":{"name":"md-runbook-ops-workloads"},"spec":{`+rule+`}}`, good), nil, ""},
		// 0.32.0's policy: no rule on the namespace (its labels held only at the session's start).
		"no namespace rule": {list(`{"kind":"ValidatingAdmissionPolicy","metadata":{"name":"md-runbook-ops-workloads"},"spec":{"failurePolicy":"Fail","validations":[{"expression":"variables.update"}]}}`, good), nil,
			"the admission policy md-runbook-ops-workloads has no rule on the namespace (Pod Security, kube-*): it predates md-runbook 0.33.0. " + apply + " again"},
		"not found": {nil, errors.New(`exit status 1: Error from server (NotFound): validatingadmissionpolicybindings.admissionregistration.k8s.io "md-runbook-ops-workloads" not found`), missing},
		"forbidden": {nil, errors.New(`exit status 1: Error from server (Forbidden): validatingadmissionpolicies.admissionregistration.k8s.io "md-runbook-ops-workloads" is forbidden`),
			`the gate's service account can't read the admission policy md-runbook-ops-workloads (exit status 1: Error from server (Forbidden): validatingadmissionpolicies.admissionregistration.k8s.io "md-runbook-ops-workloads" is forbidden). Apply apps/ops/kubernetes/md-runbook-ops.yaml (ClusterRole md-runbook-ops-gate)`},
		"failed":          {nil, errors.New("exit status 1: error: You must be logged in to the server (Unauthorized)"), "can't tell whether the admission policy md-runbook-ops-workloads is in force (exit status 1: error: You must be logged in to the server (Unauthorized))"},
		"garbage":         {[]byte("{"), nil, "can't read the admission policy md-runbook-ops-workloads"},
		"policy only":     {list(pol), nil, missing},
		"binding only":    {[]byte(good), nil, missing},
		"another name":    {list(pol, strings.Replace(good, `"name":"md-runbook-ops-workloads"}`, `"name":"other"}`, 1)), nil, missing},
		"ignore":          {list(strings.Replace(pol, "Fail", "Ignore", 1), good), nil, "the admission policy md-runbook-ops-workloads has failurePolicy Ignore: an error would let a change through. " + apply},
		"warn only":       {list(pol, bind(`{"policyName":"md-runbook-ops-workloads","validationActions":["Warn","Audit"]}`)), nil, narrowed},
		"other policy":    {list(pol, bind(`{"policyName":"other","validationActions":["Deny"]}`)), nil, narrowed},
		"some namespaces": {list(pol, bind(`{"policyName":"md-runbook-ops-workloads","validationActions":["Deny"],"matchResources":{"namespaceSelector":{"matchLabels":{"team":"x"}}}}`)), nil, narrowed},
		"some objects":    {list(pol, bind(`{"policyName":"md-runbook-ops-workloads","validationActions":["Deny"],"matchResources":{"objectSelector":{"matchExpressions":[{"key":"a","operator":"Exists"}]}}}`)), nil, narrowed},
		"excluded":        {list(pol, bind(`{"policyName":"md-runbook-ops-workloads","validationActions":["Deny"],"matchResources":{"excludeResourceRules":[{"apiGroups":["apps"],"resources":["deployments"]}]}}`)), nil, narrowed},
	} {
		if p := workloadPolicyProblem(c.out, c.err); p != c.want {
			t.Errorf("%s: %q", name, p)
		}
	}

	// It counts only where the cells may change workloads (or the answer is incomplete).
	read := `{"verbs":["get","list"],"apiGroups":["apps"],"resources":["deployments"]}`
	patch := `{"verbs":["patch"],"apiGroups":["apps"],"resources":["deployments"]}`
	rr := func(rules string, incomplete bool) string {
		return `{"kind":"SelfSubjectRulesReview","spec":{},"status":{"resourceRules":[` + rules + `],"incomplete":` + fmt.Sprint(incomplete) + `}}` + "\n"
	}
	names := []string{"default", "shop", "lab"}
	out := []byte(rr(read, false) + rr(read+","+patch, false) + rr(read, true))
	may := writableNamespaces(names, out, "md-runbook-ops", "md-runbook-cells")
	if !reflect.DeepEqual(may, []string{"shop", "lab"}) {
		t.Errorf("writable: %q", may)
	}
	if p := unpolicedNamespaces(may, missing); p != "the cells' service account may change workloads in namespaces shop, lab, but "+missing {
		t.Errorf("unpoliced: %q", p)
	}
	if p := unpolicedNamespaces(may, ""); p != "" {
		t.Errorf("in force: %q", p)
	}
	readOnly := writableNamespaces(names, []byte(rr(read, false)+rr(read, false)+rr(read, false)), "md-runbook-ops", "md-runbook-cells")
	if p := unpolicedNamespaces(readOnly, missing); len(readOnly) != 0 || p != "" {
		t.Errorf("read only: %q %q", readOnly, p)
	}
}

// The shipped policy has the namespace rule the gate looks for.
func TestShippedWorkloadPolicy(t *testing.T) {
	src, err := os.ReadFile("../../../ops/kubernetes/admission-policy.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, doc := range strings.Split(string(src), "\n---\n") {
		if strings.Contains(doc, "\nkind: ValidatingAdmissionPolicy\n") && strings.Contains(doc, "\n  name: md-runbook-ops-workloads\n") {
			if !hasNamespaceRule([]policyValidation{{doc}}) {
				t.Error("admission-policy.yaml: md-runbook-ops-workloads has no namespace rule")
			}
			return
		}
	}
	t.Error("admission-policy.yaml: no policy md-runbook-ops-workloads")
}

// The shipped RBAC of job_audit_who grants what the gate's checks allow, nothing more: the cells'
// account impersonates itself (by name, in a Role) and sets the extra md-runbook.dev/operator.
func TestShippedImpersonation(t *testing.T) {
	src, err := os.ReadFile("../../../ops/kubernetes/impersonation.yaml")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(src), "\r\n", "\n")
	var rules []string
	for _, line := range strings.Split(text, "\n") {
		if s := strings.TrimSpace(line); strings.HasPrefix(s, "- apiGroups:") || strings.HasPrefix(s, "resources:") || strings.HasPrefix(s, "resourceNames:") || strings.HasPrefix(s, "verbs:") {
			rules = append(rules, s)
		}
	}
	want := []string{
		"- apiGroups: ['']", "resources: [serviceaccounts]", "resourceNames: [md-runbook-cells]", "verbs: [impersonate]",
		"- apiGroups: [authentication.k8s.io]", "resources: [userextras/" + auditExtra + "]", "verbs: [impersonate]",
	}
	if !reflect.DeepEqual(rules, want) {
		t.Errorf("rules %q", rules)
	}
	if !strings.Contains(text, "kind: Role\nmetadata:\n  name: md-runbook-cells-impersonate-self\n  namespace: md-runbook-ops\n") {
		t.Error("the self-impersonation isn't a Role in md-runbook-ops")
	}
}

// The gate's own namespace enforces Pod Security restricted (security review of 0.31.1, lows).
func TestOwnNamespaceLabel(t *testing.T) {
	nss, _ := kubeObjects([]byte(`{"kind":"List","items":[
		{"kind":"Namespace","metadata":{"name":"md-runbook-ops","labels":{"pod-security.kubernetes.io/enforce":"restricted"}}},
		{"kind":"Namespace","metadata":{"name":"ops-b","labels":{"pod-security.kubernetes.io/enforce":"baseline"}}},
		{"kind":"Namespace","metadata":{"name":"ops-c"}}]}`))
	if p := ownNamespaceProblem(nss, "md-runbook-ops"); p != "" {
		t.Errorf("restricted: %q", p)
	}
	for ns, want := range map[string]string{
		"ops-b":    "the gate's namespace ops-b doesn't enforce Pod Security restricted: kubectl label --overwrite namespace ops-b pod-security.kubernetes.io/enforce=restricted",
		"ops-c":    "the gate's namespace ops-c doesn't enforce Pod Security restricted: kubectl label --overwrite namespace ops-c pod-security.kubernetes.io/enforce=restricted",
		"ops-gone": "the cells' service account can't see the gate's namespace ops-gone",
	} {
		if p := ownNamespaceProblem(nss, ns); p != want {
			t.Errorf("%s: %q", ns, p)
		}
	}
}

// While a session lasts, the gate checks again the policy and the ClusterRoleBindings of the
// namespaces the cells may change; a problem ends the session, a kubectl that can't tell doesn't
// (security review of 0.31.1, lows: checks once per session).
func TestRecheck(t *testing.T) {
	pol := `{"kind":"ValidatingAdmissionPolicy","metadata":{"name":"md-runbook-ops-workloads"},"spec":{"failurePolicy":"Fail","validations":[{"expression":"namespaceObject.metadata.labels['pod-security.kubernetes.io/enforce']"}]}}`
	bind := `{"kind":"ValidatingAdmissionPolicyBinding","metadata":{"name":"md-runbook-ops-workloads"},"spec":{"policyName":"md-runbook-ops-workloads","validationActions":["Deny"]}}`
	wide := `{"kind":"ClusterRoleBinding","metadata":{"name":"wide"},"roleRef":{"kind":"ClusterRole","name":"cluster-admin"},"subjects":[{"kind":"ServiceAccount","name":"app","namespace":"shop"}]}`
	var policyOut, bindingsOut string
	var policyErr, bindingsErr error
	j := testJob(func(argv, env []string, stdin []byte) ([]byte, error) {
		if argv[2] == "clusterrolebindings" {
			return []byte(bindingsOut), bindingsErr
		}
		return []byte(policyOut), policyErr
	})
	j.sa, j.may = "md-runbook-cells", []string{"shop"}
	reset := func() {
		policyOut, bindingsOut = `{"kind":"List","items":[`+pol+`,`+bind+`]}`, `{"kind":"List","items":[]}`
		policyErr, bindingsErr = nil, nil
	}
	reset()
	if p := j.recheck(); len(p) != 0 {
		t.Errorf("fine: %q", p)
	}
	bindingsOut = `{"kind":"List","items":[` + wide + `]}`
	if p := j.recheck(); len(p) != 1 || !strings.Contains(p[0], "namespace shop, where service accounts have cluster-wide rights: app → cluster-admin (binding wide)") {
		t.Errorf("wide: %q", p)
	}
	reset()
	policyErr = errors.New(`exit status 1: Error from server (NotFound): validatingadmissionpolicybindings.admissionregistration.k8s.io "md-runbook-ops-workloads" not found`)
	if p := j.recheck(); len(p) != 1 || !strings.Contains(p[0], "may change workloads in namespaces shop, but the admission policy md-runbook-ops-workloads or its binding is missing") {
		t.Errorf("binding gone: %q", p)
	}
	// The API server out of reach: nothing found, the next round tells.
	reset()
	policyErr = errors.New("exit status 1: Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout")
	bindingsErr = errTimeout
	if p := j.recheck(); len(p) != 0 {
		t.Errorf("unreachable: %q", p)
	}

	newGate := func() *Gate {
		g := &Gate{log: &logx.Logger{Dest: t.TempDir() + "/gate.log"}}
		g.endCh = make(chan struct{}, 1)
		return g
	}
	// A problem: the session ends, after one round.
	reset()
	bindingsOut = `{"kind":"List","items":[` + wide + `]}`
	g, rounds := newGate(), 0
	g.watchJob(j, func(d time.Duration) {
		if d != recheckEvery {
			t.Errorf("sleep %v", d)
		}
		rounds++
	})
	select {
	case <-g.endCh:
	default:
		t.Error("not ended")
	}
	if b, _ := os.ReadFile(g.log.Dest); rounds != 1 || !strings.Contains(string(b), `"event":"self-check","status":"refused"`) || !strings.Contains(string(b), "The session ends.") {
		t.Errorf("%d rounds, log %s", rounds, b)
	}
	// Fine: rounds go on until the session ends.
	reset()
	g, rounds = newGate(), 0
	g.watchJob(j, func(time.Duration) {
		if rounds++; rounds == 3 {
			g.ending.Store(true)
		}
	})
	if rounds != 3 || len(g.endCh) != 0 {
		t.Errorf("fine: %d rounds, ended %d", rounds, len(g.endCh))
	}
	// Nowhere the cells may change workloads: no rounds.
	j.may = nil
	g.watchJob(j, func(time.Duration) { t.Error("slept") })
}

// Namespaces the cells may change whose service accounts have cluster-wide rights: refused, with
// up to 3 bindings each (security review of 0.31, H2: set image runs as the workload's account).
func TestRiskyNamespaces(t *testing.T) {
	crb := func(name, role string, subjects ...string) string {
		return `{"apiVersion":"rbac.authorization.k8s.io/v1","kind":"ClusterRoleBinding","metadata":{"name":"` + name + `"},` +
			`"roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"` + role + `"},"subjects":[` + strings.Join(subjects, ",") + `]}`
	}
	sa := func(ns, name string) string {
		return `{"kind":"ServiceAccount","name":"` + name + `","namespace":"` + ns + `"}`
	}
	subj := func(kind, name string) string {
		return `{"apiGroup":"rbac.authorization.k8s.io","kind":"` + kind + `","name":"` + name + `"}`
	}
	list := func(items ...string) []byte {
		return []byte(`{"apiVersion":"v1","kind":"List","items":[` + strings.Join(items, ",") + `],"metadata":{"resourceVersion":""}}`)
	}
	ops, cells := "md-runbook-ops", "md-runbook-cells"
	out := list(
		// What every cluster has: all service accounts, all users; and the cells' own reading.
		crb("system:service-account-issuer-discovery", "system:service-account-issuer-discovery", subj("Group", "system:serviceaccounts")),
		crb("system:basic-user", "system:basic-user", subj("Group", "system:authenticated")),
		crb("md-runbook-ops", "md-runbook-ops", sa(ops, cells)),
		// Another namespace's account: not argocd's business.
		crb("cert-manager", "cert-manager-controller", sa("cert-manager", "cert-manager")),
		crb("argocd-application-controller", "cluster-admin", sa("argocd", "argocd-application-controller")),
		crb("argocd-server", "argocd-server", sa("argocd", "argocd-server"), sa("other", "x")),
		crb("argocd-group", "view", subj("Group", "system:serviceaccounts:argocd")),
		crb("argocd-user", "edit", subj("User", "system:serviceaccount:argocd:repo-server")),
		crb("shop-reader", "view", sa("shop", "reader")),
		// Users and groups that aren't service accounts: not the namespace's.
		crb("alice", "cluster-admin", subj("User", "alice"), subj("Group", "shop-admins")),
	)
	end := func(ns string) string {
		return ". Runbooks could run code as those accounts by changing an image: don't bind md-runbook-ops-operate in " + ns + " (apps/ops/README.md)"
	}
	want := []string{
		"the cells' service account may change workloads in namespace argocd, where service accounts have cluster-wide rights: " +
			"argocd-application-controller → cluster-admin (binding argocd-application-controller), argocd-server → argocd-server (binding argocd-server), " +
			"group system:serviceaccounts:argocd → view (binding argocd-group) and 1 more" + end("argocd"),
		"the cells' service account may change workloads in namespace shop, where service accounts have cluster-wide rights: reader → view (binding shop-reader)" + end("shop"),
	}
	if p := riskyNamespaces([]string{"default", "argocd", "shop"}, out, nil, ops, cells); !reflect.DeepEqual(p, want) {
		t.Errorf("risky:\n%s", strings.Join(p, "\n"))
	}
	// Only the namespaces the cells may change count.
	if p := riskyNamespaces([]string{"default", "web"}, out, nil, ops, cells); len(p) != 0 {
		t.Errorf("none: %q", p)
	}
	// The cells' own account: not a reason (its namespace is refused elsewhere).
	if p := riskyNamespaces([]string{ops}, out, nil, ops, cells); len(p) != 0 {
		t.Errorf("cells: %q", p)
	}
	// Many bindings: three, then how many more.
	var many []string
	for i := 0; i < 12; i++ {
		many = append(many, crb("b"+itoa(i), "view", sa("shop", "sa"+itoa(i))))
	}
	if p := riskyNamespaces([]string{"shop"}, list(many...), nil, ops, cells); len(p) != 1 ||
		!strings.Contains(p[0], "sa2 → view (binding b2) and 9 more. ") || strings.Contains(p[0], "sa3 ") {
		t.Errorf("many: %q", p)
	}
	// No list, or one that can't be read: refused, naming the missing right.
	forbidden := errors.New(`exit status 1: Error from server (Forbidden): clusterrolebindings.rbac.authorization.k8s.io is forbidden: User "system:serviceaccount:md-runbook-ops:md-runbook-ops" cannot list resource "clusterrolebindings"`)
	if p := riskyNamespaces([]string{"shop"}, nil, forbidden, ops, cells); len(p) != 1 ||
		!strings.HasPrefix(p[0], "the gate's service account may not list clusterrolebindings (exit status 1: ") || !strings.HasSuffix(p[0], "Apply apps/ops/kubernetes/md-runbook-ops.yaml (ClusterRole md-runbook-ops-gate)") {
		t.Errorf("forbidden: %q", p)
	}
	if p := riskyNamespaces([]string{"shop"}, nil, errors.New("exit status 1: timeout"), ops, cells); !reflect.DeepEqual(p, []string{"can't list the clusterrolebindings (exit status 1: timeout)"}) {
		t.Errorf("failed: %q", p)
	}
	for _, bad := range []string{"{", `{"kind":"Status"}`, `[]`} {
		if p := riskyNamespaces([]string{"shop"}, []byte(bad), nil, ops, cells); !reflect.DeepEqual(p, []string{"can't read the clusterrolebindings"}) {
			t.Errorf("%s: %q", bad, p)
		}
	}
	// The list, as the gate's account.
	var gotArgv []string
	j := testJob(func(argv, env []string, stdin []byte) ([]byte, error) {
		gotArgv = argv
		return out, nil
	})
	j.listBindings()
	if !reflect.DeepEqual(gotArgv, []string{"/usr/bin/kubectl", "get", "clusterrolebindings", "-o", "json"}) || string(j.bindings) != string(out) || j.bindingsErr != nil {
		t.Errorf("argv %q", gotArgv)
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

// The rules reviews from the Job's pod: any impersonation but impersonation.yaml's two rules is
// refused, by name or verb (review of job_audit_who, M1, M2, L2).
func TestImpersonationRules(t *testing.T) {
	const ns, sa = "md-runbook-ops", "md-runbook-cells"
	read := `{"verbs":["get","list","watch"],"apiGroups":["","apps"],"resources":["pods","deployments"]}`
	self := `{"verbs":["impersonate"],"apiGroups":[""],"resources":["serviceaccounts"],"resourceNames":["md-runbook-cells"]}`
	extra := `{"verbs":["impersonate"],"apiGroups":["authentication.k8s.io"],"resources":["userextras/md-runbook.dev/operator"]}`
	rr := func(rules ...string) string {
		return `{"kind":"SelfSubjectRulesReview","spec":{},"status":{"resourceRules":[` + strings.Join(rules, ",") + `]}}` + "\n"
	}
	names := []string{"default", ns, "shop"}
	// The shipped rules (self in its own namespace, the extra everywhere), and rules that don't
	// impersonate: nothing refused.
	ok := rr(read, extra, `{"verbs":["*"],"apiGroups":["apps"],"resources":["*"]}`) + rr(read, extra, self) +
		rr(read, extra, `{"verbs":["*"],"apiGroups":[""],"resources":["pods","configmaps"]}`, `{"verbs":["impersonate"],"apiGroups":[""],"resources":["pods"]}`)
	if p := impersonationRules(names, []byte(ok), ns, sa); len(p) != 0 {
		t.Errorf("shipped: %q", p)
	}
	for name, c := range map[string]struct{ rule, where, want string }{
		"a named user":          {`{"verbs":["impersonate"],"apiGroups":[""],"resources":["users"],"resourceNames":["kubernetes-admin"]}`, "all", "verbs [impersonate] on [users] of API groups [] named [kubernetes-admin], in 3 namespaces (default, md-runbook-ops, shop)"},
		"a named group":         {`{"verbs":["impersonate"],"apiGroups":[""],"resources":["groups"],"resourceNames":["kubeadm:cluster-admins"]}`, "all", "named [kubeadm:cluster-admins]"},
		"another account here":  {`{"verbs":["impersonate"],"apiGroups":[""],"resources":["serviceaccounts"],"resourceNames":["argocd-application-controller"]}`, ns, "named [argocd-application-controller], in namespace md-runbook-ops"},
		"accounts everywhere":   {`{"verbs":["impersonate"],"apiGroups":[""],"resources":["serviceaccounts"]}`, "all", "on [serviceaccounts] of API groups [], in namespace md-runbook-ops"},
		"accounts, group *":     {`{"verbs":["impersonate"],"apiGroups":["*"],"resources":["serviceaccounts"]}`, "shop", "of API groups [*], in namespace shop"},
		"accounts and users":    {`{"verbs":["impersonate"],"apiGroups":[""],"resources":["serviceaccounts","users"]}`, "shop", "on [serviceaccounts users]"},
		"the gate's account":    {`{"verbs":["impersonate"],"apiGroups":[""],"resources":["serviceaccounts"],"resourceNames":["md-runbook-ops"]}`, ns, "named [md-runbook-ops], in namespace md-runbook-ops"},
		"self and more":         {`{"verbs":["impersonate"],"apiGroups":[""],"resources":["serviceaccounts"],"resourceNames":["md-runbook-cells","md-runbook-ops"]}`, ns, "named [md-runbook-cells md-runbook-ops]"},
		"any account":           {`{"verbs":["impersonate"],"apiGroups":[""],"resources":["serviceaccounts"]}`, ns, "verbs [impersonate] on [serviceaccounts] of API groups [], in namespace md-runbook-ops"},
		"constrained":           {`{"verbs":["impersonate:serviceaccount"],"apiGroups":["authentication.k8s.io"],"resources":["serviceaccounts"]}`, ns, "verbs [impersonate:serviceaccount]"},
		"constrained, on":       {`{"verbs":["impersonate-on:serviceaccount:*"],"apiGroups":["apps"],"resources":["deployments"]}`, "shop", "verbs [impersonate-on:serviceaccount:*]"},
		"associated node":       {`{"verbs":["impersonate:associated-node"],"apiGroups":["authentication.k8s.io"],"resources":["nodes"]}`, "all", "impersonate:associated-node"},
		"another extra":         {`{"verbs":["impersonate"],"apiGroups":["authentication.k8s.io"],"resources":["userextras/scopes"]}`, "all", "userextras/scopes"},
		"the pod's extra":       {`{"verbs":["impersonate"],"apiGroups":["authentication.k8s.io"],"resources":["userextras/authentication.kubernetes.io/pod-uid"]}`, "all", "pod-uid"},
		"uids":                  {`{"verbs":["impersonate"],"apiGroups":["authentication.k8s.io"],"resources":["uids"]}`, "all", "[uids]"},
		"everything":            {`{"verbs":["*"],"apiGroups":["*"],"resources":["*"]}`, "all", "verbs [*] on [*] of API groups [*]"},
		"* on users":            {`{"verbs":["*"],"apiGroups":[""],"resources":["users"]}`, "all", "verbs [*] on [users]"},
		"the extra, more verbs": {`{"verbs":["impersonate","impersonate:user-info"],"apiGroups":["authentication.k8s.io"],"resources":["userextras/md-runbook.dev/operator"]}`, "all", "impersonate:user-info"},
	} {
		var out string
		for _, n := range names {
			rules := []string{read, extra}
			if n == ns {
				rules = append(rules, self)
			}
			if c.where == "all" || c.where == n {
				rules = append(rules, c.rule)
			}
			out += rr(rules...)
		}
		p := impersonationRules(names, []byte(out), ns, sa)
		if len(p) != 1 || !strings.Contains(p[0], c.want) || !strings.Contains(p[0], "Only impersonation.yaml's rules") {
			t.Errorf("%s: %q", name, p)
		}
	}
	// A missing answer, or garbage: refused.
	if p := impersonationRules(names, []byte(rr(read)), ns, sa); len(p) != 1 || !strings.Contains(p[0], "1 answers for 3 namespaces") {
		t.Errorf("missing: %q", p)
	}
	if p := impersonationRules(names, []byte("{"), ns, sa); len(p) != 1 {
		t.Errorf("garbage: %q", p)
	}
}

// Kubernetes' edit and admin roles let the cells impersonate a namespace's service accounts. In a
// namespace other than the gate's that is allowed, and counts as running workloads there: Pod
// Security, no kube-*, and riskyNamespaces hold for it.
func TestServiceAccountImpersonation(t *testing.T) {
	const ns, sa = "md-runbook-ops", "md-runbook-cells"
	read := `{"verbs":["get","list","watch"],"apiGroups":[""],"resources":["pods"]}`
	self := `{"verbs":["impersonate"],"apiGroups":[""],"resources":["serviceaccounts"],"resourceNames":["md-runbook-cells"]}`
	// bootstrappolicy's editRules: impersonate on serviceaccounts of the core group.
	edit := `{"verbs":["impersonate"],"apiGroups":[""],"resources":["serviceaccounts"]}`
	star := `{"verbs":["*"],"apiGroups":[""],"resources":["serviceaccounts","configmaps"]}`
	rr := func(rules ...string) string {
		return `{"kind":"SelfSubjectRulesReview","spec":{},"status":{"resourceRules":[` + strings.Join(rules, ",") + `]}}` + "\n"
	}
	names := []string{ns, "shop"}
	for _, rule := range []string{edit, star} {
		out := []byte(rr(read, self) + rr(read, rule))
		if p := impersonationRules(names, out, ns, sa); len(p) != 0 {
			t.Errorf("%s in shop: %q", rule, p)
		}
		// shop counts as a namespace where the cells run workloads; the gate's own (self) doesn't.
		if may := writableNamespaces(names, out, ns, sa); !reflect.DeepEqual(may, []string{"shop"}) {
			t.Errorf("%s: may %q", rule, may)
		}
		// So shop must enforce Pod Security.
		nss, _ := kubeObjects([]byte(`{"kind":"List","items":[{"kind":"Namespace","metadata":{"name":"md-runbook-ops","labels":{"pod-security.kubernetes.io/enforce":"restricted"}}},{"kind":"Namespace","metadata":{"name":"shop"}}]}`))
		if p := unguardedNamespaces(nss, names, out, ns, sa); len(p) != 1 || !strings.Contains(p[0], "may act as its service accounts in namespace shop, which doesn't enforce Pod Security") {
			t.Errorf("%s: unguarded %q", rule, p)
		}
	}
	// The same rule in the gate's namespace: refused. Through a ClusterRoleBinding (in every
	// namespace's review), refused through the gate's namespace.
	if p := impersonationRules(names, []byte(rr(read, self, edit)+rr(read)), ns, sa); len(p) != 1 || !strings.Contains(p[0], "in namespace md-runbook-ops") {
		t.Errorf("in the gate's namespace: %q", p)
	}
	if p := impersonationRules(names, []byte(rr(read, self, edit)+rr(read, edit)), ns, sa); len(p) != 1 || !strings.Contains(p[0], "in namespace md-runbook-ops.") {
		t.Errorf("cluster-wide: %q", p)
	}
	// In a kube-* namespace: never.
	kube, _ := kubeObjects([]byte(`{"kind":"List","items":[{"kind":"Namespace","metadata":{"name":"kube-system","labels":{"pod-security.kubernetes.io/enforce":"restricted"}}}]}`))
	if p := unguardedNamespaces(kube, []string{"kube-system"}, []byte(rr(edit)), ns, sa); len(p) != 1 || !strings.Contains(p[0], "may act as its service accounts in namespace kube-system: never bind") {
		t.Errorf("kube-system: %q", p)
	}
	// A service account of shop with cluster-wide rights: riskyNamespaces refuses shop.
	may := writableNamespaces(names, []byte(rr(read, self)+rr(read, edit)), ns, sa)
	crbs := []byte(`{"kind":"List","items":[{"kind":"ClusterRoleBinding","metadata":{"name":"shop-admin"},"roleRef":{"kind":"ClusterRole","name":"cluster-admin"},"subjects":[{"kind":"ServiceAccount","name":"deployer","namespace":"shop"}]}]}`)
	if p := riskyNamespaces(may, crbs, nil, ns, sa); len(p) != 1 || !strings.Contains(p[0], "namespace shop, where service accounts have cluster-wide rights: deployer → cluster-admin") {
		t.Errorf("risky: %q", p)
	}
	// Not service accounts only: not this rule.
	for _, r := range []kubeRule{
		{Verbs: []string{"impersonate"}, APIGroups: []string{""}, Resources: []string{"*"}},
		{Verbs: []string{"impersonate:serviceaccount"}, APIGroups: []string{""}, Resources: []string{"serviceaccounts"}},
		{Verbs: []string{"impersonate"}, APIGroups: []string{"", "authentication.k8s.io"}, Resources: []string{"serviceaccounts"}},
		{Verbs: []string{"get"}, APIGroups: []string{""}, Resources: []string{"serviceaccounts"}},
	} {
		if saImpersonation(r) {
			t.Errorf("saImpersonation(%+v)", r)
		}
	}
}

#!/usr/bin/env bash
# The ops host's Jobs (cells_runner = kubernetes-job), through OpenSSH as an app session goes:
#   - each session's blocks run in a pod of their own, as md-runbook-cells, not in the ops pod;
#   - a block can't read the gate's service account token, report token or log, nor its
#     ConfigMap or Secrets through the API;
#   - two sessions get two pods;
#   - the Job goes when its session ends;
#   - the gate logs gate_mode separated;
#   - a namespace the blocks may change without Pod Security enforced: no session;
#   - another app's service account in the gate's namespace: no session;
#   - pod notices (protocol 4): `job`, `starting`, `ready` before the reply; a client that
#     goes while the pod starts ends the session, and the Job goes at once;
#   - the admission policy md-runbook-ops-jobs: without its binding, no session; with it, the
#     gate's account can't create a Job as another account, with a Secret, without the label,
#     or of another shape; md-runbook-ops-exec: it can't exec into the ops pod;
#   - a kube-* namespace bound, even with Pod Security enforced: no session;
#   - md-runbook-ops-workloads: as the cells' account, restart, undo, scale and set image pass, a
#     patch of the template's service account or volumes doesn't, nor creating a Job; without
#     its binding, no session;
#   - a namespace the blocks may change whose service account has a ClusterRoleBinding: no
#     session; once the binding goes, sessions run;
#   - cells-egress.yaml: blocks still reach the API server and DNS, not another namespace's
#     Service nor the internet;
#   - ops-egress.yaml: sessions still work; the ops pod doesn't reach another namespace's Service.
# Needs KEYS (client, ssh_host_ecdsa_key.pub) and the ops Service forwarded to 127.0.0.1:$PORT.
set -euo pipefail

ns=md-runbook-ops
port=${PORT:-2224}
work=$(mktemp -d)
echo "[127.0.0.1]:$port $(cut -d' ' -f1,2 "$KEYS/ssh_host_ecdsa_key.pub")" > "$work/known_hosts"
ssh_opts=(-T -p "$port" -i "$KEYS/client" -o BatchMode=yes -o IdentitiesOnly=yes
  -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes -o LogLevel=ERROR)
k() { kubectl -n "$ns" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# A raw request: the block, then the end-of-cell marker on both streams (as the app sends it).
cell() { # ID TEXT
  local end='__rc=$?; printf '"'"'\036%s %s\n'"'"' __MDRB_ID__ "$__rc" >&2; printf '"'"'\036%s %s\n'"'"' __MDRB_ID__ "$__rc"'
  printf 'raw %s %s\n' "$1" "$(printf '%s\n%s\n' "$2" "${end//ID/$1}" | base64 -w0)"
}
wait_for() { # FILE PATTERN [SECONDS]
  local i
  for ((i = 0; i < ${3:-90} * 5; i++)); do
    grep -aq -- "$2" "$1" 2>/dev/null && return 0
    sleep 0.2
  done
  echo "--- $1" >&2; cat -v "$1" >&2 || true
  echo "--- ${1%/*}/err" >&2; cat -v "${1%/*}/err" >&2 || true
  fail "no $2 in $1"
}
# A session on file descriptor FD whose input is a FIFO; its output in $work/NAME. With a third
# argument, the hello asks for pod notices (protocol 4).
open_session() { # NAME FD [pod-notices]
  mkdir -p "$work/$1"
  mkfifo "$work/$1/in"
  ssh "${ssh_opts[@]}" ops@127.0.0.1 < "$work/$1/in" > "$work/$1/out" 2> "$work/$1/err" &
  echo $! > "$work/$1/pid"
  eval "exec $2>\"\$work/\$1/in\""
  printf ': mdrb-gate-hello 0000aa00%s; x\n' "${3:+ $3}" >&"$2"
  wait_for "$work/$1/out" '__MDRB_0000aa00__'
}
close_session() { # NAME FD
  eval "exec $2>&-"
  wait "$(cat "$work/$1/pid")" || true
}
value() { sed -n "s/^$2=//p" "$work/$1/out" | head -n 1; }

ops_pod=$(k get pods -l app.kubernetes.io/name=md-runbook-ops -o jsonpath='{.items[0].metadata.name}')
ops_token=$(k exec "$ops_pod" -c ops -- sha256sum /var/run/secrets/kubernetes.io/serviceaccount/token | cut -c1-64)

probe='echo "pod=$(hostname)"
echo "whoami=$(kubectl auth whoami -o jsonpath="{.status.userInfo.username}" 2>&1)"
echo "token=$(sha256sum < /var/run/secrets/kubernetes.io/serviceaccount/token | cut -c1-64)"
cat /etc/md-runbook-ops/report/token >/dev/null 2>&1 && echo "leak=report-token"
kubectl -n md-runbook-ops get configmap md-runbook-ops-gate >/dev/null 2>&1 && echo "leak=configmap"
kubectl -n md-runbook-ops get secret md-runbook-ops-report-token >/dev/null 2>&1 && echo "leak=secret"
kubectl -n md-runbook-ops get secrets >/dev/null 2>&1 && echo "leak=secrets"
grep -q "\"event\":\"session\"" /var/log/md-runbook/gate.log 2>/dev/null && echo "leak=gate-log"
kubectl -n md-runbook-ops logs "deployment/md-runbook-ops" --tail=1 >/dev/null 2>&1 && echo "leak=pod-log"
kubectl -n md-runbook-ops exec "deployment/md-runbook-ops" -- true >/dev/null 2>&1 && echo "leak=exec"
echo "done=1"'

open_session a 7
cell 0000aa01 "$probe" >&7
wait_for "$work/a/out" '__MDRB_0000aa01__ 0'
open_session b 8
cell 0000bb01 'echo "pod=$(hostname)"' >&8
wait_for "$work/b/out" '__MDRB_0000bb01__ 0'
cat "$work/a/out" | tr '\036' '|'

pod_a=$(value a pod)
pod_b=$(value b pod)
job_a=$(k get pod "$pod_a" -o jsonpath='{.metadata.labels.md-runbook-job}')
job_b=$(k get pod "$pod_b" -o jsonpath='{.metadata.labels.md-runbook-job}')
echo "session a: pod $pod_a, Job $job_a; session b: pod $pod_b, Job $job_b; ops pod $ops_pod"
[ -n "$job_a" ] && [ -n "$job_b" ] || fail "the blocks didn't run in a Job's pod"
[ "$pod_a" != "$ops_pod" ] || fail "the blocks ran in the ops pod"
[ "$pod_a" != "$pod_b" ] || fail "two sessions shared a pod"
[ "$(k get pod "$pod_a" -o jsonpath='{.spec.serviceAccountName}')" = md-runbook-cells ] || fail "not the cells' service account"
[ "$(k get pod "$pod_a" -o jsonpath='{.spec.containers[0].securityContext.readOnlyRootFilesystem}')" = true ] || fail "a writable root file system"
[ "$(value a whoami)" = system:serviceaccount:md-runbook-ops:md-runbook-cells ] || fail "kubectl in a block is $(value a whoami)"
[ "$(value a token)" != "$ops_token" ] || fail "a block read the ops pod's token"
[ -z "$(value a leak)" ] || fail "a block reached the gate: $(grep '^leak=' "$work/a/out" | tr '\n' ' ')"
[ "$(value a 'done')" = 1 ] || fail "the block didn't finish"

close_session a 7
for _ in $(seq 1 60); do
  k get job "$job_a" > /dev/null 2>&1 || break
  sleep 1
done
k get job "$job_a" > /dev/null 2>&1 && fail "Job $job_a is still there after its session"
k get job "$job_b" > /dev/null || fail "Job $job_b went before its session"
close_session b 8

# Pod notices (protocol 4): the kube-context probe hears that it waits for the pod, then that the
# pod is ready, before its reply. (Its time limit stops meanwhile: test/sshPodWait.test.ts.)
open_session d 7 pod-notices
grep -aq $'\036__MDRB_POD__ job' "$work/d/out" || fail "no job notice after the banner"
printf 'context 0000dd01\n' >&7
wait_for "$work/d/out" '__MDRB_0000dd01__ 0'
cat -v "$work/d/err"
starting=$(grep -an $'^\036__MDRB_POD__ starting$' "$work/d/err" | cut -d: -f1 | head -n 1)
ready=$(grep -an $'^\036__MDRB_POD__ ready$' "$work/d/err" | cut -d: -f1 | head -n 1)
marker=$(grep -an $'\036__MDRB_0000dd01__ 0' "$work/d/err" | cut -d: -f1 | head -n 1)
[ -n "$starting" ] && [ -n "$ready" ] && [ "$starting" -lt "$ready" ] && [ "$ready" -lt "$marker" ] ||
  fail "pod notices: starting=$starting ready=$ready marker=$marker"
grep -aq 'the first one waits for its pod' "$work/d/err" && fail "the gate's line as well as the notices"
close_session d 7

# A client that goes while the pod starts (a stop during the wait): the session ends at once, and
# its Job with it, not once the pod is ready.
open_session e 8 pod-notices
cell 0000ee01 'echo "ran=1"' >&8
wait_for "$work/e/err" $'\036__MDRB_POD__ starting' 30
close_session e 8
job_e=$(k logs "$ops_pod" -c ops | sed -n 's/.*"event":"job","status":"left","job":"\([^"]*\)".*/\1/p' | tail -n 1)
if [ -n "$job_e" ]; then
  for _ in $(seq 1 20); do
    k get job "$job_e" > /dev/null 2>&1 || break
    sleep 1
  done
  k get job "$job_e" > /dev/null 2>&1 && fail "Job $job_e is still there after its client left"
  # (The pod got ready just before the client went: the block may have run by then.)
  grep -aq $'\036__MDRB_POD__ ready' "$work/e/err" || [ -z "$(value e ran)" ] || fail "a block ran for a client that left"
  echo "ok: the client left while a request waited for the pod; Job $job_e went"
else
  # The pod was ready before the client went: nothing to check here.
  echo "note: session e's pod was ready before its client left"
fi

# A namespace the blocks may change that doesn't enforce Pod Security: the session refuses,
# naming it (a privileged pod there would own its node, and the gate's pod on it).
kubectl create namespace md-runbook-unguarded
kubectl -n md-runbook-unguarded create rolebinding md-runbook-ops-operate \
  --clusterrole=md-runbook-ops-operate --serviceaccount=md-runbook-ops:md-runbook-cells
open_session c 9
cell 0000cc01 'echo "ran=1"' >&9
wait_for "$work/c/err" 'namespace md-runbook-unguarded, which'
close_session c 9
[ -z "$(value c ran)" ] || fail "a block ran although md-runbook-unguarded doesn't enforce Pod Security"
cat "$work/c/err"
# Gone before the next sessions: one that starts while it is still terminating refuses as above
# (the egress session did, 807134e's Ops host run).
kubectl delete namespace md-runbook-unguarded --timeout=180s

# The gate's own namespace without Pod Security restricted: no session, naming the fix.
kubectl label --overwrite namespace "$ns" pod-security.kubernetes.io/enforce=baseline
open_session own 9
cell 0000cc02 'echo "ran=1"' >&9
wait_for "$work/own/err" "the gate's namespace $ns doesn't enforce Pod Security restricted"
close_session own 9
kubectl label --overwrite namespace "$ns" pod-security.kubernetes.io/enforce=restricted
[ -z "$(value own ran)" ] || fail "a block ran although $ns doesn't enforce Pod Security restricted"
echo "ok: the gate's namespace without restricted refuses sessions"

# A change of a pod template's annotation: an UPDATE the policy md-runbook-ops-workloads sees.
touch='{"spec":{"template":{"metadata":{"annotations":{"md-runbook/test":"1"}}}}}'
workloads="ValidatingAdmissionPolicy 'md-runbook-ops-workloads'"

# A kube-* namespace bound, even with Pod Security enforced: the session refuses, naming it
# (kube-system's pods run as the cluster's controllers). The gate refuses every kube-* name, so a
# namespace of our own stands in: labelling kube-system itself would block its own pods (they
# don't meet baseline) if one restarted meanwhile.
cells_sa=system:serviceaccount:$ns:md-runbook-cells
sys_ns=kube-md-runbook-test
kubectl create namespace "$sys_ns"
kubectl label namespace "$sys_ns" pod-security.kubernetes.io/enforce=baseline
kubectl -n "$sys_ns" create rolebinding md-runbook-ops-operate \
  --clusterrole=md-runbook-ops-operate --serviceaccount=md-runbook-ops:md-runbook-cells
open_session sys 9
cell 0000cd01 'echo "ran=1"' >&9
wait_for "$work/sys/err" "may start workloads in namespace $sys_ns: never bind md-runbook-ops-operate"
close_session sys 9
[ -z "$(value sys ran)" ] || fail "a block ran although the cells may change $sys_ns"
cat "$work/sys/err"
grep -q "kubectl label namespace $sys_ns" "$work/sys/err" && fail "the refusal suggests labelling $sys_ns"
# A kube-* namespace bound while a session lasts (the gate checked at its start): the policy
# refuses the cells' change there itself.
kubectl -n "$sys_ns" create deployment app --image=registry.k8s.io/pause:3.10
if out=$(kubectl --as="$cells_sa" -n "$sys_ns" patch deployment app -p "$touch" --dry-run=server 2>&1); then
  fail "a change in $sys_ns as the cells' account: the policy let it through ($out)"
fi
grep -qF "$workloads" <<<"$out" || fail "a change in $sys_ns: refused, but not by md-runbook-ops-workloads: $out"
echo "ok: a change in a kube-* namespace: refused by the policy"
# Gone before the next sessions (one starting while it terminates would refuse as above).
kubectl delete namespace "$sys_ns" --timeout=180s
for i in $(seq 1 30); do
  [ "$(kubectl auth can-i patch deployments -n "$sys_ns" --as="$cells_sa" 2>/dev/null)" = no ] && break
  [ "$i" -lt 30 ] || fail "the cells may still patch deployments in $sys_ns"
  sleep 1
done

# ---- the admission policy md-runbook-ops-workloads, in a namespace runbooks may change ----
# As the cells' account (kind's admin may impersonate it): restart, undo, scale and set image
# pass; a patch of the template's service account or volumes is refused by the policy; Jobs
# can't be created at all (RBAC: jobs create is opt-in).
w=md-runbook-workloads
as_cells=(--as="$cells_sa")
kubectl create namespace "$w"
kubectl label namespace "$w" pod-security.kubernetes.io/enforce=baseline
kubectl -n "$w" create rolebinding md-runbook-ops-operate \
  --clusterrole=md-runbook-ops-operate --serviceaccount=md-runbook-ops:md-runbook-cells
# A service account there with cluster-wide rights (an image a runbook sets would run as it): no
# session, naming it. Once its ClusterRoleBinding goes, sessions run again.
kubectl -n "$w" create serviceaccount md-runbook-wide
kubectl create clusterrolebinding md-runbook-wide --clusterrole=view --serviceaccount="$w:md-runbook-wide"
open_session wide 9
cell 0000cf01 'echo "ran=1"' >&9
wait_for "$work/wide/err" "namespace $w, where service accounts have cluster-wide rights: md-runbook-wide → view (binding md-runbook-wide)"
close_session wide 9
[ -z "$(value wide ran)" ] || fail "a block ran although a service account of $w has cluster-wide rights"
cat "$work/wide/err"
kubectl delete clusterrolebinding md-runbook-wide
open_session wide2 9
cell 0000cf02 'echo "ran=1"' >&9
wait_for "$work/wide2/out" '__MDRB_0000cf02__ 0'
close_session wide2 9
[ "$(value wide2 ran)" = 1 ] || fail "no session after the ClusterRoleBinding of $w's account went"
echo "ok: a namespace whose account has a ClusterRoleBinding refuses sessions, and not once it goes"
kubectl -n "$w" create deployment app --image=registry.k8s.io/pause:3.10
kubectl -n "$w" rollout status deployment/app --timeout=120s
kubectl "${as_cells[@]}" -n "$w" rollout restart deployment/app
kubectl -n "$w" rollout status deployment/app --timeout=120s
kubectl "${as_cells[@]}" -n "$w" rollout undo deployment/app
kubectl "${as_cells[@]}" -n "$w" scale deployment/app --replicas=2
kubectl "${as_cells[@]}" -n "$w" set image deployment/app pause=registry.k8s.io/pause:3.9 --dry-run=server
echo "ok: as the cells' account: rollout restart, rollout undo, scale and set image pass"
# Its Pod Security label removed while a session lasts: the policy refuses the cells' next change.
# (The policy reads the namespace from the API server's cache: a few tries each way.)
kubectl label namespace "$w" pod-security.kubernetes.io/enforce-
for i in $(seq 1 20); do
  out=$(kubectl "${as_cells[@]}" -n "$w" patch deployment app -p "$touch" --dry-run=server 2>&1) || break
  [ "$i" -lt 20 ] || fail "a change in $w without its Pod Security label: the policy let it through ($out)"
  sleep 1
done
grep -qF "$workloads" <<<"$out" || fail "a change in $w without its label: refused, but not by md-runbook-ops-workloads: $out"
kubectl label namespace "$w" pod-security.kubernetes.io/enforce=baseline
for i in $(seq 1 20); do
  kubectl "${as_cells[@]}" -n "$w" patch deployment app -p "$touch" --dry-run=server >/dev/null 2>&1 && break
  [ "$i" -lt 20 ] || fail "a change in $w with its label back: still refused"
  sleep 1
done
echo "ok: a namespace's Pod Security label removed: the cells' changes there refused by the policy"
for c in \
  'another service account|{"spec":{"template":{"spec":{"serviceAccountName":"md-runbook-other"}}}}' \
  'a Secret volume|{"spec":{"template":{"spec":{"volumes":[{"name":"s","secret":{"secretName":"md-runbook-any"}}]}}}}'; do
  if out=$(kubectl "${as_cells[@]}" -n "$w" patch deployment app -p "${c#*|}" 2>&1); then
    fail "a patch with ${c%%|*}: the cells' account may make it ($out)"
  fi
  grep -qF "$workloads" <<<"$out" || fail "a patch with ${c%%|*}: refused, but not by md-runbook-ops-workloads: $out"
  echo "ok: a patch with ${c%%|*}: refused by the policy"
done
if out=$(kubectl "${as_cells[@]}" -n "$w" create job md-runbook-job --image=registry.k8s.io/pause:3.10 2>&1); then
  fail "the cells' account may create a Job ($out)"
fi
grep -q 'cannot create resource "jobs"' <<<"$out" || fail "create job: refused, but not by RBAC: $out"
echo "ok: create job as the cells' account: forbidden"

# Without the policy's binding, while the cells may change workloads (default, $w): no session.
kubectl get validatingadmissionpolicybinding md-runbook-ops-workloads -o json |
  jq 'del(.metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .metadata.generation, .metadata.managedFields, .status)' > "$work/workloads-binding.json"
kubectl delete validatingadmissionpolicybinding md-runbook-ops-workloads
open_session wl 9
cell 0000ce01 'echo "ran=1"' >&9
wait_for "$work/wl/err" 'the admission policy md-runbook-ops-workloads or its binding is missing'
close_session wl 9
[ -z "$(value wl ran)" ] || fail "a block ran without the binding md-runbook-ops-workloads"
cat "$work/wl/err"
kubectl create -f "$work/workloads-binding.json"
kubectl delete namespace "$w" --timeout=180s

# Another app's service account in the gate's namespace: the session refuses before its hello
# (the gate could run a Job as that account).
k create serviceaccount md-runbook-intruder
mkdir -p "$work/f"
printf ': mdrb-gate-hello 0000ff00; x\n' | ssh "${ssh_opts[@]}" ops@127.0.0.1 > "$work/f/out" 2> "$work/f/err" || true
cat "$work/f/err"
grep -q 'also has service accounts md-runbook-intruder: ' "$work/f/err" || fail "the gate ran next to another service account"
grep -q '__MDRB_0000ff00__' "$work/f/out" && fail "a session started next to another service account"
k delete serviceaccount md-runbook-intruder

# ---- the admission policy md-runbook-ops-jobs ----
# Without its binding the policy guards nothing: the session refuses before its hello. (The API
# server takes a moment to see the change: a few tries.)
policy="ValidatingAdmissionPolicy 'md-runbook-ops-jobs'"
kubectl get validatingadmissionpolicybinding md-runbook-ops-jobs -o json |
  jq 'del(.metadata.resourceVersion, .metadata.uid, .metadata.creationTimestamp, .metadata.generation, .metadata.managedFields, .status)' > "$work/binding.json"
kubectl delete validatingadmissionpolicybinding md-runbook-ops-jobs
mkdir -p "$work/g"
refused=
for _ in $(seq 1 15); do
  printf ': mdrb-gate-hello 0000ab00; x\n' | ssh "${ssh_opts[@]}" ops@127.0.0.1 > "$work/g/out" 2> "$work/g/err" || true
  if grep -q "the admission policy md-runbook-ops-jobs doesn't guard the Jobs of namespace $ns" "$work/g/err"; then
    refused=1
    break
  fi
  sleep 2
done
cat "$work/g/err"
[ -n "$refused" ] || fail "a session started without the admission policy's binding"
grep -q '__MDRB_0000ab00__' "$work/g/out" && fail "a session started without the admission policy's binding"
kubectl create -f "$work/binding.json"

# The policy itself, as the gate's account would ask (kind's admin may impersonate it): a Job
# like the gate's passes (a dry run); any other shape is refused by the policy.
image=$(k get deployment md-runbook-ops -o jsonpath='{.spec.template.spec.containers[0].image}')
as_gate=(--as="system:serviceaccount:$ns:md-runbook-ops")
test_job() { # SERVICE_ACCOUNT LABEL VOLUME
  printf '%s' '{"apiVersion":"batch/v1","kind":"Job","metadata":{"generateName":"md-runbook-cells-test-","namespace":"'"$ns"'"},
"spec":{"backoffLimit":0,"ttlSecondsAfterFinished":10,"template":{"metadata":{"labels":{"app.kubernetes.io/name":"'"$2"'"}},
"spec":{"restartPolicy":"Never","serviceAccountName":"'"$1"'","automountServiceAccountToken":false,
"securityContext":{"runAsNonRoot":true,"runAsUser":10001,"runAsGroup":10001,"seccompProfile":{"type":"RuntimeDefault"}},
"containers":[{"name":"cells","image":"'"$image"'","command":["true"],
"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}},
"volumeMounts":[{"name":"v","mountPath":"/v"}]}],"volumes":['"$3"']}}}}'
}
empty='{"name":"v","emptyDir":{}}'
good=$(test_job md-runbook-cells md-runbook-cells "$empty")
variant() { jq -c "$1" <<<"$good"; } # JQ_FILTER: the good Job, changed
# denied MODE WHAT JOB: refused by the policy (MODE dry: a server dry run; real: a create, and a
# Job that got through is deleted). 1 when refused for another reason.
denied() {
  local out dry=()
  [ "$1" = dry ] && dry=(--dry-run=server)
  if out=$(kubectl "${as_gate[@]}" create "${dry[@]}" -f - -o name <<<"$3" 2>&1); then
    [ "$1" = dry ] || k delete "$out" --wait=false || true
    fail "$2: the gate's account may create it ($out)"
  fi
  grep -qF "$policy" <<<"$out" || { echo "$2: $out" >&2; return 1; }
  echo "ok: $2: refused by the policy"
}
# The re-created binding takes a moment to be in force: dry runs until it is. (A dry run that
# passes meanwhile is no failure yet.)
for i in $(seq 1 30); do
  out=$(kubectl "${as_gate[@]}" create --dry-run=server -f - -o name <<<"$(test_job md-runbook-ops md-runbook-cells "$empty")" 2>&1) || true
  grep -qF "$policy" <<<"$out" && break
  [ "$i" -lt 30 ] || fail "the binding is back, but a Job as the gate's own account isn't refused after 30 s: $out"
  sleep 1
done
echo "the binding is in force again after $i s"
denied real "a Job as the gate's own account" "$(test_job md-runbook-ops md-runbook-cells "$empty")" || fail "own account"
denied real "a Job as the account default" "$(test_job default md-runbook-cells "$empty")" || fail "account default"
denied real "a Job with the host key Secret as a volume" \
  "$(test_job md-runbook-cells md-runbook-cells '{"name":"v","secret":{"secretName":"md-runbook-ops-hostkey"}}')" || fail "a Secret volume"
denied real "a Job without the label app.kubernetes.io/name=md-runbook-cells" "$(test_job md-runbook-cells other "$empty")" || fail "no label"
for c in \
  'another registry|.spec.template.spec.containers[0].image="md-runbook-ops:5000/evil:x"' \
  'another repository|.spec.template.spec.containers[0].image="md-runbook-ops-evil:x"' \
  'envFrom a ConfigMap|.spec.template.spec.containers[0].envFrom=[{"configMapRef":{"name":"md-runbook-ops-gate"}}]' \
  'hostNetwork|.spec.template.spec.hostNetwork=true' \
  'another label|.spec.template.metadata.labels.extra="1"' \
  'an annotation|.spec.template.metadata.annotations={"k8s.v1.cni.cncf.io/networks":"other"}' \
  'a runtime class|.spec.template.spec.runtimeClassName="runc"' \
  'a node|.spec.template.spec.nodeName="ops-control-plane"'; do
  denied dry "a Job with ${c%%|*}" "$(variant "${c#*|}")" || fail "${c%%|*}"
done
# The Job's API adds its labels (job-name, controller-uid) before admission: the policy allows them.
out=$(kubectl "${as_gate[@]}" create --dry-run=server -f - -o json <<<"$good" 2>&1) ||
  fail "a Job like the gate's, as the gate's account: $out"
echo "ok: a Job like the gate's passes, its pods' labels: $(jq -c '.spec.template.metadata.labels' <<<"$out")"

# Exec: the gate's account may exec only into its Jobs' pods (the sessions above did), not into
# the ops pod (policy md-runbook-ops-exec).
if out=$(kubectl "${as_gate[@]}" -n "$ns" exec "$ops_pod" -c ops -- true 2>&1); then
  fail "the gate's account may exec into the ops pod"
fi
grep -qF "ValidatingAdmissionPolicy 'md-runbook-ops-exec'" <<<"$out" || fail "exec into the ops pod: refused, but not by md-runbook-ops-exec: $out"
echo "ok: exec into the ops pod as the gate's account: refused by the policy"

# ---- cells-egress.yaml: the Job pods reach DNS and the API server, nothing else ----
# The API server's endpoint (what the NetworkPolicy sees), as README.md says to find it.
api_ip=$(kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes -o jsonpath='{.items[0].endpoints[0].addresses[0]}')
api_port=$(kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes -o jsonpath='{.items[0].ports[0].port}')
echo "API server endpoint: $api_ip:$api_port"
[ -n "$api_ip" ] && [ -n "$api_port" ] || fail "no endpoint for the kubernetes Service"
# Another namespace's Service, which the blocks reach before the policy and not after it.
target=md-runbook-egress-target
kubectl create namespace "$target"
kubectl -n "$target" run echo --image="$image" --image-pull-policy=IfNotPresent --port=8080 --command -- nc -lk 8080
kubectl -n "$target" expose pod echo --port=8080
kubectl -n "$target" wait --for=condition=Ready pod/echo --timeout=120s
reach="getent hosts echo.$target.svc.cluster.local >/dev/null && echo dns=ok
nc -z -w 3 echo.$target.svc.cluster.local 8080 && echo service=open
nc -z -w 3 1.1.1.1 443 && echo internet=open
kubectl get pods -n $ns -o name >/dev/null && echo api=ok
echo done=1"

open_session h 7
cell 0000ac01 "$reach" >&7
wait_for "$work/h/out" '__MDRB_0000ac01__ 0'
close_session h 7
grep -a '=' "$work/h/out" | grep -av MDRB || true
[ "$(value h service)" = open ] || fail "before the egress policy: no connection to the other namespace's Service"
internet_before=$(value h internet)
# The ops pod too, before ops-egress.yaml (below).
k exec "$ops_pod" -c ops -- nc -z -w 3 "echo.$target.svc.cluster.local" 8080 ||
  fail "before ops-egress.yaml: the ops pod doesn't reach the other namespace's Service"

sed -e "s|192.0.2.10/32|$api_ip/32|" -e "s|port: 6443 }|port: $api_port }|" "$(dirname "$0")/../../apps/ops/kubernetes/cells-egress.yaml" > "$work/egress.yaml"
grep -q "cidr: $api_ip/32" "$work/egress.yaml" && grep -q "port: $api_port }" "$work/egress.yaml" || fail "cells-egress.yaml: the placeholders moved"
kubectl apply -f "$work/egress.yaml"

# A new session's pod starts under the policy: start.sh waits for the API server, the gate checks
# the cells' account through it, and the block reaches it; not the Service, not the internet.
open_session i 8
cell 0000ac02 "$reach" >&8
wait_for "$work/i/out" '__MDRB_0000ac02__ 0' 150
close_session i 8
grep -a '=' "$work/i/out" | grep -av MDRB || true
[ "$(value i api)" = ok ] || fail "under the egress policy: no API server"
[ "$(value i dns)" = ok ] || fail "under the egress policy: no DNS"
[ -z "$(value i service)" ] || fail "under the egress policy: the other namespace's Service is reachable"
if [ "$internet_before" = open ]; then
  [ -z "$(value i internet)" ] || fail "under the egress policy: the internet is reachable"
else
  echo "note: 1.1.1.1:443 wasn't reachable before the policy either"
fi
echo "ok: under cells-egress.yaml the blocks reach the API server and DNS only"
kubectl delete -f "$work/egress.yaml"

# ---- ops-egress.yaml: the ops pod reaches DNS and the API server, nothing else ----
# A session still works through it: sshd's replies (the policy is stateful), the gate's Job and
# its kubectl exec (both through the API server), over the same port-forward.
sed -e "s|192.0.2.10/32|$api_ip/32|" -e "s|port: 6443 }|port: $api_port }|" "$(dirname "$0")/../../apps/ops/kubernetes/ops-egress.yaml" > "$work/ops-egress.yaml"
grep -q "cidr: $api_ip/32" "$work/ops-egress.yaml" && grep -q "port: $api_port }" "$work/ops-egress.yaml" || fail "ops-egress.yaml: the placeholders moved"
kubectl apply -f "$work/ops-egress.yaml"
open_session j 7
cell 0000ac03 "kubectl get pods -n $ns -o name >/dev/null && echo api=ok" >&7
wait_for "$work/j/out" '__MDRB_0000ac03__ 0' 150
close_session j 7
[ "$(value j api)" = ok ] || fail "under ops-egress.yaml: no session"
k exec "$ops_pod" -c ops -- getent hosts "echo.$target.svc.cluster.local" > /dev/null || fail "under ops-egress.yaml: the ops pod has no DNS"
if k exec "$ops_pod" -c ops -- nc -z -w 3 "echo.$target.svc.cluster.local" 8080; then
  fail "under ops-egress.yaml: the ops pod reaches the other namespace's Service"
fi
echo "ok: under ops-egress.yaml a session works, and the ops pod reaches DNS but not the other Service"
kubectl delete -f "$work/ops-egress.yaml"
kubectl delete namespace "$target" --wait=false

# Every session's Job goes (the app's tests before this ran many), pods too.
for _ in $(seq 1 90); do
  [ -z "$(k get jobs,pods -l app.kubernetes.io/name=md-runbook-cells -o name)" ] && break
  sleep 1
done
left=$(k get jobs,pods -l app.kubernetes.io/name=md-runbook-cells -o name)
[ -z "$left" ] || fail "left after their sessions: $left"

log=$(k logs "$ops_pod" -c ops)
grep -q '"event":"session".*"gate_mode":"separated","isolation":"pod","cells_runner":"kubernetes-job","job":"'"$job_a"'"' <<<"$log" ||
  fail "no session event with gate_mode separated for $job_a"
grep -q '"event":"job","status":"ready","job":"'"$job_a"'","pod":"'"$pod_a"'"' <<<"$log" || fail "no ready event for $job_a"
grep -q '"event":"job","status":"deleted","job":"'"$job_a"'"' <<<"$log" || fail "no deleted event for $job_a"
grep '"event":"job","status":"ready"' <<<"$log" | sed 's/.*"seconds":"\([0-9.]*\)".*/pod ready in \1 s/' | sort | uniq -c
echo "ok: each session's blocks ran in a Job of their own"

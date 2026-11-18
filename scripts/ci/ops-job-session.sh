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
#     gate's account can't create a Job as another account, with a Secret, or without the label;
#   - cells-egress.yaml: blocks still reach the API server and DNS, not another namespace's
#     Service nor the internet.
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
kubectl delete namespace md-runbook-unguarded --wait=false

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
# like the gate's passes (a dry run); as another account, with a Secret, without the label: no.
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
denied() { # WHAT JOB: refused by the policy; a Job that got through is deleted, and fails
  local out
  if out=$(kubectl "${as_gate[@]}" create -f - -o name <<<"$2" 2>&1); then
    k delete "$out" --wait=false || true
    fail "$1: the gate's account created it"
  fi
  grep -qF "$policy" <<<"$out" || { echo "$out" >&2; return 1; }
  echo "ok: $1: refused by the policy"
}
# The first one also waits until the binding is back in force.
for i in $(seq 1 30); do
  denied "a Job as the gate's own account" "$(test_job md-runbook-ops md-runbook-cells "$empty")" && break
  [ "$i" -lt 30 ] || fail "a Job as the gate's own account: not refused by the policy"
  sleep 1
done
denied "a Job as the account default" "$(test_job default md-runbook-cells "$empty")" || fail "account default"
denied "a Job with the host key Secret as a volume" \
  "$(test_job md-runbook-cells md-runbook-cells '{"name":"v","secret":{"secretName":"md-runbook-ops-hostkey"}}')" || fail "a Secret volume"
denied "a Job without the label app.kubernetes.io/name=md-runbook-cells" "$(test_job md-runbook-cells other "$empty")" || fail "no label"
out=$(kubectl "${as_gate[@]}" create --dry-run=server -f - -o name <<<"$(test_job md-runbook-cells md-runbook-cells "$empty")" 2>&1) ||
  fail "a Job like the gate's, as the gate's account: $out"
echo "ok: a Job like the gate's passes ($out)"

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

#!/usr/bin/env bash
# The ops host's Jobs (cells_runner = kubernetes-job), through OpenSSH as an app session goes:
#   - each session's blocks run in a pod of their own, as md-runbook-cells, not in the ops pod;
#   - a block can't read the gate's service account token, report token or log;
#   - two sessions get two pods;
#   - the Job goes when its session ends;
#   - the gate logs gate_mode separated.
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
# A session on file descriptor FD whose input is a FIFO; its output in $work/NAME.
open_session() { # NAME FD
  mkdir -p "$work/$1"
  mkfifo "$work/$1/in"
  ssh "${ssh_opts[@]}" ops@127.0.0.1 < "$work/$1/in" > "$work/$1/out" 2> "$work/$1/err" &
  echo $! > "$work/$1/pid"
  eval "exec $2>\"\$work/\$1/in\""
  printf ': mdrb-gate-hello 0000aa00; x\n' >&"$2"
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
cat /etc/md-runbook/report-token >/dev/null 2>&1 && echo "leak=report-token"
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

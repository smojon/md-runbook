#!/usr/bin/env bash
# job_audit_who (apps/ops/kubernetes/impersonation.yaml): the Kubernetes audit log names who ran
# a block. In the kind cluster, through OpenSSH as an app session goes:
#   - job_audit_who = yes without the RBAC: no session (the gate's check in the Job's pod);
#   - with it, a certificate login (key ID alice@example): kubectl in a block is the cells'
#     account, with alice@example in the extra md-runbook.dev/operator; a plain key: its
#     fingerprint;
#   - a key ID with ', #, ": ", { and $: kubectl carries it as it is;
#   - a block can't impersonate the gate's account, system:masters, another user, or another
#     extra key: the API server refuses each as an impersonation;
#   - a grant of more impersonation (a named service account; constrained impersonation's
#     verbs): no session;
#   - the API server's audit log (the kind cluster's audit policy): the block's call, with user
#     the cells' account and its pod, and impersonatedUser with alice@example.
# Needs KEYS (client, client.pub, ssh_host_ecdsa_key.pub, authorized_keys, gate-cluster.conf,
# allowed_signers) and the kind cluster "ops" with its audit log (ops.yml). Restarts the ops
# Deployment; leaves gate.conf and the keys as they were.
set -euo pipefail

ns=md-runbook-ops
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
cells=system:serviceaccount:md-runbook-ops:md-runbook-cells
audit_log=/var/log/kubernetes/kube-apiserver-audit.log
k() { kubectl -n "$ns" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
fp() { ssh-keygen -lf "$1" | awk '{ print $2 }'; }

cd "$work"
ssh-keygen -q -t ed25519 -N '' -C ci-audit-ca -f ca
ssh-keygen -q -t ed25519 -N '' -C alice -f alice
ssh-keygen -q -s ca -I alice@example -n ops -z 77 -V -5m:+1h alice.pub
odd_id="o'brien #1: {x} \$HOME \$(id)"
ssh-keygen -q -t ed25519 -N '' -C odd -f odd
ssh-keygen -q -s ca -I "$odd_id" -n ops -z 78 -V -5m:+1h odd.pub
port=2231
echo "[127.0.0.1]:$port $(cut -d' ' -f1,2 "$KEYS/ssh_host_ecdsa_key.pub")" > known_hosts

# gate CONF_FILE: the ConfigMap md-runbook-ops-gate with this gate.conf; then the ops pod
# restarted (with user_ca) and forwarded to $port.
pf=
gate() {
  k create configmap md-runbook-ops-gate --from-file=gate.conf="$1" \
    --from-file=allowed_signers="$KEYS/allowed_signers" --dry-run=client -o yaml | kubectl replace -f -
  k create configmap md-runbook-ops-keys --from-file=authorized_keys="$KEYS/authorized_keys" \
    --from-file=user_ca="$work/ca.pub" --dry-run=client -o yaml | kubectl replace -f -
  k rollout restart deployment/md-runbook-ops
  k rollout status deployment/md-runbook-ops --timeout=180s
  [ -z "$pf" ] || kill "$pf" 2>/dev/null || true
  local pod=
  for _ in $(seq 1 90); do
    pod=$(k get pods -l app.kubernetes.io/name=md-runbook-ops -o json |
      jq -r '[.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running")] | if length == 1 then .[0].metadata.name else "" end')
    [ -n "$pod" ] && break
    sleep 1
  done
  [ -n "$pod" ] || fail "no single running ops pod"
  k port-forward "pod/$pod" "$port:2222" > "$work/pf.log" 2>&1 &
  pf=$!
  for _ in $(seq 1 30); do nc -z 127.0.0.1 "$port" && return 0; sleep 1; done
  fail "nothing listens on 127.0.0.1:$port"
}

# A raw request: the block, then the end-of-cell marker on both streams (as the app sends it).
cell() { # ID TEXT
  local end='__rc=$?; printf '"'"'\036%s %s\n'"'"' __MDRB_ID__ "$__rc" >&2; printf '"'"'\036%s %s\n'"'"' __MDRB_ID__ "$__rc"'
  printf 'raw %s %s\n' "$1" "$(printf '%s\n%s\n' "$2" "${end//ID/$1}" | base64 -w0)"
}
wait_for() { # FILE PATTERN [SECONDS]
  local i
  for ((i = 0; i < ${3:-120} * 5; i++)); do
    grep -aq -- "$2" "$1" 2>/dev/null && return 0
    sleep 0.2
  done
  echo "--- $1" >&2; cat -v "$1" >&2 || true
  echo "--- ${1%/*}/err" >&2; cat -v "${1%/*}/err" >&2 || true
  k logs deployment/md-runbook-ops --tail=30 >&2 || true
  fail "no $2 in $1"
}
# session NAME KEY [CERT] BLOCK: one session on its own FIFO, the block as a raw request; the
# session's output in $work/s/NAME/out and err once the block ended (or the session did). (Not
# $work/NAME: the key files are there.)
session() {
  local name=$1 key=$2 cert=$3 block=$4 certopt=() d="$work/s/$1"
  [ -n "$cert" ] && certopt=(-o CertificateFile="$cert")
  mkdir -p "$d"
  mkfifo "$d/in"
  ssh -T -p "$port" -i "$key" "${certopt[@]}" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes -o LogLevel=ERROR \
    ops@127.0.0.1 < "$d/in" > "$d/out" 2> "$d/err" &
  local pid=$!
  exec 7> "$d/in"
  printf ': mdrb-gate-hello 0000ab00; x\n' >&7
  wait_for "$d/out" '__MDRB_0000ab00__'
  cell 0000ab01 "$block" >&7
  # The block's end, or the gate's line that the session's cells can't start.
  for _ in $(seq 1 600); do
    grep -aq '__MDRB_0000ab01__' "$d/out" && break
    grep -aq "cells can't start" "$d/err" && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  exec 7>&-
  wait "$pid" || true
  echo "--- session $name" >&2
  tr '\036' '|' < "$d/out" >&2 || true
  cat "$d/err" >&2 || true
}
value() { sed -n "s/^$2=//p" "$work/s/$1/out" | head -n 1; }
# refused NAME WHAT PATTERN: session NAME's cells didn't start, the gate saying PATTERN.
refused() {
  grep -aq "cells can't start" "$work/s/$1/err" || fail "$2: the cells started"
  grep -aq -- "$3" "$work/s/$1/err" || fail "$2: not the reason ($3)"
  [ -z "$(value "$1" 'done')" ] || fail "$2: a block ran"
  echo "ok: $2: no session"
}

block='kubectl auth whoami -o json > /tmp/whoami.json 2>&1 || true
echo "user=$(jq -r .status.userInfo.username /tmp/whoami.json 2>/dev/null)"
echo "operator=$(jq -r ".status.userInfo.extra[\"md-runbook.dev/operator\"] | join(\",\")" /tmp/whoami.json 2>/dev/null)"
echo "extras=$(jq -r ".status.userInfo.extra | keys | join(\",\")" /tmp/whoami.json 2>/dev/null)"
kubectl -n default get deployment web -o name > /dev/null 2>&1 && echo "read=ok"
# Each must fail as an impersonation the API server refuses, not for another reason.
forge() { # NAME KUBECTL-ARGS...
  local out
  if out=$(kubectl auth whoami "${@:2}" 2>&1); then
    echo "forged=$1"
  elif ! printf "%s" "$out" | grep -q "cannot impersonate"; then
    echo "unclear=$1: $(printf "%s" "$out" | head -n 1)"
  fi
}
forge gate-account --as=system:serviceaccount:md-runbook-ops:md-runbook-ops
forge user --as=system:admin
forge masters --as='"$cells"' --as-group=system:masters
forge other-account --as=system:serviceaccount:default:default
forge other-extra --as='"$cells"' --as-user-extra=scopes=admin
forge pod-extra --as='"$cells"' --as-user-extra=authentication.kubernetes.io/pod-name=x
kubectl auth whoami --as='"$cells"' --as-user-extra=md-runbook.dev/operator=mallory@example -o json > /tmp/claim.json 2>&1 &&
  grep -q mallory@example /tmp/claim.json && echo "claim=any"
echo "done=1"'

cp "$KEYS/gate-cluster.conf" gate-audit.conf
echo 'job_audit_who = yes' >> gate-audit.conf

# ---- job_audit_who without the RBAC: no session ----
kubectl delete -f "$root/apps/ops/kubernetes/impersonation.yaml" --ignore-not-found
gate gate-audit.conf
session norbac alice alice-cert.pub "$block"
refused norbac "job_audit_who without the RBAC" "kubectl auth whoami failed"

# ---- with it ----
kubectl apply -f "$root/apps/ops/kubernetes/impersonation.yaml"
session alice alice alice-cert.pub "$block"
[ "$(value alice user)" = "$cells" ] || fail "kubectl in a block is $(value alice user)"
[ "$(value alice operator)" = alice@example ] || fail "the operator extra is $(value alice operator)"
[ "$(value alice extras)" = md-runbook.dev/operator ] || fail "extras: $(value alice extras)"
[ "$(value alice read)" = ok ] || fail "the impersonated account lost its rights (get deployment web)"
[ -z "$(value alice forged)" ] || fail "a block impersonated: $(grep '^forged=' s/alice/out | tr '\n' ' ')"
[ -z "$(value alice unclear)" ] || fail "an impersonation failed for another reason: $(grep '^unclear=' s/alice/out | tr '\n' ' ')"
[ "$(value alice 'done')" = 1 ] || fail "the block didn't finish"
echo "ok: a certificate login: kubectl is the cells' account with operator alice@example; no other impersonation"
# What RBAC can't hold (docs/features/kubernetes.md): the extra's value is the block's to choose.
[ "$(value alice claim)" = any ] && echo "note: as documented, a block can set another name in the extra (the gate's log stays the authority)"

session plain "$KEYS/client" "" "$block"
[ "$(value plain operator)" = "$(fp "$KEYS/client.pub")" ] || fail "a plain key: the operator extra is $(value plain operator)"
echo "ok: a plain key: the operator extra is its fingerprint"

session odd odd odd-cert.pub "$block"
[ "$(value odd operator)" = "$odd_id" ] || fail "a key ID with ' # : { \$: the operator extra is $(value odd operator)"
echo "ok: a key ID with ' # : { \$: the operator extra is the key ID as it is"

# ---- more impersonation than impersonation.yaml's: no session ----
kubectl apply -f - <<'YAML'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: ci-impersonate-gate, namespace: md-runbook-ops}
rules:
  - {apiGroups: [''], resources: [serviceaccounts], resourceNames: [md-runbook-ops], verbs: [impersonate]}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: ci-impersonate-gate, namespace: md-runbook-ops}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: ci-impersonate-gate}
subjects: [{kind: ServiceAccount, name: md-runbook-cells, namespace: md-runbook-ops}]
YAML
session named alice alice-cert.pub "$block"
refused named "impersonate the gate's account by name" "may impersonate.*serviceaccounts.*md-runbook-ops"
kubectl -n "$ns" delete role/ci-impersonate-gate rolebinding/ci-impersonate-gate

# Rights no question without a name sees, only the rules review: a user by name, and
# constrained impersonation's verbs (KEP-5284; RBAC takes any verb, on any version).
kubectl apply -f - <<'YAML'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: ci-impersonate-constrained}
rules:
  - {apiGroups: [''], resources: [users], resourceNames: [kubernetes-admin], verbs: [impersonate]}
  - {apiGroups: [authentication.k8s.io], resources: [users], resourceNames: [kubernetes-admin], verbs: ['impersonate:user-info']}
  - {apiGroups: [''], resources: [pods], verbs: ['impersonate-on:user-info:get']}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: ci-impersonate-constrained}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: ci-impersonate-constrained}
subjects: [{kind: ServiceAccount, name: md-runbook-cells, namespace: md-runbook-ops}]
YAML
session constrained alice alice-cert.pub "$block"
refused constrained "a user by name" "verbs \[impersonate\] on \[users\] of API groups \[\] named \[kubernetes-admin\]"
refused constrained "constrained impersonation's verbs" "verbs \[impersonate:user-info\] on \[users\]"
kubectl delete clusterrole/ci-impersonate-constrained clusterrolebinding/ci-impersonate-constrained

# ---- the API server's audit log ----
docker exec ops-control-plane cat "$audit_log" > audit.log
jq -c --arg cells "$cells" 'select(.user.username == $cells and .impersonatedUser.username == $cells
    and .impersonatedUser.extra["md-runbook.dev/operator"] == ["alice@example"]
    and (.user.extra["authentication.kubernetes.io/pod-name"][0] // "" | startswith("md-runbook-cells-"))
    and .objectRef.resource == "deployments" and .objectRef.name == "web" and .verb == "get")' audit.log > found.log
[ -s found.log ] || { tail -n 5 audit.log >&2; fail "no audit event for the block's get with alice@example"; }
head -n 1 found.log
echo "ok: the audit log has the block's call: user the cells' account and its pod, impersonatedUser with alice@example"

# ---- as before ----
kill "$pf" 2>/dev/null || true
k create configmap md-runbook-ops-gate --from-file=gate.conf="$KEYS/gate-cluster.conf" \
  --from-file=allowed_signers="$KEYS/allowed_signers" --dry-run=client -o yaml | kubectl replace -f -
k create configmap md-runbook-ops-keys --from-file=authorized_keys="$KEYS/authorized_keys" \
  --dry-run=client -o yaml | kubectl replace -f -
kubectl delete -f "$root/apps/ops/kubernetes/impersonation.yaml"
k rollout restart deployment/md-runbook-ops
k rollout status deployment/md-runbook-ops --timeout=180s

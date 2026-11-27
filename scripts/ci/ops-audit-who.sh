#!/usr/bin/env bash
# job_audit_who (apps/ops/kubernetes/impersonation.yaml): the Kubernetes audit log names who ran
# a block. In the kind cluster, through OpenSSH as an app session goes:
#   - job_audit_who = yes without the RBAC: no session (the gate's check in the Job's pod);
#   - with it, a certificate login (key ID alice@example): kubectl in a block is the cells'
#     account, with alice@example in the extra md-runbook.dev/operator; a plain key: its
#     fingerprint;
#   - a block can't impersonate the gate's account, system:masters, another user, or another
#     extra key;
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
# session's output in $work/NAME/out and err once the block ended (or the session did).
session() {
  local name=$1 key=$2 cert=$3 block=$4 certopt=()
  [ -n "$cert" ] && certopt=(-o CertificateFile="$cert")
  mkdir -p "$work/$name"
  mkfifo "$work/$name/in"
  ssh -T -p "$port" -i "$key" "${certopt[@]}" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes -o LogLevel=ERROR \
    ops@127.0.0.1 < "$work/$name/in" > "$work/$name/out" 2> "$work/$name/err" &
  local pid=$!
  exec 7> "$work/$name/in"
  printf ': mdrb-gate-hello 0000ab00; x\n' >&7
  wait_for "$work/$name/out" '__MDRB_0000ab00__'
  cell 0000ab01 "$block" >&7
  # The block's end, or the gate's line that the session's cells can't start.
  for _ in $(seq 1 600); do
    grep -aq '__MDRB_0000ab01__' "$work/$name/out" && break
    grep -aq "cells can't start" "$work/$name/err" && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  exec 7>&-
  wait "$pid" || true
}
value() { sed -n "s/^$2=//p" "$work/$1/out" | head -n 1; }

block='kubectl auth whoami -o json > /tmp/whoami.json 2>&1 || true
echo "user=$(jq -r .status.userInfo.username /tmp/whoami.json 2>/dev/null)"
echo "operator=$(jq -r ".status.userInfo.extra[\"md-runbook.dev/operator\"] | join(\",\")" /tmp/whoami.json 2>/dev/null)"
echo "extras=$(jq -r ".status.userInfo.extra | keys | join(\",\")" /tmp/whoami.json 2>/dev/null)"
kubectl -n default get deployment web -o name > /dev/null 2>&1 && echo "read=ok"
kubectl auth whoami --as=system:serviceaccount:md-runbook-ops:md-runbook-ops > /dev/null 2>&1 && echo "forged=gate-account"
kubectl auth whoami --as=system:admin > /dev/null 2>&1 && echo "forged=user"
kubectl auth whoami --as='"$cells"' --as-group=system:masters > /dev/null 2>&1 && echo "forged=masters"
kubectl auth whoami --as=system:serviceaccount:default:default > /dev/null 2>&1 && echo "forged=other-account"
kubectl auth whoami --as='"$cells"' --as-user-extra=scopes=admin > /dev/null 2>&1 && echo "forged=other-extra"
kubectl auth whoami --as='"$cells"' --as-user-extra=md-runbook.dev/operator=mallory@example -o json > /tmp/claim.json 2>&1 &&
  grep -q mallory@example /tmp/claim.json && echo "claim=any"
echo "done=1"'

cp "$KEYS/gate-cluster.conf" gate-audit.conf
echo 'job_audit_who = yes' >> gate-audit.conf

# ---- job_audit_who without the RBAC: no session ----
kubectl delete -f "$root/apps/ops/kubernetes/impersonation.yaml" --ignore-not-found
gate gate-audit.conf
session norbac alice alice-cert.pub "$block"
grep -aq "cells can't start" norbac/err || fail "job_audit_who without the RBAC: the cells started"
grep -aq "can't impersonate itself" norbac/err || { cat norbac/err >&2; fail "job_audit_who without the RBAC: not the reason"; }
[ -z "$(value norbac 'done')" ] || fail "job_audit_who without the RBAC: a block ran"
echo "ok: job_audit_who without the RBAC: no session"

# ---- with it ----
kubectl apply -f "$root/apps/ops/kubernetes/impersonation.yaml"
session alice alice alice-cert.pub "$block"
cat alice/out | tr '\036' '|'
[ "$(value alice user)" = "$cells" ] || fail "kubectl in a block is $(value alice user)"
[ "$(value alice operator)" = alice@example ] || fail "the operator extra is $(value alice operator)"
[ "$(value alice extras)" = md-runbook.dev/operator ] || fail "extras: $(value alice extras)"
[ "$(value alice read)" = ok ] || fail "the impersonated account lost its rights (get deployment web)"
[ -z "$(value alice forged)" ] || fail "a block impersonated: $(grep '^forged=' alice/out | tr '\n' ' ')"
[ "$(value alice 'done')" = 1 ] || fail "the block didn't finish"
echo "ok: a certificate login: kubectl is the cells' account with operator alice@example; no other impersonation"
# What RBAC can't hold (docs/features/kubernetes.md): the extra's value is the block's to choose.
[ "$(value alice claim)" = any ] && echo "note: as documented, a block can set another name in the extra (the gate's log stays the authority)"

session plain "$KEYS/client" "" "$block"
[ "$(value plain operator)" = "$(fp "$KEYS/client.pub")" ] || fail "a plain key: the operator extra is $(value plain operator)"
echo "ok: a plain key: the operator extra is its fingerprint"

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

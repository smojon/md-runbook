#!/usr/bin/env bash
# SSH user certificates on the ops host (apps/ops/README.md, "SSH certificates"), in the kind
# cluster, through OpenSSH:
#   - user_ca in the ConfigMap md-runbook-ops-keys: a certificate of that CA for the principal
#     ops logs in, and the gate logs its key ID as who, with its serial, its CA and its key (so
#     sshd's ExposeAuthInfo file holds the certificate, not only its key);
#   - refused: an expired certificate, one for another principal, one of another CA, and two
#     that the KRL revoked_keys revokes (by serial, by key ID);
#   - a key ID with a line break logs in, but who stays the key's fingerprint;
#   - a plain key of authorized_keys still logs in, logged as before (its fingerprint);
#   - authorized_principals: a certificate for its principal logs in; one for ops no longer does.
# Needs KEYS (client, client.pub, ssh_host_ecdsa_key.pub, authorized_keys). Restarts the ops
# Deployment (its earlier log is gone): run it after the checks of that log.
set -euo pipefail

ns=md-runbook-ops
work=$(mktemp -d)
k() { kubectl -n "$ns" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
fp() { ssh-keygen -lf "$1" | awk '{ print $2 }'; }

# ---- a CA, its certificates, a KRL ----
cd "$work"
ssh-keygen -q -t ed25519 -N '' -C ci-user-ca -f ca
ssh-keygen -q -t ed25519 -N '' -C ci-other-ca -f other-ca
cert() { # NAME CA KEY_ID PRINCIPALS SERIAL [VALIDITY]: key pair NAME, certificate NAME-cert.pub
  ssh-keygen -q -t ed25519 -N '' -C "$1" -f "$1"
  ssh-keygen -q -s "$2" -I "$3" -n "$4" -z "$5" -V "${6:--5m:+1h}" "$1.pub"
}
cert alice ca alice@example ops 42
cert expired ca expired@example ops 43 20200101Z:20200102Z
cert wrong ca wrong@example alice 44
cert stranger other-ca stranger@example ops 45
cert revoked ca revoked@example ops 13
cert mallory ca mallory@example ops 46
cert eve ca "$(printf 'eve\n{"who":"alice@example"}')" ops 47
cert oncall ca oncall@example md-runbook-oncall 48
printf '%s\n' 'serial: 13' 'id: mallory@example' > krl.txt
ssh-keygen -k -f revoked_keys -s ca.pub krl.txt
ssh-keygen -Q -f revoked_keys revoked-cert.pub mallory-cert.pub && fail "the KRL doesn't revoke"
ssh-keygen -Q -f revoked_keys alice-cert.pub || fail "the KRL revokes alice"

echo "[127.0.0.1]:2225 $(cut -d' ' -f1,2 "$KEYS/ssh_host_ecdsa_key.pub")" > known_hosts
echo "[127.0.0.1]:2226 $(cut -d' ' -f1,2 "$KEYS/ssh_host_ecdsa_key.pub")" >> known_hosts
port=
# keys FILE...: the ConfigMap md-runbook-ops-keys with authorized_keys and these files, then the
# ops pod restarted (sshd takes the directives at its start) and forwarded to PORT.
keys() { # PORT FILE...
  local p=$1 f args=(--from-file=authorized_keys="$KEYS/authorized_keys")
  shift
  for f in "$@"; do args+=(--from-file="$f"); done
  k create configmap md-runbook-ops-keys "${args[@]}" --dry-run=client -o yaml | kubectl replace -f -
  k rollout restart deployment/md-runbook-ops
  k rollout status deployment/md-runbook-ops --timeout=180s
  for _ in $(seq 1 60); do
    [ "$(k get pods -l app.kubernetes.io/name=md-runbook-ops -o name | wc -l)" = 1 ] && break
    sleep 1
  done
  pod=$(k get pods -l app.kubernetes.io/name=md-runbook-ops -o jsonpath='{.items[0].metadata.name}')
  k port-forward "pod/$pod" "$p:2222" > "$work/pf-$p.log" 2>&1 &
  for _ in $(seq 1 30); do nc -z 127.0.0.1 "$p" && break; sleep 1; done
  port=$p
  k logs "$pod" -c ops | grep 'md-runbook-ops:' || true
}
# login NAME KEY [CERT]: a session's hello; 0 when the gate answered it.
login() {
  local certopt=()
  [ -n "${3:-}" ] && certopt=(-o CertificateFile="$3")
  printf ': mdrb-gate-hello 0000c000; x\n' |
    ssh -T -p "$port" -i "$2" "${certopt[@]}" -o BatchMode=yes -o IdentitiesOnly=yes \
      -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes -o LogLevel=ERROR \
      ops@127.0.0.1 > "$work/$1.out" 2> "$work/$1.err" || true
  grep -aq '__MDRB_0000c000__' "$work/$1.out"
}
logs_have() { # PATTERN: in the ops pod's log, within 20 s
  for _ in $(seq 1 20); do
    k logs "$pod" -c ops | grep -q -- "$1" && return 0
    sleep 1
  done
  return 1
}
ok() { login "$1" "$1" "$1-cert.pub" || { cat "$work/$1.err" >&2; fail "$2: no session"; }; echo "ok: $2: logs in"; }
refused() {
  login "$1" "$1" "$1-cert.pub" && fail "$2: a session"
  grep -q 'Permission denied' "$work/$1.err" || { cat "$work/$1.err" >&2; fail "$2: not refused by sshd"; }
  echo "ok: $2: refused"
}

# ---- user_ca and revoked_keys ----
keys 2225 user_ca=ca.pub revoked_keys=revoked_keys
ok alice "a certificate for ops"
logs_have '"who":"alice@example".*"event":"session".*"key":"'"$(fp alice.pub)"'","cert_serial":"42","cert_ca":"'"$(fp ca.pub)"'"' ||
  fail "no session event with who alice@example, serial 42 and the CA"
refused expired "an expired certificate"
refused wrong "a certificate for another principal"
refused stranger "a certificate of another CA"
refused revoked "a certificate revoked by serial"
refused mallory "a certificate revoked by key ID"
ok eve "a key ID with a line break"
logs_have '"who":"'"$(fp eve.pub)"'".*"event":"session".*"cert_serial":"47".*"cert_problem":"key ID with a control or invisible character (U+000A)"' ||
  fail "a key ID with a line break: who isn't the key's fingerprint"
k logs "$pod" -c ops | grep -q '"who":"eve' && fail "a key ID with a line break got into the log"
login plain "$KEYS/client" || fail "a plain key: no session"
logs_have '"who":"'"$(fp "$KEYS/client.pub")"'".*"event":"session"' || fail "a plain key: who isn't its fingerprint"
k logs "$pod" -c ops | grep '"who":"'"$(fp "$KEYS/client.pub")"'".*"event":"session"' | grep -q cert_ &&
  fail "a plain key's session event names a certificate"
echo "ok: a plain key logs in, as before"
echo "sshd's lines on the certificates:"
k logs "$pod" -c ops | grep -E 'certificate|revoked|Accepted publickey' || true

# ---- authorized_principals ----
echo md-runbook-oncall > authorized_principals
keys 2226 user_ca=ca.pub revoked_keys=revoked_keys authorized_principals=authorized_principals
ok oncall "a certificate for a principal of authorized_principals"
logs_have '"who":"oncall@example".*"event":"session".*"cert_serial":"48"' || fail "no session event for oncall@example"
refused alice "with authorized_principals, a certificate for ops"
login plain "$KEYS/client" || fail "with authorized_principals, a plain key: no session"
echo "ok: with authorized_principals, a plain key still logs in"

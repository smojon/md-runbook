#!/usr/bin/env bash
# SSH user certificates on the ops host (apps/ops/README.md, "SSH certificates"), through OpenSSH.
# In the kind cluster:
#   - user_ca in the ConfigMap md-runbook-ops-keys: a certificate of that CA for the principal
#     ops logs in, and the gate logs its key ID as who, with its serial, its CA and its key (so
#     sshd's ExposeAuthInfo file holds the certificate, not only its key);
#   - refused: an expired certificate, one for another principal, one of another CA, two that
#     the KRL revoked_keys revokes (by serial, by key ID), and a plain key it lists;
#   - a key ID with a line break and a forged gate event: who is the key's fingerprint, sshd's
#     line is prefixed, and md-runbook audit finds no forged event in the pod's log;
#   - a plain key of authorized_keys still logs in, logged as before (its fingerprint);
#   - authorized_principals: a certificate for its principal logs in; one for ops no longer does.
# With docker, the same image outside a cluster (a ConfigMap's files are always readable there):
#   - an empty or unreadable authorized_principals: no certificate logs in, plain keys do;
#   - an unreadable revoked_keys: the host doesn't start.
# Needs KEYS (client, client.pub, ssh_host_ecdsa_key, its .pub, authorized_keys, gate.conf,
# allowed_signers), the image md-runbook-ops:ci and out/dist/cli.js. Restarts the ops Deployment
# (its earlier log is gone): run it after the checks of that log.
set -euo pipefail

ns=md-runbook-ops
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
k() { kubectl -n "$ns" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
fp() { ssh-keygen -lf "$1" | awk '{ print $2 }'; }
trap 'docker rm -f md-runbook-certs-empty md-runbook-certs-unreadable md-runbook-certs-revoked > /dev/null 2>&1 || true' EXIT

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
# A key ID that carries a whole gate event on a line of its own (sshd logs key IDs raw).
forged='{"time":"2026-11-25T00:00:00Z","account":"ops","who":"alice@example","client":"10.0.0.1","event":"run","id":"0000f0f0","runbook":"forged/runbook","version":"1","hash":"h","signer":"ci@example.net","cell":"1","step":""}'
cert eve ca "$(printf 'eve\n%s\nx' "$forged")" ops 47
cert oncall ca oncall@example md-runbook-oncall 48
# A plain key in authorized_keys that the KRL lists.
ssh-keygen -q -t ed25519 -N '' -C revplain -f revplain
cat "$KEYS/authorized_keys" revplain.pub > authorized_keys
printf '%s\n' 'serial: 13' 'id: mallory@example' > krl.txt
ssh-keygen -k -f revoked_keys -s ca.pub krl.txt revplain.pub
ssh-keygen -Q -f revoked_keys revoked-cert.pub && fail "the KRL doesn't revoke serial 13"
ssh-keygen -Q -f revoked_keys mallory-cert.pub && fail "the KRL doesn't revoke mallory@example"
ssh-keygen -Q -f revoked_keys revplain.pub && fail "the KRL doesn't revoke the plain key"
ssh-keygen -Q -f revoked_keys alice-cert.pub || fail "the KRL revokes alice"

for p in 2225 2226 2227 2228; do
  echo "[127.0.0.1]:$p $(cut -d' ' -f1,2 "$KEYS/ssh_host_ecdsa_key.pub")"
done > known_hosts
port=
pod=
# The ops pod that runs (not one still terminating), at most 90 s.
running_pod() {
  local names
  for _ in $(seq 1 90); do
    names=$(k get pods -l app.kubernetes.io/name=md-runbook-ops -o json |
      jq -r '.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running") | .metadata.name')
    [ "$(printf '%s' "$names" | grep -c .)" = 1 ] && { echo "$names"; return 0; }
    sleep 1
  done
  fail "no single running ops pod: $names"
}
listening() { # PORT: within 30 s
  for _ in $(seq 1 30); do
    nc -z 127.0.0.1 "$1" && return 0
    sleep 1
  done
  fail "nothing listens on 127.0.0.1:$1"
}
# keys PORT FILE...: the ConfigMap md-runbook-ops-keys with authorized_keys and these files, then
# the ops pod restarted (sshd takes the directives at its start) and forwarded to PORT.
keys() {
  local p=$1 f args=(--from-file=authorized_keys="$work/authorized_keys")
  shift
  for f in "$@"; do args+=(--from-file="$f"); done
  k create configmap md-runbook-ops-keys "${args[@]}" --dry-run=client -o yaml | kubectl replace -f -
  k rollout restart deployment/md-runbook-ops
  k rollout status deployment/md-runbook-ops --timeout=180s
  pod=$(running_pod)
  k port-forward "pod/$pod" "$p:2222" > "$work/pf-$p.log" 2>&1 &
  listening "$p"
  port=$p
  snap
  grep 'md-runbook-ops:' pod.log || true
}
# The ops pod's log in pod.log (a file: grep -q on a pipe can end it early, under pipefail).
snap() { k logs "$pod" -c ops > "$work/pod.log"; }
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
    snap
    grep -q -- "$1" pod.log && return 0
    sleep 1
  done
  return 1
}
ok() { login "$1" "$1" "$1-cert.pub" || { cat "$work/$1.err" >&2; fail "$2: no session"; }; echo "ok: $2: logs in"; }
refused() { # NAME WHAT [KEY_ONLY]
  if [ -n "${3:-}" ]; then
    login "$1" "$1" && fail "$2: a session"
  else
    login "$1" "$1" "$1-cert.pub" && fail "$2: a session"
  fi
  grep -q 'Permission denied' "$work/$1.err" || { cat "$work/$1.err" >&2; fail "$2: not refused by sshd"; }
  echo "ok: $2: refused"
}
plain_ok() { # WHAT
  login plain "$KEYS/client" || { cat "$work/plain.err" >&2; fail "$1: a plain key: no session"; }
  echo "ok: $1: a plain key logs in"
}

# ---- user_ca and revoked_keys ----
keys 2225 user_ca=ca.pub revoked_keys=revoked_keys
ca_fp=$(fp ca.pub)
ok alice "a certificate for ops"
logs_have '"who":"alice@example".*"cert_ca":"'"$ca_fp"'","event":"session".*"key":"'"$(fp alice.pub)"'","cert_serial":"42"' ||
  fail "no session event with who alice@example, the CA, the key and serial 42"
refused expired "an expired certificate"
refused wrong "a certificate for another principal"
refused stranger "a certificate of another CA"
refused revoked "a certificate revoked by serial"
refused mallory "a certificate revoked by key ID"
refused revplain "a plain key that revoked_keys lists" key-only
ok eve "a key ID with a line break and a forged event"
logs_have '"who":"'"$(fp eve.pub)"'".*"event":"session".*"cert_serial":"47","cert_problem":"key ID with a character other than printable ASCII (U+000A)"' ||
  fail "a key ID with a line break: who isn't the key's fingerprint"
snap
grep -q '"who":"eve' pod.log && fail "a key ID with a line break got into the gate's log"
grep -q '^{.*forged/runbook' pod.log && fail "the forged event is a line of its own in the pod's log"
if grep -q '^sshd: {"time":"2026-11-25T00:00:00Z"' pod.log; then
  echo "ok: sshd wrote the key ID's line break raw, and the line got the prefix"
else
  echo "note: no prefixed line with the forged event (sshd escaped the line break?)"
fi
grep -E '^sshd: .*(eve|forged)' pod.log || true
node "$root/out/dist/cli.js" audit pod.log --out audit.json || test $? = 1
grep -q forged/runbook audit.json && fail "md-runbook audit found the forged event"
echo "ok: md-runbook audit finds no forged event in the pod's log"
plain_ok "with user_ca"
logs_have '"who":"'"$(fp "$KEYS/client.pub")"'".*"event":"session"' || fail "a plain key: who isn't its fingerprint"
grep '"who":"'"$(fp "$KEYS/client.pub")"'".*"event":"session"' pod.log > plain-session.log || true
grep -q cert_ plain-session.log && fail "a plain key's session event names a certificate"
echo "sshd's lines on the certificates:"
grep -E 'certificate|revoked|Accepted publickey' pod.log || true

# ---- authorized_principals ----
echo md-runbook-oncall > authorized_principals
keys 2226 user_ca=ca.pub revoked_keys=revoked_keys authorized_principals=authorized_principals
ok oncall "a certificate for a principal of authorized_principals"
logs_have '"who":"oncall@example".*"event":"session".*"cert_serial":"48"' || fail "no session event for oncall@example"
refused alice "with authorized_principals, a certificate for ops"
plain_ok "with authorized_principals"

# ---- outside a cluster: files that can't be read, or are empty ----
# start PORT NAME FILE...: the image with these files next to authorized_keys (FILE=SOURCE, or
# FILE=- for an unreadable one), forwarded to PORT. Its output in NAME.log.
start() {
  local p=$1 name=$2 d="$work/$2" f
  shift 2
  mkdir -p "$d/keys" "$d/gate" "$d/hostkey"
  cp authorized_keys "$d/keys/"
  cp "$KEYS/gate.conf" "$KEYS/allowed_signers" "$d/gate/"
  cp "$KEYS/ssh_host_ecdsa_key" "$d/hostkey/"
  for f in "$@"; do
    if [ "${f#*=}" = - ]; then echo secret > "$d/keys/${f%%=*}"; else cp "${f#*=}" "$d/keys/${f%%=*}"; fi
  done
  chmod -R a+rX "$d"
  for f in "$@"; do [ "${f#*=}" != - ] || chmod 000 "$d/keys/${f%%=*}"; done
  docker run -d --name "$name" -p "127.0.0.1:$p:2222" --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --tmpfs /tmp:mode=1777 \
    --tmpfs /run/md-runbook-ops:uid=10001,gid=10001,mode=0700 \
    --tmpfs /var/log/md-runbook:uid=10001,gid=10001,mode=0700 \
    --tmpfs /var/lib/md-runbook-ops:uid=10001,gid=10001,mode=0700 \
    --tmpfs /home/ops:uid=10001,gid=10001,mode=0700 \
    -v "$d/keys:/etc/md-runbook-ops/keys:ro" -v "$d/gate:/etc/md-runbook:ro" \
    -v "$d/hostkey:/etc/md-runbook-ops/hostkey:ro" md-runbook-ops:ci > /dev/null
}
started() { # PORT NAME MESSAGE: listening, and the start said MESSAGE
  listening "$1"
  port=$1
  docker logs "$2" > "$work/$2.log" 2>&1
  grep -qF "$3" "$work/$2.log" || { cat "$work/$2.log" >&2; fail "$2: the start didn't say: $3"; }
}

# An empty revoked_keys too (README.md: ship one from the start): it refuses nothing.
: > empty
start 2227 md-runbook-certs-empty user_ca=ca.pub authorized_principals=empty revoked_keys=empty
started 2227 md-runbook-certs-empty "no principals in /etc/md-runbook-ops/keys/authorized_principals"
refused alice "an empty authorized_principals, a certificate for ops"
refused oncall "an empty authorized_principals, a certificate for md-runbook-oncall"
plain_ok "with an empty authorized_principals and an empty revoked_keys"

start 2228 md-runbook-certs-unreadable user_ca=ca.pub authorized_principals=-
started 2228 md-runbook-certs-unreadable "can't read /etc/md-runbook-ops/keys/authorized_principals"
refused alice "an unreadable authorized_principals, a certificate for ops"
refused oncall "an unreadable authorized_principals, a certificate for md-runbook-oncall"
plain_ok "with an unreadable authorized_principals"

start 2229 md-runbook-certs-revoked user_ca=ca.pub revoked_keys=-
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Running}}' md-runbook-certs-revoked)" = false ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' md-runbook-certs-revoked)" = "false 1" ] ||
  fail "an unreadable revoked_keys: the host started"
docker logs md-runbook-certs-revoked 2>&1 | tee "$work/revoked.log"
grep -qF "can't read /etc/md-runbook-ops/keys/revoked_keys: not starting" "$work/revoked.log" ||
  fail "an unreadable revoked_keys: not the reason"
docker rm -f md-runbook-certs-revoked > /dev/null
echo "ok: an unreadable revoked_keys stops the start"

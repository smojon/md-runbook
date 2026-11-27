#!/bin/sh
# Starts the md-runbook ops host: the host key, the kubeconfig, the gate's log on this
# container's output, then sshd. Runs as the account ops. See README.md.
#
# `md-runbook-ops-start cells` starts a session's Job instead (cells_runner = kubernetes-job):
# the kubeconfig of the Job's own service account once the API server answers, then nothing but
# waiting. The gate runs the session's blocks in it with kubectl exec, and deletes the Job when
# the session ends.
set -eu

run=/run/md-runbook-ops
state=/var/lib/md-runbook-ops
logdir=/var/log/md-runbook
sa=/var/run/secrets/kubernetes.io/serviceaccount
say() { printf 'md-runbook-ops: %s\n' "$*" >&2; }

# The Pod's service account as kubeconfig, context CLUSTER_NAME (what kube-context: names). The
# token file is renewed by Kubernetes; kubectl reads it for each request.
api_server() {
  host=$KUBERNETES_SERVICE_HOST
  case $host in *:*) host="[$host]" ;; esac
  echo "https://$host:${KUBERNETES_SERVICE_PORT:-443}"
}
# job_audit_who in gate.conf, in a session's Job only (the gate sets the env): kubectl
# impersonates the Job's own service account (MD_RUNBOOK_KUBE_AS), with the person who logged in
# (MD_RUNBOOK_KUBE_WHO: printable ASCII, the gate checks it) in the user extra
# md-runbook.dev/operator. The Kubernetes audit log then names them. YAML single-quoted strings:
# a ' doubles, nothing else is special.
impersonation() {
  [ "$1" = cells ] && [ -n "${MD_RUNBOOK_KUBE_AS:-}" ] || return 0
  printf "    as: '%s'\n    as-user-extra:\n      md-runbook.dev/operator:\n      - '%s'\n" \
    "$MD_RUNBOOK_KUBE_AS" "$(printf '%s' "${MD_RUNBOOK_KUBE_WHO:-}" | sed "s/'/''/g")"
}
in_cluster_kubeconfig() { # USER [cells]
  cluster=${CLUSTER_NAME:-in-cluster}
  cat >"$HOME/.kube/config" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: $cluster
  cluster:
    server: $(api_server)
    certificate-authority: $sa/ca.crt
users:
- name: $1
  user:
    tokenFile: $sa/token
$(impersonation "${2:-}")
contexts:
- name: $cluster
  context:
    cluster: $cluster
    user: $1
    namespace: $(cat "$sa/namespace" 2>/dev/null || echo default)
current-context: $cluster
EOF
  chmod 600 "$HOME/.kube/config"
}
in_cluster() { [ -r "$sa/token" ] && [ -n "${KUBERNETES_SERVICE_HOST:-}" ]; }

# Waits until the API server answers (any HTTP status), at most 60 s. Under an egress
# NetworkPolicy (cells-egress.yaml) some network plugins drop a new pod's traffic for its first
# seconds. Without one, the first try answers. No credential is sent, so no certificate check:
# any answer shows the way is open.
wait_for_api() {
  end=$(($(date +%s) + 60))
  while :; do
    code=$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 \
      "$(api_server)/livez" 2>/dev/null) || true
    case $code in '' | 000) ;; *) return 0 ;; esac
    if [ "$(date +%s)" -ge "$end" ]; then
      say "cells: no answer from the API server $(api_server) after 60 s; going on (see README.md, Egress)"
      return 0
    fi
    sleep 1
  done
}

mkdir -p "$HOME/.kube"

# ---- a session's Job ----
if [ "${1:-}" = cells ]; then
  if ! in_cluster; then
    say "cells: no service account here: this mode runs only as the gate's Kubernetes Job"
    exit 1
  fi
  wait_for_api
  in_cluster_kubeconfig md-runbook-cells cells
  # Ready (the Job's readiness probe looks for the kubeconfig); stops with the Pod.
  exec sleep infinity
fi

# ---- host key ----
# Yours (a Secret or a mounted file) keeps the fingerprint the app trusts; else one is made once
# and kept in /var/lib/md-runbook-ops (a volume, or the Pod's own folder until it is replaced).
mounted=/etc/md-runbook-ops/hostkey/ssh_host_ecdsa_key
if [ -r "$mounted" ]; then
  cp "$mounted" "$run/ssh_host_ecdsa_key"
else
  if [ ! -s "$state/ssh_host_ecdsa_key" ]; then
    ssh-keygen -q -t ecdsa -b 256 -N '' -C md-runbook-ops -f "$state/ssh_host_ecdsa_key"
    say "made a host key; a new container makes another, which the app reports as a changed key."
    say "To keep it, put your own key in /etc/md-runbook-ops/hostkey (README.md)."
  fi
  cp "$state/ssh_host_ecdsa_key" "$run/ssh_host_ecdsa_key"
fi
chmod 600 "$run/ssh_host_ecdsa_key"
say "host key $(ssh-keygen -lf "$run/ssh_host_ecdsa_key" | awk '{ print $2 }')"

# ---- kubeconfig ----
# A mounted kubeconfig (outside a cluster), else the Pod's service account (inside one). A
# copy, so `kubectl config use-context` works in a runbook. With cells_runner = kubernetes-job
# it is the gate's own: it starts the sessions' Jobs, and blocks never see it.
if [ -r /etc/md-runbook-ops/kubeconfig/config ]; then
  cp /etc/md-runbook-ops/kubeconfig/config "$HOME/.kube/config"
  say "kubeconfig from /etc/md-runbook-ops/kubeconfig/config"
elif in_cluster; then
  in_cluster_kubeconfig md-runbook-ops
  say "kubeconfig for this cluster, context ${CLUSTER_NAME:-in-cluster} (the Pod's service account)"
else
  say "no kubeconfig: mount one at /etc/md-runbook-ops/kubeconfig/config, or run this in a cluster"
fi
chmod 600 "$HOME/.kube/config" 2>/dev/null || true

# ---- keys and the gate ----
has_lines() { grep -q '^[^#[:space:]]' "$1" 2>/dev/null; }
keys=/etc/md-runbook-ops/keys

# SSH user certificates, each file optional (README.md, "SSH certificates"). sshd_config is in
# the image, so these directives go on sshd's command line (-o), and only for files that are
# there: sshd_config(5) says RevokedKeys refuses every key when its file can't be read, and an
# AuthorizedPrincipalsFile that is missing matches no principal. sshd reads them at each login: a
# changed file counts once the mount shows it; a file added or removed, after a restart.
#   user_ca                 TrustedUserCAKeys: certificates of these CAs may log in. Without
#                           authorized_principals, the certificate must name the principal ops
#                           (the account).
#   authorized_principals   AuthorizedPrincipalsFile: the certificate must name one of these
#                           principals instead.
#   revoked_keys            RevokedKeys: a KRL (ssh-keygen -k) or public keys; also for plain keys.
# A file that is there but can't be read fails closed: authorized_principals then matches no
# principal, and revoked_keys stops the start.
there() { [ -e "$1" ] || [ -L "$1" ]; }
set --
if has_lines "$keys/user_ca"; then
  set -- "$@" -o "TrustedUserCAKeys=$keys/user_ca"
  p=$keys/authorized_principals
  if there "$p"; then
    set -- "$@" -o "AuthorizedPrincipalsFile=$p"
    if [ ! -r "$p" ]; then
      say "can't read $p: no SSH certificate can log in"
    elif ! has_lines "$p"; then
      say "no principals in $p: no SSH certificate can log in"
    else
      say "SSH certificates: from the CAs in $keys/user_ca, for the principals in $p"
    fi
  else
    say "SSH certificates: from the CAs in $keys/user_ca, for the principal ops"
  fi
elif there "$keys/user_ca" || there "$keys/authorized_principals"; then
  say "no CA key in $keys/user_ca: no SSH certificate can log in (README.md)"
fi
if there "$keys/revoked_keys"; then
  if [ -r "$keys/revoked_keys" ]; then
    set -- "$@" -o "RevokedKeys=$keys/revoked_keys"
    say "revoked keys and certificates: $keys/revoked_keys"
  else
    say "can't read $keys/revoked_keys: not starting (sshd would refuse every key)"
    exit 1
  fi
fi
has_lines "$keys/authorized_keys" || has_lines "$keys/user_ca" ||
  say "no keys in $keys/authorized_keys: nobody can log in yet (README.md)"
has_lines /etc/md-runbook/allowed_signers ||
  say "no signers in /etc/md-runbook/allowed_signers: signed runbooks can't run yet"
say "gate: $(grep -E '^[[:space:]]*unsigned[[:space:]]*=' /etc/md-runbook/gate.conf 2>/dev/null | tr -d ' ' || echo 'unsigned=refuse')"
if grep -Eq '^[[:space:]]*cells_runner[[:space:]]*=[[:space:]]*kubernetes-job' /etc/md-runbook/gate.conf 2>/dev/null; then
  say "gate: each session's blocks run in a Kubernetes Job of their own"
fi

# The gate's events (JSON, one per line) on this container's output, next to sshd's.
touch "$logdir/gate.log"
tail -n 0 -F "$logdir/gate.log" 2>/dev/null &

# sshd's log, each line prefixed "sshd: ". sshd writes its stderr log raw: a certificate's key ID
# with a line break would start a line of its own, which could pass for a gate event (review of
# the SSH certificates, 2026-11-25). So sshd -E writes to a file of its own (sshd(8): -E appends
# the debug logs to a file instead of the system log), and the prefix goes on every line. The
# trailing CR of sshd's stderr lines goes too.
touch "$logdir/sshd.log"
tail -n 0 -F "$logdir/sshd.log" 2>/dev/null | sed -u 's/\r$//; s/^/sshd: /' >&2 &

exec /usr/sbin/sshd -D -E "$logdir/sshd.log" -f /etc/ssh/md-runbook-ops.conf "$@"

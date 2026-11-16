#!/bin/sh
# Starts the md-runbook ops host: the host key, the kubeconfig, the gate's log on this
# container's output, then sshd. Runs as the account ops. See README.md.
#
# `md-runbook-ops-start cells` starts a session's Job instead (cells_runner = kubernetes-job):
# the kubeconfig of the Job's own service account, then nothing but waiting. The gate runs the
# session's blocks in it with kubectl exec, and deletes the Job when the session ends.
set -eu

run=/run/md-runbook-ops
state=/var/lib/md-runbook-ops
logdir=/var/log/md-runbook
sa=/var/run/secrets/kubernetes.io/serviceaccount
say() { printf 'md-runbook-ops: %s\n' "$*" >&2; }

# The Pod's service account as kubeconfig, context CLUSTER_NAME (what kube-context: names). The
# token file is renewed by Kubernetes; kubectl reads it for each request.
in_cluster_kubeconfig() {
  cluster=${CLUSTER_NAME:-in-cluster}
  host=$KUBERNETES_SERVICE_HOST
  case $host in *:*) host="[$host]" ;; esac
  cat >"$HOME/.kube/config" <<EOF
apiVersion: v1
kind: Config
clusters:
- name: $cluster
  cluster:
    server: https://$host:${KUBERNETES_SERVICE_PORT:-443}
    certificate-authority: $sa/ca.crt
users:
- name: $1
  user:
    tokenFile: $sa/token
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

mkdir -p "$HOME/.kube"

# ---- a session's Job ----
if [ "${1:-}" = cells ]; then
  if ! in_cluster; then
    say "cells: no service account here: this mode runs only as the gate's Kubernetes Job"
    exit 1
  fi
  in_cluster_kubeconfig md-runbook-cells
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
has_lines /etc/md-runbook-ops/keys/authorized_keys ||
  say "no keys in /etc/md-runbook-ops/keys/authorized_keys: nobody can log in yet (README.md)"
has_lines /etc/md-runbook/allowed_signers ||
  say "no signers in /etc/md-runbook/allowed_signers: signed runbooks can't run yet"
say "gate: $(grep -E '^[[:space:]]*unsigned[[:space:]]*=' /etc/md-runbook/gate.conf 2>/dev/null | tr -d ' ' || echo 'unsigned=refuse')"
if grep -Eq '^[[:space:]]*cells_runner[[:space:]]*=[[:space:]]*kubernetes-job' /etc/md-runbook/gate.conf 2>/dev/null; then
  say "gate: each session's blocks run in a Kubernetes Job of their own"
fi

# The gate's events (JSON, one per line) on this container's output, next to sshd's.
touch "$logdir/gate.log"
tail -n 0 -F "$logdir/gate.log" 2>/dev/null &

exec /usr/sbin/sshd -D -e -f /etc/ssh/md-runbook-ops.conf

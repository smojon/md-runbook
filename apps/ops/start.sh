#!/bin/sh
# Starts the md-runbook ops host: the host key, the kubeconfig, the gate's log on this
# container's output, then sshd. Runs as the account ops. See README.md.
set -eu

run=/run/md-runbook-ops
state=/var/lib/md-runbook-ops
logdir=/var/log/md-runbook
say() { printf 'md-runbook-ops: %s\n' "$*" >&2; }

# ---- host key ----
# Yours (a Secret or a mounted file) keeps the fingerprint the app trusts; else one is made once
# and kept in /var/lib/md-runbook-ops (a volume, or the Pod's own folder until it is replaced).
mounted=/etc/md-runbook-ops/hostkey/ssh_host_ed25519_key
if [ -r "$mounted" ]; then
  cp "$mounted" "$run/ssh_host_ed25519_key"
else
  if [ ! -s "$state/ssh_host_ed25519_key" ]; then
    ssh-keygen -q -t ed25519 -N '' -C md-runbook-ops -f "$state/ssh_host_ed25519_key"
    say "made a host key; a new container makes another, which the app reports as a changed key."
    say "To keep it, put your own key in /etc/md-runbook-ops/hostkey (README.md)."
  fi
  cp "$state/ssh_host_ed25519_key" "$run/ssh_host_ed25519_key"
fi
chmod 600 "$run/ssh_host_ed25519_key"
say "host key $(ssh-keygen -lf "$run/ssh_host_ed25519_key" | awk '{ print $2 }')"

# ---- kubeconfig ----
# A mounted kubeconfig (outside a cluster), else the Pod's service account (inside one). A
# copy, so `kubectl config use-context` works in a runbook.
mkdir -p "$HOME/.kube"
sa=/var/run/secrets/kubernetes.io/serviceaccount
if [ -r /etc/md-runbook-ops/kubeconfig/config ]; then
  cp /etc/md-runbook-ops/kubeconfig/config "$HOME/.kube/config"
  say "kubeconfig from /etc/md-runbook-ops/kubeconfig/config"
elif [ -r "$sa/token" ] && [ -n "${KUBERNETES_SERVICE_HOST:-}" ]; then
  # The token file is renewed by Kubernetes; kubectl reads it for each request.
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
- name: md-runbook-ops
  user:
    tokenFile: $sa/token
contexts:
- name: $cluster
  context:
    cluster: $cluster
    user: md-runbook-ops
    namespace: $(cat "$sa/namespace" 2>/dev/null || echo default)
current-context: $cluster
EOF
  say "kubeconfig for this cluster, context $cluster (the Pod's service account)"
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

# The gate's events (JSON, one per line) on this container's output, next to sshd's.
touch "$logdir/gate.log"
tail -n 0 -F "$logdir/gate.log" 2>/dev/null &

exec /usr/sbin/sshd -D -e -f /etc/ssh/md-runbook-ops.conf

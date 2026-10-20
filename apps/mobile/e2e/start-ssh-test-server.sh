#!/usr/bin/env bash
# The SSH server the device flows and the live Jest test run against: the repository's throwaway
# OpenSSH server on 127.0.0.1:2222 (scripts/ci/start-sshd.sh), plus the key server that puts the
# app's public key into its authorized_keys (e2e/key-server.mjs, 127.0.0.1:8077). Both keep
# running after this step; the test variables go to $GITHUB_ENV when it is set.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bash "$here/../../../scripts/ci/start-sshd.sh"
d="${RUNNER_TEMP:-/tmp}/sshd"
nohup node "$here/key-server.mjs" "$d/authorized_keys" 8077 >"$d/key-server.log" 2>&1 &
sleep 1
cat "$d/key-server.log"
if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "MD_RUNBOOK_SSH_TEST=127.0.0.1:2222:$(id -un)"
    echo "MD_RUNBOOK_SSH_HOST_PUB=$d/host_ecdsa.pub"
    echo "MD_RUNBOOK_SSH_AUTHORIZED_KEYS=$d/authorized_keys"
  } >>"$GITHUB_ENV"
fi

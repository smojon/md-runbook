#!/usr/bin/env bash
# Starts a throwaway OpenSSH server for the @md-runbook/ssh tests on 127.0.0.1:2222, as the
# current user, with its own host key: $RUNNER_TEMP/sshd/host_ecdsa.pub is the key to pin, and
# $RUNNER_TEMP/sshd/authorized_keys starts empty (the tests add the key they make). Linux and macOS.
set -euo pipefail
d="${RUNNER_TEMP:-/tmp}/sshd"
mkdir -p "$d"
cd "$d"
ssh-keygen -q -t ecdsa -b 256 -N '' -f host_ecdsa
: > authorized_keys
printf '%s\n' \
  "Port 2222" \
  "ListenAddress 127.0.0.1" \
  "HostKey $d/host_ecdsa" \
  "AuthorizedKeysFile $d/authorized_keys" \
  "PasswordAuthentication no" \
  "KbdInteractiveAuthentication no" \
  "UsePAM no" \
  "StrictModes no" \
  "PidFile $d/sshd.pid" > sshd_config
sshd_bin="$(command -v sshd || echo /usr/sbin/sshd)"
"$sshd_bin" -f "$d/sshd_config" -E "$d/sshd.log"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if nc -z 127.0.0.1 2222 2>/dev/null; then
    echo "sshd is listening on 127.0.0.1:2222"
    exit 0
  fi
  sleep 1
done
echo "sshd did not start:" >&2
cat "$d/sshd.log" >&2
exit 1

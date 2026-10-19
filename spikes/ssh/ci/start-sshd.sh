#!/usr/bin/env bash
# Starts a throwaway OpenSSH server for the spike on 127.0.0.1:2222, as the current user, with
# keys made here: $RUNNER_TEMP/sshd/{host_ecdsa,client_ecdsa}(.pub). Works on Linux and macOS.
set -euo pipefail
d="${RUNNER_TEMP:-/tmp}/sshd"
mkdir -p "$d"
cd "$d"
ssh-keygen -q -t ecdsa -b 256 -N '' -f host_ecdsa
# PKCS#8: the SSH library can't read OpenSSH's newer private key format (finding of step A).
ssh-keygen -q -t ecdsa -b 256 -m PKCS8 -N '' -f client_ecdsa
cp client_ecdsa.pub authorized_keys
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
sleep 1
nc -z 127.0.0.1 2222 && echo "sshd is listening on 127.0.0.1:2222"

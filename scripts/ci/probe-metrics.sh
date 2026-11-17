#!/usr/bin/env bash
# md-runbook-probe's example manifest in kind: wait until its sidecar serves the metrics we expect,
# through a port-forward, and leave them in ./metrics.prom and ./headers.txt.
#   probe-metrics.sh PATTERN...   (grep patterns; every one must match a line of the metrics)
# Why a wait and not a few tries:
#   - the rollout is done before busybox httpd listens (connection refused), and before the
#     probe's first round wrote /metrics/metrics.prom (404);
#   - the probe writes the file once a minute, so a first round that ran before kube-dns was ready
#     says 0 until the next one;
#   - kubectl port-forward exits after the Pod refused a connection ("lost connection to pod"):
#     it is started again.
# Up to WAIT_SECONDS (150: two rounds of the probe), a try every 2 s. On a timeout: the last
# status and body, the port-forward's log, the Pod and its containers' logs, then exit 1.
set -uo pipefail

[ "$#" -gt 0 ] || { echo "usage: probe-metrics.sh PATTERN..." >&2; exit 2; }
ns=${NS:-md-runbook-probe}
port=${PORT:-9100}
url="http://127.0.0.1:$port/metrics.prom"
pf_log=${RUNNER_TEMP:-/tmp}/probe-pf.log
wait_seconds=${WAIT_SECONDS:-150}
work=$(mktemp -d)

pf=
start_pf() {
  kubectl -n "$ns" port-forward service/md-runbook-probe "$port:9100" >>"$pf_log" 2>&1 &
  pf=$!
}
stop_pf() {
  if [ -n "$pf" ]; then kill "$pf" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap stop_pf EXIT

# The patterns that no line of metrics.prom matches, one per line.
missing() {
  local p
  for p in "$@"; do grep -q -- "$p" metrics.prom || printf '%s\n' "$p"; done
}

diagnostics() {
  echo "::error::no metrics as expected from $url within ${wait_seconds}s (last: $status)"
  echo "--- missing lines"
  printf '%s\n' "${lack:-(not checked: no HTTP 200)}"
  echo "--- last response headers"
  cat headers.txt 2>/dev/null || true
  echo "--- last response body (first 4 KiB)"
  head -c 4096 metrics.prom 2>/dev/null || true
  echo
  echo "--- port-forward log"
  cat "$pf_log" 2>/dev/null || true
  echo "--- pods"
  kubectl -n "$ns" get pods -o wide || true
  kubectl -n "$ns" describe pods || true
  echo "--- containers' logs"
  kubectl -n "$ns" logs deployment/md-runbook-probe --all-containers --prefix || true
}

start=$SECONDS
deadline=$((SECONDS + wait_seconds))
status='no try yet'
lack=
start_pf
while :; do
  if ! kill -0 "$pf" 2>/dev/null; then
    echo "port-forward exited; starting it again"
    start_pf
  fi
  rm -f headers.txt metrics.prom
  if code=$(curl -sS --noproxy '*' --max-time 5 -D headers.txt -o metrics.prom -w '%{http_code}' "$url" 2>"$work/curl.err"); then
    status="HTTP $code"
  else
    status="curl exit $? ($(tr -d '\n' <"$work/curl.err"))"
  fi
  if [ "$status" = 'HTTP 200' ]; then
    lack=$(missing "$@")
    if [ -z "$lack" ]; then
      echo "metrics as expected after $((SECONDS - start)) s"
      exit 0
    fi
    status="HTTP 200, $(printf '%s\n' "$lack" | wc -l) expected line(s) missing"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    diagnostics
    exit 1
  fi
  sleep 2
done

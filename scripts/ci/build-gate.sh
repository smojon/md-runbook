#!/bin/sh
# Builds md-runbook-gate (apps/gate) the way a release does: static (CGO_ENABLED=0), without
# file paths or a build ID (-trimpath, -buildid=), and only with the Go toolchain that go.mod
# names (GOTOOLCHAIN=local: no other one is downloaded). The same commit gives the same bytes.
# The ops image builds it the same way (apps/ops/Dockerfile).
#
#   sh scripts/ci/build-gate.sh OUT [GOOS GOARCH]     (default: this machine's)
set -eu
[ $# -eq 1 ] || [ $# -eq 3 ] || { echo "usage: build-gate.sh OUT [GOOS GOARCH]" >&2; exit 2; }
out=$1
case $out in /*) ;; *) out=$PWD/$out ;; esac
cd "$(dirname "$0")/../../apps/gate"
export GOTOOLCHAIN=local CGO_ENABLED=0
want=$(sed -n 's/^toolchain //p' go.mod)
have=$(go env GOVERSION)
if [ "$want" != "$have" ]; then
  echo "build-gate.sh: go.mod names toolchain ${want:-(none)}, this Go is $have" >&2
  exit 1
fi
if [ $# -eq 3 ]; then export GOOS="$2" GOARCH="$3"; fi
go build -trimpath -ldflags="-s -w -buildid=" -o "$out" ./cmd/md-runbook-gate

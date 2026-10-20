#!/usr/bin/env bash
# Boot an iPhone simulator, install the app, run the Maestro flows.
#
#   bash e2e/ios-run.sh <dir with the .app> <out-dir>
set -uo pipefail
app="$(ls -d "$1"/*.app | head -1)"
out="$(mkdir -p "$2" && cd "$2" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"

# The newest iOS runtime's first plain "iPhone NN".
udid="$(xcrun simctl list devices available -j | python3 -c '
import json, re, sys
devs = json.load(sys.stdin)["devices"]
def ver(rt):
    m = re.search(r"iOS-(\d+)-(\d+)", rt)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
for rt in sorted((r for r in devs if "iOS" in r), key=ver, reverse=True):
    phones = [d for d in devs[rt] if d["name"].startswith("iPhone")]
    plain = [d for d in phones if re.fullmatch(r"iPhone \d+", d["name"])]
    pick = (plain or phones or [None])[0]
    if pick:
        print(pick["udid"]); print(rt + " " + pick["name"], file=sys.stderr); break
')"
[ -n "$udid" ] || { echo "::error::no iPhone simulator available"; exit 1; }
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b
xcrun simctl install "$udid" "$app" || exit 1

xcrun simctl spawn "$udid" log stream --level info --predicate 'subsystem CONTAINS "dev.mdrunbook" OR process CONTAINS "mdrunbook"' >"$out/simulator.log" 2>&1 &
log_pid=$!

# Right after a fresh simulator's first boot (it can spend minutes migrating its data), Maestro's
# iOS driver sometimes doesn't start in time ("iOS driver not ready in time"), even with
# MAESTRO_DRIVER_STARTUP_TIMEOUT raised: then try once more, now that the simulator has settled.
# Only that error is retried; a failing flow fails the job.
run_flows() {
  # The SSH server for run-cell.yaml is the runner's own (e2e/start-ssh-test-server.sh); the
  # simulator shares the Mac's network.
  maestro --device "$udid" test --format junit --output "$out/maestro.xml" --test-output-dir "$out" \
    -e SSH_HOST=127.0.0.1 -e SSH_PORT=2222 -e SSH_USER="$(id -un)" -e KEY_URL=http://127.0.0.1:8077/authorize \
    "$here/maestro" 2>&1 |
    tee "$out/maestro-attempt-$1.log"
  return "${PIPESTATUS[0]}"
}
run_flows 1
status=$?
if [ "$status" != 0 ] && grep -q 'iOS driver not ready in time' "$out/maestro-attempt-1.log"; then
  echo "::warning::Maestro's iOS driver did not start in time; trying once more"
  sleep 20
  run_flows 2
  status=$?
fi

kill "$log_pid" >/dev/null 2>&1
gzip -f "$out/simulator.log"
exit "$status"

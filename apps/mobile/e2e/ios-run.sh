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

maestro --device "$udid" test --format junit --output "$out/maestro.xml" --test-output-dir "$out" "$here/maestro"
status=$?

kill "$log_pid" >/dev/null 2>&1
gzip -f "$out/simulator.log"
exit "$status"

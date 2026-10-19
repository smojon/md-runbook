#!/usr/bin/env bash
# Installs the step C app on an iPhone simulator, launches it, and waits for the result file the
# app writes over SSH onto this machine ($HOME/spike-c-result-ios.txt). Exit 0 only on PASSED.
set -uo pipefail
app="$1"
result="$HOME/spike-c-result-ios.txt"
rm -f "$result"

udid="$(xcrun simctl list devices available -j | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const all = Object.entries(JSON.parse(s).devices).filter(([r]) => r.includes("iOS")).flatMap(([, d]) => d);
  const phone = all.filter((d) => d.name.startsWith("iPhone")).pop();
  if (!phone) process.exit(1);
  console.log(phone.udid); console.error("simulator: " + phone.name);
});')"
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b
xcrun simctl install "$udid" "$app"
xcrun simctl spawn "$udid" log stream --level error --style compact > "$RUNNER_TEMP/ios-log.txt" 2>&1 &
logger=$!
xcrun simctl launch "$udid" dev.mdrunbook.spike

for i in $(seq 1 180); do
  if [ -f "$result" ] && grep -qE '^(PASSED|FAILED)$' "$result"; then break; fi
  sleep 1
done
kill "$logger" 2>/dev/null
echo "----- app output -----"
cat "$result" 2>/dev/null || echo "(no result file: the app did not finish connecting)"
echo "----- simulator errors (app) -----"
grep -iE 'spike|ReactNative|JavaScript|Exception' "$RUNNER_TEMP/ios-log.txt" | tail -40
grep -qx 'PASSED' "$result"

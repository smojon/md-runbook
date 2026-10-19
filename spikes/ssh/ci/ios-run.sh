#!/usr/bin/env bash
# Installs the step C app on an iPhone simulator, launches it, and waits for the log it writes to
# Documents/spike-result.txt in its data container. Exit 0 only if it printed PASSED.
set -uo pipefail
app="$1"

udid="$(xcrun simctl list devices available -j | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const all = Object.entries(JSON.parse(s).devices).filter(([r]) => r.includes("iOS")).flatMap(([, d]) => d);
  const phone = all.filter((d) => d.name.startsWith("iPhone")).pop();
  if (!phone) process.exit(1);
  console.log(phone.udid); console.error("simulator: " + phone.name);
});')"
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b > /dev/null
xcrun simctl install "$udid" "$app"
xcrun simctl spawn "$udid" log stream --level debug --style compact --predicate 'process == "mdrunbookspike"' > "$RUNNER_TEMP/ios-log.txt" 2>&1 &
logger=$!
xcrun simctl launch "$udid" dev.mdrunbook.spike
container="$(xcrun simctl get_app_container "$udid" dev.mdrunbook.spike data)"
result="$container/Documents/spike-result.txt"
echo "result file: $result"

for i in $(seq 1 180); do
  if [ -f "$result" ] && grep -qE '^(PASSED|FAILED|CRASHED)' "$result"; then break; fi
  sleep 1
done
kill "$logger" 2>/dev/null
echo "----- app output -----"
cat "$result" 2>/dev/null || echo "(no result file: the app's JavaScript did not get to its first line)"
echo "----- app log (errors and JavaScript) -----"
grep -iE 'error|exception|javascript|ReactNative|SPIKE' "$RUNNER_TEMP/ios-log.txt" | tail -40
grep -qx 'PASSED' "$result"

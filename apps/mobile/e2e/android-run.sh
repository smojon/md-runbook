#!/usr/bin/env bash
# Run by reactivecircus/android-emulator-runner once the emulator is up: install the APK, record
# logcat, run the Maestro flows.
#
#   bash e2e/android-run.sh <app-release.apk> <out-dir>
set -uo pipefail
apk="$1"
out="$(mkdir -p "$2" && cd "$2" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"

adb wait-for-device
adb shell getprop ro.build.version.release
adb install -r "$apk" || exit 1
adb logcat -c || true
adb logcat -v threadtime >"$out/logcat.txt" 2>&1 &
logcat_pid=$!

maestro test --format junit --output "$out/maestro.xml" --test-output-dir "$out" "$here/maestro"
status=$?

kill "$logcat_pid" >/dev/null 2>&1
grep -E 'ReactNativeJS|AndroidRuntime|FATAL|dev\.mdrunbook' "$out/logcat.txt" >"$out/logcat-app.txt" || true
gzip -f "$out/logcat.txt"
exit "$status"

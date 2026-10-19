#!/usr/bin/env bash
# Installs the step C APK on the running emulator, launches it and waits for its result in the
# device log (lines tagged SPIKE-C). Exit 0 only if it printed PASSED.
set -uo pipefail
apk="$1"
adb install -r "$apk"
adb logcat -c
adb shell am start -n dev.mdrunbook.spike/.MainActivity
for i in $(seq 1 120); do
  out="$(adb logcat -d | grep 'SPIKE-C' || true)"
  if echo "$out" | grep -qE 'SPIKE-C (PASSED|FAILED|CRASHED)'; then break; fi
  sleep 1
done
echo "----- app output -----"
adb logcat -d | grep -E 'SPIKE-C' | sed -E 's/.*SPIKE-C //'
echo "----- errors -----"
adb logcat -d '*:E' | grep -iE 'ReactNative|ReactNativeJS|AndroidRuntime|dev.mdrunbook' | tail -40
adb logcat -d | grep -q 'SPIKE-C PASSED'

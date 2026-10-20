#!/usr/bin/env bash
# Build the iOS Simulator app (Release, ad-hoc signed) the Maestro flows run against, from source.
# Expects `npm ci` done in apps/mobile.
#
#   bash e2e/build-ios.sh <out-dir>   -> <out-dir>/app/<name>.app, <out-dir>/xcodebuild.log
set -euo pipefail
out="$(mkdir -p "$1" && cd "$1" && pwd)"
cd "$(dirname "$0")/.."
npx expo prebuild --platform ios --no-install --clean
cd ios
# Pods download prebuilt binaries (Hermes from repo.reactnative.dev), which sometimes stall:
# try three times (the workflow also caches CocoaPods' downloads).
for attempt in 1 2 3; do
  pod install && break
  [ "$attempt" = 3 ] && exit 1
  echo "pod install failed (attempt $attempt); trying again in 20 s"
  sleep 20
done
ws="$(ls -d ./*.xcworkspace | head -1)"
scheme="$(basename "$ws" .xcworkspace)"
echo "workspace=$ws scheme=$scheme"
# Ad-hoc signed ("-", no Apple team needed on the simulator), not unsigned: the Keychain, where the
# app keeps its SSH key, refuses an app without an application identifier ("A required
# entitlement isn't present", expo-secure-store on an unsigned build).
xcodebuild -workspace "$ws" -scheme "$scheme" -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$out/dd" \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO ONLY_ACTIVE_ARCH=YES ARCHS=arm64 COMPILER_INDEX_STORE_ENABLE=NO \
  build >"$out/xcodebuild.log" 2>&1 || true
grep -q '\*\* BUILD SUCCEEDED \*\*' "$out/xcodebuild.log" || {
  echo "::error::xcodebuild failed; last errors:"
  grep -nE 'error:' "$out/xcodebuild.log" | tail -40
  tail -30 "$out/xcodebuild.log"
  exit 1
}
mkdir -p "$out/app"
cp -R "$(ls -d "$out"/dd/Build/Products/Release-iphonesimulator/*.app | head -1)" "$out/app/"
ls -la "$out/app"

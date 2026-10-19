#!/usr/bin/env bash
# Build the iOS Simulator app (Release, unsigned) the Maestro flows run against, from source.
# Expects `npm ci` done in apps/mobile.
#
#   bash e2e/build-ios.sh <out-dir>   -> <out-dir>/app/<name>.app, <out-dir>/xcodebuild.log
set -euo pipefail
out="$(mkdir -p "$1" && cd "$1" && pwd)"
cd "$(dirname "$0")/.."
npx expo prebuild --platform ios --no-install --clean
cd ios
pod install
ws="$(ls -d ./*.xcworkspace | head -1)"
scheme="$(basename "$ws" .xcworkspace)"
echo "workspace=$ws scheme=$scheme"
xcodebuild -workspace "$ws" -scheme "$scheme" -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$out/dd" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO ONLY_ACTIVE_ARCH=YES ARCHS=arm64 COMPILER_INDEX_STORE_ENABLE=NO \
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

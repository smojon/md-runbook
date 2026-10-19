#!/usr/bin/env bash
# Build the release APK the Maestro flows run against, from source (no EAS), x86_64 only (the
# emulator's ABI). Expects `npm ci` done in apps/mobile.
#
#   bash e2e/build-android.sh <out-dir>   -> <out-dir>/app-release.apk
set -euo pipefail
out="$(mkdir -p "$1" && cd "$1" && pwd)"
cd "$(dirname "$0")/.."
npx expo prebuild --platform android --no-install --clean
cd android
# Memory on a 16 GB runner (the other app's lesson: the template's JVM settings died of Metaspace
# OOM, and a large Gradle + Kotlin daemon next to Metro got the build killed).
cat >>gradle.properties <<'PROPS'

# CI (apps/mobile/e2e/build-android.sh)
org.gradle.jvmargs=-Xmx5g -XX:MaxMetaspaceSize=2g -Dfile.encoding=UTF-8
kotlin.compiler.execution.strategy=in-process
org.gradle.workers.max=3
PROPS
./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon -x lintVitalAnalyzeRelease
cp app/build/outputs/apk/release/app-release.apk "$out/app-release.apk"
ls -la "$out"

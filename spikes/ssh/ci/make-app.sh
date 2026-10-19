#!/usr/bin/env bash
# Builds the step C test app in $1 (default: app): a fresh Expo project with the spike's sources,
# the SSH library and the native modules it needs, and spike-config.json for the test server.
# Environment: SSH_USER, SSH_KEY_FILE, SSH_HOST_PUB, SSH_PORT.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
app="${1:-app}"

npx --yes create-expo-app@latest "$app" --template blank-typescript --no-install
cd "$app"
npm install --no-audit --no-fund --loglevel=error
npx expo install react-native-tcp-socket react-native-quick-crypto react-native-nitro-modules
npm install --no-audit --no-fund --loglevel=error \
  @microsoft/dev-tunnels-ssh@3.12.42 @microsoft/dev-tunnels-ssh-keys@3.12.42 \
  buffer@^6.0.3 readable-stream@^4.5.2 events@^3.3.0 util@^0.12.5 process@^0.11.10

mkdir -p src
cp "$here/src/remoteShell.ts" src/
cp "$here/app-src/tcpStream.ts" "$here/app-src/empty.js" src/
cp "$here/app-src/App.tsx" "$here/app-src/metro.config.js" .

# A package id for both platforms, and the test server's address as each one sees it.
node -e '
const fs = require("fs");
const a = JSON.parse(fs.readFileSync("app.json", "utf8"));
a.expo.name = "md-runbook spike"; a.expo.slug = "md-runbook-spike";
a.expo.android = { ...(a.expo.android || {}), package: "dev.mdrunbook.spike" };
a.expo.ios = { ...(a.expo.ios || {}), bundleIdentifier: "dev.mdrunbook.spike" };
fs.writeFileSync("app.json", JSON.stringify(a, null, 2));
fs.writeFileSync("spike-config.json", JSON.stringify({
  host: "127.0.0.1",          // iOS simulator: the Mac itself
  androidHost: "10.0.2.2",    // Android emulator: the host machine
  port: Number(process.env.SSH_PORT || 2222),
  user: process.env.SSH_USER,
  keyPem: fs.readFileSync(process.env.SSH_KEY_FILE, "utf8"),
  hostPub: fs.readFileSync(process.env.SSH_HOST_PUB, "utf8"),
}, null, 2));
'
echo "app ready in $(pwd)"

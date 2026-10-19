# Spike: runbook cells over SSH on iOS, Android and the web

**Question:** can one TypeScript code base run runbook cells on a remote host over SSH from a
phone app (iOS, Android) and a web app, using a pure-TypeScript SSH client
([`@microsoft/dev-tunnels-ssh`](https://github.com/microsoft/dev-tunnels-ssh)) in an Expo
(React Native) app, with a self-hosted relay for browsers?

Everything here runs on GitHub's runners against a throwaway OpenSSH server
(`ci/start-sshd.sh`): workflows `Spike SSH` (steps A, B) and `Spike SSH app` (step C).

## What runs a cell

`src/remoteShell.ts` (one file, used unchanged by all targets):

1. **Connect** over any byte stream: a TCP socket (Node, phones) or a WebSocket to the relay
   (browser).
2. **Check the host key** against a pinned key *before* any credential is sent; a mismatch
   ends the connection.
3. **Authenticate** with an ECDSA P-256 key.
4. **Open one shell** and keep it: `cd`, variables and logins carry over between cells (the
   extension's session mode, remotely).
5. **Run a cell**: its text goes in as a quoted here-doc with a random terminator (so nothing in
   the cell can end it early), into a temp file the shell sources; the same end-of-cell markers
   as the extension's session mode give the exit code, on stdout and stderr separately.

## Results

| Step | Target | Result | Connect + auth | Per-cell overhead |
|---|---|---|---|---|
| A | Node 22 → OpenSSH (Linux) | ✅ passed | 137 ms | ~3 ms (20 empty cells: 57 ms) |
| B | Headless Chrome 155 → relay → OpenSSH | ✅ passed | 193 ms | — |
| C | Android 14 emulator, React Native release build | ✅ passed | 238 ms | ~8 ms (10 empty cells: 80 ms) |
| C | iPhone simulator, React Native release build | IOS_RESULT | | |

Step A also checked: a wrong pinned host key is refused; stdout and stderr stay apart; non-zero
exit codes; quotes, a here-doc and a fake terminator inside a cell; output streaming while a cell
runs; 20,000 lines of output.

## Findings

- **Algorithms:** the library supports ECDSA (P-256/384/521) and RSA keys, ECDH (NIST curves)
  and DH group 14/16, AES-256-GCM/CTR. **No Ed25519** and no curve25519/ChaCha20. Default
  OpenSSH servers accept these, so it works with standard servers; users with Ed25519-only keys
  need the app's own key. That fits: **P-256 is what the iPhone Secure Enclave and the Android
  Keystore hold**, so the app's key can live in hardware.
- **Key files:** the library can't read OpenSSH's newer private key format (`BEGIN OPENSSH
  PRIVATE KEY`, "Failed to decrypt key" even unencrypted); PKCS#8 works. Importing keys users
  already have needs a converter, or the app generates its own (preferred).
- **Browser:** works with the browser's own Web Crypto. Its dependency `vscode-jsonrpc` v4 loads
  Node modules at startup, so the web bundle needs empty stand-ins for `path/os/net/fs/crypto`,
  browser ports of `stream/events/util`, and injected `Buffer` and `process` (`build.js`).
- **React Native:** the library takes its *Node* crypto path there, which
  `react-native-quick-crypto` provides natively (OpenSSL); `react-native-tcp-socket` gives the
  TCP connection. Metro needs the same module aliases (`app-src/metro.config.js`) and the
  polyfills must load before anything else (`app-src/polyfills.ts`, imported first by
  `index.ts`).
- **Relay** (`src/relay.ts`): allowlisted targets, a token in the WebSocket subprotocol (not
  the URL), a connection cap, connection logging without data. SSH ends in the browser, so the
  relay only sees ciphertext; it does see who connects to which host, and when.
- **Builds:** Expo SDK 58 prebuild + Gradle builds the Android release APK with both native
  modules on a standard runner; iOS builds with CocoaPods + Xcode on `macos-latest`
  (quick-crypto downloads a static OpenSSL).

## Recommendation

RECOMMENDATION

## Not covered by the spike

- Real devices, store builds and signing (needs the Apple and Google developer accounts).
- Hardware-backed keys (Secure Enclave / Keystore signing through the library's key provider
  hook), host-key trust UI, jump hosts, reconnects after the phone sleeps or changes network.
- Performance on slow mobile networks, large outputs on phones, battery.
- The shared `packages/core` extraction (parser, writer, checks, redaction, report) and the
  runaway-regex guard, which uses Node's `vm` and needs a replacement on React Native.

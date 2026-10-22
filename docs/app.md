# The md-runbook app

The app runs runbooks on your servers over SSH from an iPhone, an Android phone or a browser.
It reads and writes the same Markdown files as the VS Code extension, with the same output
blocks, so a runbook can move between the two.

It is not in the App Store or Google Play yet. To try it, see [Try it](#try-it) below.

The screenshots come from the app's CI run: an iPhone simulator, an Android emulator and
Chromium, against a throwaway SSH server.

## A runbook

<img src="app/ios-runbook.png" width="320" alt="A runbook on an iPhone: rendered Markdown, a ticked task, a bash cell with its saved output, a second cell">

Runbooks look like a VS Code notebook. Markdown is rendered, and task boxes can be ticked; the
tick is written to the file. Code cells have syntax colours, their saved output and a ✓ or ✗
for the last run. The line under each cell shows its language and options. The app follows the
phone's light or dark setting, with VS Code's default colours.

## Hosts and the app's key

<img src="app/ios-hosts.png" width="320" alt="The Hosts screen: one host, and the app's public SSH key with a Copy button">

You add each server once: a name, its address and the user to log in as. The app makes its own
SSH key on first use. On phones the private key is made inside the secure hardware (the Secure
Enclave on iPhones, Android Keystore) and can't be read out, not even by the app. You copy the
public key into `~/.ssh/authorized_keys` on each server. The app never asks for a password or a
private key file.

## Trusting a server

<img src="app/android-trust.png" width="320" alt="On Android: First connection to ci, with the server's SHA256 fingerprint and Trust and run">

On the first connection the app shows the server's fingerprint and waits until you trust it.
Nothing is sent before that. If a trusted server later shows a different key, the app stops and
says so.

## Running cells and lines

<img src="app/ios-line-run.png" width="320" alt="A cell after a line run: Output · exit 0 · lines 1, with the command echoed">

The ▷ beside a cell runs it in a shell on the selected host; the shell stays open between
cells, as in the extension's session mode. Tapping a line opens its actions:

- **Run line**, **Run lines 1-N** and **Run lines N-end**.
- **Step from here**, or **Step through** for the whole cell. A command runs, then the app waits
  before the next one, with **Run next** and **Continue**.
- **Check**, to mark lines and run only those.

The output block records which lines ran (`lines=`), as the extension writes it. A cell with
`host=NAME` always runs on that host, whichever one is selected.

<img src="app/web-line-actions-dark.png" width="720" alt="The web app in dark mode: a code line tapped, with Run line 2, Run lines 1-2 and Check under it">

## In a browser, through the relay

<img src="app/web-relay-run.png" width="720" alt="The web app after a line ran over SSH through the relay">

A browser can't open SSH connections, so the web app goes through a small relay you run
yourself ([apps/relay](../apps/relay/README.md)). SSH still runs in the browser: the relay only
sees encrypted traffic, and it only connects to the servers on its list.

## Parameters, secrets and inputs

As in the extension, a value never becomes part of the script: `${param:NAME}`,
`${secret:NAME}` and `${input:NAME}` run as `${NAME}` and the value is passed in the
environment.

- **Parameters:** a runbook whose cells use `${param:NAME}` shows a **Parameters** card, one
  field per parameter with the front matter's default as placeholder. The values are
  remembered per runbook.
- **Secrets:** the first time a cell needs `${secret:NAME}`, the app asks for it (masked) and
  stores it in the phone's Keychain or Keystore (in the browser: the app's local storage, like
  its key), for every runbook. **Hosts → Secrets** lists the stored names and forgets them.
- **Inputs:** `${input:NAME}` is asked for the first time a cell needs it and kept while the
  runbook is open. Names ending in `_PASSWORD`, `_TOKEN` or `_SECRET`, and
  `${input:NAME:secret}`, are masked.
- Secret values are redacted from the live output and from the saved output block.
- `${out:NAME}` (a value captured by an earlier cell) is not supported in the app yet; such a
  cell says so instead of running.

## Signed runbooks

A runbook signed with **Sign Runbook** or `md-runbook sign` shows who signed which version, and
any blocks changed since. On a server whose key is restricted to md-runbook-gate, the app runs
the signed blocks by their number in the signed manifest, and the gate refuses anything else;
the app finds the gate by itself. See [signed runbooks](features/signed-runbooks.md).

## Saving

<img src="app/web-saved.png" width="720" alt="A runbook opened from a file, with Saved and Save to the file">

The app keeps every runbook you open, with its outputs, until you remove it. A runbook opened
from a file stays linked to it, and **Save to the file** writes it back. That works on Android,
on iOS, and in Chrome and Edge; other browsers download the file instead. If the file changed
elsewhere since it was opened, the app asks whether to overwrite it or load that version.

## Try it

- **Web:** `cd apps/mobile && npm ci && npx expo start --web`. To run cells, also start the relay
  ([its README](../apps/relay/README.md)) and set its address and token under **Hosts**.
- **Android or iOS:** `npx expo run:android` or `npx expo run:ios` in `apps/mobile` builds the
  app for an emulator or a connected device. The phone builds need the Android SDK or Xcode.
- **Store builds:** not published yet. The steps are in [apps/mobile/STORE.md](../apps/mobile/STORE.md).

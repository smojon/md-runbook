# Handoff

State of the project for whoever picks it up next (person or new Claude session).

## Where things are

- **Released:** a tag `vX.Y.Z` runs the Release workflow (steps in
  [PUBLISHING.md](../PUBLISHING.md)).
  - It publishes to npm, Open VSX and the Visual Studio Marketplace (publisher `smojon`).
  - The Release workflow also makes a GitHub release marked Latest, with the `.vsix` and the
    CLI `.tgz`.
  - The GitHub Action is used as `smojon/md-runbook@v<version>` (the release tags).
- **Branch:** everything is on `main`, which is the default branch. Work happens on short-lived
  `feature/...` branches; CI must pass on all three systems before they are merged.
- **Code:**
  - `packages/core` (`@md-runbook/core`, an npm workspace) is the shared core. Its `src/` is
    platform-neutral (no `vscode`, no Node modules; `test/purity.test.ts` checks it); `src/node/`
    runs local processes.
  - `src/*.ts` is the VS Code layer, `src/cli` the command-line runner, `renderer/` the notebook
    renderer for clickable checklists.
  - Feature docs: `docs/features/*.md`.
  - Store and release steps: `PUBLISHING.md`.
  - GitHub Action: `action.yml` + `scripts/action-run.js`.
- **SSH and the app:**
  - `packages/ssh` (`@md-runbook/ssh`) runs cells in a remote shell over SSH in pure TypeScript
    (its README). Live tests run against an OpenSSH server CI starts (`scripts/ci/start-sshd.sh`).
  - `apps/mobile` is the Expo app (iOS, Android, web), a separate npm project using the packages
    from their sources. `.github/workflows/app.yml` runs its gates and the web build in Chromium.
    It also runs the release builds on an Android emulator and an iPhone simulator, with the
    Maestro flows in `apps/mobile/e2e/maestro`.
  - Locally: `cd apps/mobile && npm ci && npm run check`.
  - After a UI change, `npm run export:web && npm run ui-tour` takes screenshots into `ui-tour/`;
    look through them. They show every screen and sheet at phone size, light and dark. They use
    a seeded runbook: outputs, a cloud view, a Windows host, a proposal, a signed runbook.
  - The spike that chose this stack: `spikes/ssh/README.md`.
  - What it does, with screenshots: [app.md](app.md). The images in `docs/app/` come from an App
    workflow run's artifacts; refresh them from a newer run when screens change.
  - The app draws runbooks like VS Code's notebook, with native components. Markdown comes from
    the core's `renderMarkdown` HTML (`src/markdown/`); code cells have line actions and step
    through (`src/cells/`). It remembers runbooks, saves them back to their file
    (`src/runbooks/`) and honours `host=` cells.
  - The app's own native code is in `apps/mobile/modules/`, compiled only by the Android and iOS
    jobs of the App workflow:
    - `hardware-key`: the SSH key in the Secure Enclave or Android Keystore; the SSH layer signs
      through `ExternalKeyPair`;
    - `document-access` (iOS): open a file in place, keep a bookmark.
- **Expo patch releases:** `.github/workflows/expo-updates.yml` checks daily (05:23 UTC, or
  Actions → Expo updates → Run workflow). It opens or updates one pull request, from the branch
  `expo-updates`, with releases at least 7 days old. Merge it when green.
  - The script is `apps/mobile/e2e/expo-updates.mjs`: it installs with `npm install --before`,
    and `pin-exact.mjs` keeps the exact pins. The 7 days follow the supply-chain rule of
    anotherMoney's `minimumReleaseAge`.
  - The App and CI workflows are started on the pull request. The run's summary lists what is
    held and from when.
  - On pushes and pull requests, the App workflow's `check-deps.mjs` fails only on a minor or
    major mismatch. There, `expo-doctor` skips its version check, which answered differently each
    time Expo published a patch.
  - Needs Settings → Actions → General → *Allow GitHub Actions to create and approve pull
    requests* (on since 2026-10-29).
  - An update can also need an advisory taken off `e2e/audit.mjs`.
- **Relay:** `apps/relay` lets the web app reach SSH servers (WebSocket to TCP, protocol v1,
  allowlist and tokens; its README). It is a separate npm project with a Dockerfile. Its README
  has the steps for a free Oracle Cloud VM.
  - Tests: the Relay workflow tests it and probes the container; the App workflow runs a cell
    from Chromium through it.
- **Signed runbooks:**
  - `packages/core/src/signing.ts`: manifest, signature block, which cells are signed;
    platform-neutral.
  - `packages/core/src/node/sign.ts`: ssh-keygen sign/verify.
  - `src/cli/sign.ts`: `md-runbook sign|verify`.
  - `src/signing.ts`: Sign Runbook.
  - `apps/gate`: the server side, a Go module (`cmd/md-runbook-gate`).
    - `scripts/ci/build-gate.sh` builds it as releases do. The Release workflow attaches
      `md-runbook-gate-<os>-<arch>` and `SHA256SUMS`; the ops image builds it from source.
  - The gate client in `packages/ssh`: `RemoteSession.run(…, signed)`.
  - Tests: `test/signing.test.ts`, `test/gate.test.ts` (the binary in `MD_RUNBOOK_GATE_BIN`,
    default `apps/gate/dist/md-runbook-gate`, with real signatures), `test/cliSign.test.ts`, the
    gate section of `test/ssh.live.test.ts` (through CI's sshd), and `go test` in `apps/gate`.
  - Design and limits: `docs/features/signed-runbooks.md`.
- **Web app hosting:** `.github/workflows/pages.yml` deploys the web build to GitHub Pages after
  a green App run on main. It does nothing until the repository variable `WEB_APP_ORIGIN` is set.
  - It refuses to deploy unless Pages serves exactly that origin. The reason: the app keeps its
    relay token and other secrets in the origin's localStorage. `smojon.github.io` is shared with the account's other
    Pages sites.
- **Examples:**
  - `examples/sample.runbook.md`: the hand test drive, opened by **Open Sample Runbook**;
    sections 1–17 cover every feature.
  - `examples/ci.runbook.md`: run by CI through the action.
  - `examples/screenshots.runbook.md`: for `docs/screenshots.md`.
  - Workflow templates in `examples/github/`.
- **Security rule for every feature:**
  - it can be turned off in settings;
  - the default is the most secure choice;
  - settings that weaken security are `"scope": "machine"` (user settings only).

  A runbook file must never be able to weaken them either (e.g. no shell paths in front matter).

## Run the tests

```sh
npm ci
npm test                                   # compile + unit/smoke tests (~475; real shells, skipped if missing)
MD_RUNBOOK_PWSH=/path/to/pwsh npm test     # also the PowerShell 7 tests (value is a path)
npm run test:integration                   # ~70 end-to-end tests in a downloaded VS Code (xvfb-run on Linux)
```

CI (`.github/workflows/ci.yml`) runs both on Windows, macOS and Linux on every branch push and pull request. It
also runs:

- the CLI on `examples/ci.runbook.md` (through the action);
- `scripts/check-sample.js`, which checks that `examples/sample.runbook.md` still does what its
  text says. When you change the sample, update the expectations in that script.

The integration run starts a second VS Code and slows the machine for about 5 minutes. On a
laptop in use, prefer pushing a branch and letting CI run it. From a VS Code terminal, run it as
`env -u ELECTRON_RUN_AS_NODE npm run test:integration`.

Behaviour inside the notebook webview has no automated test. Try it in a development window
(`code --extensionDevelopmentPath=<repo> <file.md>`) before a release:

- checkbox clicks and redraws;
- the step-through highlight;
- cell toolbar buttons;
- the walkthrough's look.

## Releasing

1. Bump `version` in `package.json`, turn `## Unreleased` in `CHANGELOG.md` into `## x.y.z`
   (that section becomes the GitHub release notes), commit to `main`.
2. `git tag vx.y.z && git push origin vx.y.z`. The Release workflow tests on all three systems,
   packages the `.vsix` and creates the GitHub (pre-)release.
3. **Marketplace: manual.** Download the `.vsix` from the GitHub release and upload it at
   <https://marketplace.visualstudio.com/manage/publishers/smojon> (⋯ → Update). There is no
   `VSCE_PAT` secret: creating an Azure DevOps organization for a token now needs an Azure
   subscription. If one is added later, the workflow publishes by itself.

## Open (owner)

- **VS Code issue about slow notebook opens:** filed on 2026-10-20 as
  [microsoft/vscode#342813](https://github.com/microsoft/vscode/issues/342813). It comes with a
  tested one-line fix: `opacity: 0; pointer-events: none` instead of `visibility: hidden` during
  the warmup.
  - #342813 was closed as not planned. The follow-up
    [#347729](https://github.com/microsoft/vscode/issues/347729) is open.
  - [PR #347939](https://github.com/microsoft/vscode/pull/347939), by another author, carries a
    fix and our before/after timings. It waits for a maintainer review (2026-11-16).
  - Background, measurements and the Chromium mechanism:
    [investigations/notebook-open-slow.md](investigations/notebook-open-slow.md).
  - Optional A/B left: the flag plus `--disable-background-timer-throttling`. The aim: see
    whether timer throttling of hidden frames explains the residual ~1 s with the flag alone.
- **Web app domain:** pick one (a free js.org, is-a.dev or eu.org name, or a ~$10 domain). Set it
  as the Pages custom domain and as the repository variable `WEB_APP_ORIGIN`; `pages.yml` then
  deploys.
  - The relay needs a server too: the Oracle Cloud Always Free steps in `apps/relay/README.md`.
    The sign-up asks for the owner's card.
- **Not tried by hand yet** (CI covers them, a person hasn't):
  - the app on a real phone: the native menu, the share sheet, the hardware key;
  - a real Claude request from the app's assistant.
- **Toolbar:** 0.9.0 shipped the Run, Values, Assistant, Share and Help buttons blank. The reason:
  VS Code draws an extension's submenu in the notebook toolbar as a bare icon. So they are
  commands that open lists (`src/toolbarButtons.ts`).
  - Checked in a development window (2026-10-22). Menus test only package.json; look at the
    toolbar itself after changing it.
- **npm:** the command line is published as `md-runbook` from 0.19.2 on, by trusted publishing
  (no npm token; `PUBLISHING.md` → npm).
- **Screenshots:** the shot list and a demo runbook are ready in `docs/screenshots.md`.
- **App store builds:** `apps/mobile/eas.json` is ready. `apps/mobile/STORE.md` has the steps
  that need the owner's Expo, Apple and Google accounts, and the encryption export question.
  Nothing has been built for the stores yet.

## Known gaps (small, documented or deliberate)

- Session mode, PowerShell: native commands that read stdin wait for input; use `$null | cmd`
  (documented in `docs/features/session.md`).
- Secret values seen in a run are kept for redaction until VS Code restarts (not cleared when the
  notebook closes).
- With `safety.recordContext` on, a cell's secret prompts come before its confirmation
  (documented in `docs/features/safety.md`).
- Line runs (documented in `docs/features/lines.md` and `checks.md`):
  - cmd cells run each line in its own process (no state between lines), as do `shell: sh` cells
    in terminal mode;
  - checks, retries and captures don't apply to line runs.
- Checklist boxes don't show in Restricted Mode: VS Code's sanitizer drops `<input>`.
- Terminal mode is tested through the integration suite; it has not been tried by hand on
  macOS.
- Two terminal integration tests failed now and then on Linux CI (2026-10-19, 10-21, 11-05).
  Fixed 2026-11-06.
  - The tests: "answers an interactive prompt" and "a line run keeps cd".
  - Under CPU load, VS Code sometimes didn't match the started command to our `executeCommand`,
    since it compares the command-line text. It then made another execution that got the output
    and the end report, while ours got nothing.
  - Terminal mode now also reads the first execution that starts in its terminal
    (`src/terminal.ts`).
  - The evidence: on Ubuntu with every core kept busy, main lost the output in about 45% of
    jobs. The fix lost it in 0 of 10.
  - To chase such a test again: `MD_RUNBOOK_ITEST_ONLY` (a regex on test names) and
    `MD_RUNBOOK_ITEST_REPEAT` pick and repeat integration tests (`test/integration/index.ts`).
    Busy loops (`while :; do :; done &`, one per core) make it show.
  - On a timeout, the prompt test prints the cell's output and whether shell integration
    started. It also prints what runs under the terminal's shell.
- The app's iOS flow once failed with `Element not found: host-name` after tapping Add host;
  a rerun passed.
- The controller's try/finally cleanup has no unit test (it needs VS Code).
- **Opening a runbook sometimes hangs inside VS Code on macOS CI runners** (investigated
  2026-10-19).
  - The editor shows in ~100 ms, but `vscode.openWith` takes 5–20 s or never settles. A cell in
    such an editor may never run.
  - Measured with the open probe (`test/integration/probe.ts`, printed for every slow open):
    - the extension host is idle: no event-loop stalls, ~1 ms of our own parse/lint work;
    - the window answers within ~100 ms;
    - neither `--disable-gpu` nor `chat.disableAIFeatures` changes it.
  - VS Code logs nothing about it. It depends on the runner machine: from 0 to 8 slow opens per
    run in the same hour.
  - The tests close the editors and reopen, up to 3 times. To look again: Actions → **macOS open
    probe** → Run workflow (three Macs, optional VS Code arguments and settings).
  - **Update 2026-10-20:** reproduced on Windows under CPU load and explained:
    - VS Code shows no cell until the notebook's hidden webview has loaded the Markdown
      renderers;
    - the webview's process runs at Idle priority while hidden.
  - `--disable-renderer-backgrounding` removes the wait (0-1.6 s instead of 8-64 s, alternating
    pairs). Details, measurements and the VS Code issue draft:
    [investigations/notebook-open-slow.md](investigations/notebook-open-slow.md).
  - Since 2026-10-20 the integration tests start VS Code with that flag
    (`test/integration/runElectron.ts`). So CI no longer sees these hangs, by design.
    `MD_RUNBOOK_VSCODE_KEEP_BACKGROUNDING=1` leaves the flag out.
  - The retry and the probe stay in place and will show any slow open that remains. To observe
    VS Code's own behaviour: the macOS open probe workflow with `keep_backgrounding` or `ab`.

## Ideas for later

3. App translations: the texts are in `apps/mobile/src/i18n.ts`, English only; which languages
   is the owner's choice.

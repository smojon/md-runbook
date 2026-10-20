# Handoff

State of the project for whoever picks it up next (person or new Claude session).

## Where things are

- **Released:** 0.1.0 to 0.3.0 as GitHub releases with the `.vsix` attached; the Visual Studio
  Marketplace (publisher `smojon`) gets each one by a manual upload. Not on Open VSX or npm yet.
  The GitHub Action is used as `smojon/md-runbook@v<version>` (the release tags).
- **Branch:** everything is on `main`, which is the default branch. Work happens on short-lived
  `feature/...` branches; CI must pass on all three systems before they are merged.
- **Code:** `packages/core` (`@md-runbook/core`, an npm workspace) is the shared core: its
  `src/` is platform-neutral (no `vscode`, no Node modules; `test/purity.test.ts` checks it) and
  `src/node/` runs local processes. `src/*.ts` is the VS Code layer, `src/cli` the command-line runner, `renderer/` the notebook renderer for
  clickable checklists. Feature docs: `docs/features/*.md`. Store and release steps:
  `PUBLISHING.md`. GitHub Action: `action.yml` + `scripts/action-run.js`.
- **SSH and the app:** `packages/ssh` (`@md-runbook/ssh`) runs cells in a remote shell over SSH
  in pure TypeScript (its README); live tests run against an OpenSSH server CI starts
  (`scripts/ci/start-sshd.sh`). `apps/mobile` is the Expo app (iOS, Android, web), a separate
  npm project using the packages from their sources; `.github/workflows/app.yml` runs its gates,
  the web build in Chromium and the release builds on an Android emulator and an iPhone
  simulator with the Maestro flows in `apps/mobile/e2e/maestro`. Locally: `cd apps/mobile &&
  npm ci && npm run check`. The spike that chose this stack: `spikes/ssh/README.md`.
- **Examples:** `examples/sample.runbook.md` (the hand test drive, opened by **Open Sample
  Runbook**; sections 1–17 cover every feature), `examples/ci.runbook.md` (run by CI through the
  action), `examples/screenshots.runbook.md` (for `docs/screenshots.md`), and workflow templates
  in `examples/github/`.
- **Security rule for every feature:** it can be turned off in settings, the default is the most
  secure choice, and settings that weaken security are `"scope": "machine"` (user settings only).
  A runbook file must never be able to weaken them either (e.g. no shell paths in front matter).

## Run the tests

```sh
npm ci
npm test                                   # compile + unit/smoke tests (~475; real shells, skipped if missing)
MD_RUNBOOK_PWSH=/path/to/pwsh npm test     # also the PowerShell 7 tests (value is a path)
npm run test:integration                   # ~70 end-to-end tests in a downloaded VS Code (xvfb-run on Linux)
```

CI (`.github/workflows/ci.yml`) runs both on Windows, macOS and Linux on every branch push,
plus the CLI on `examples/ci.runbook.md` (through the action) and `scripts/check-sample.js`,
which checks that `examples/sample.runbook.md` still does what its text says. When you change
the sample, update the expectations in that script.
The integration run starts a second VS Code and slows the machine for about 5 minutes; on a
laptop in use, prefer pushing a branch and letting CI run it. From a VS Code terminal, run it as
`env -u ELECTRON_RUN_AS_NODE npm run test:integration`.

Behaviour inside the notebook webview (checkbox clicks, redraws, the step-through highlight, cell
toolbar buttons, the walkthrough's look) has no automated test: try it in a development window
(`code --extensionDevelopmentPath=<repo> <file.md>`) before a release.

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

- **VS Code issue about slow notebook opens:** review the draft in
  [investigations/notebook-open-slow.md](investigations/notebook-open-slow.md) (section "Issue
  draft", with a tested one-line fix), then file it on microsoft/vscode. No existing issue was found.
  The draft now explains the Chromium mechanism (read from source on 2026-10-20: hidden
  cross-origin iframe → child widget hidden → process `kBestEffort` → `IDLE_PRIORITY_CLASS` plus
  EcoQoS) and the fix should be `opacity: 0; pointer-events: none` (a transparent webview cannot
  flash, but it would take clicks). Nothing elegant exists on the extension side: the warmup is
  unconditional, no setting skips it, `argv.json` cannot carry the flag; the only lever (raising
  the webview process's priority from the extension host, Windows only) is documented and not
  recommended. Optional A/B left: the flag plus `--disable-background-timer-throttling`, to see
  whether timer throttling of hidden frames explains the residual ~1 s with the flag alone.
- **Open VSX** (VSCodium, Cursor, Gitpod): create the namespace `smojon`, file the ownership
  claim, then add an `OVSX_PAT` secret or set up trusted publishing (`PUBLISHING.md`).
- **npm token:** add the `NPM_TOKEN` secret (`PUBLISHING.md` → npm); the next release then
  publishes the command line as `md-runbook` on npm. Until then: the GitHub Action, or
  `node out/dist/cli.js` from a clone.
- **Screenshots:** the shot list and a demo runbook are ready in `docs/screenshots.md`.

## Known gaps (small, documented or deliberate)

- Session mode, PowerShell: native commands that read stdin wait for input; use `$null | cmd`
  (documented in `docs/features/session.md`).
- Secret values seen in a run are kept for redaction until VS Code restarts (not cleared when the
  notebook closes).
- With `safety.recordContext` on, a cell's secret prompts come before its confirmation
  (documented in `docs/features/safety.md`).
- Line runs: cmd cells run each line in its own process (no state between lines); checks,
  retries and captures don't apply to line runs (documented in `docs/features/lines.md` and
  `checks.md`).
- Checklist boxes don't show in Restricted Mode: VS Code's sanitizer drops `<input>`.
- Terminal mode is tested through the integration suite; it has not been tried by hand on
  macOS.
- The integration test "terminal: a line run keeps cd between lines…" hung once on Linux CI
  (2026-10-19). Likely cause: shell integration lost the end report of a command. Terminal mode
  now also ends a command a few seconds after its exit-code file appears; on a timeout the test
  prints the cell's output and the open terminals.
- The controller's try/finally cleanup has no unit test (it needs VS Code).
- **Opening a runbook sometimes hangs inside VS Code on macOS CI runners** (investigated
  2026-10-19). The editor shows in ~100 ms, but `vscode.openWith` takes 5–20 s or never settles,
  and a cell in such an editor may never run. Measured with the open probe
  (`test/integration/probe.ts`, printed for every slow open): the extension host is idle (no
  event-loop stalls, ~1 ms of our own parse/lint work), the window answers within ~100 ms, and
  neither `--disable-gpu` nor `chat.disableAIFeatures` changes it. VS Code logs nothing about it.
  It depends on the runner machine: from 0 to 8 slow opens per run in the same hour. The tests
  close the editors and reopen, up to 3 times. To look again: Actions → **macOS open probe** →
  Run workflow (three Macs, optional VS Code arguments and settings).
  **Update 2026-10-20:** reproduced on Windows under CPU load and explained: VS Code shows no cell
  until the notebook's hidden webview has loaded the Markdown renderers, and that webview's
  process runs at Idle priority while hidden. `--disable-renderer-backgrounding` removes the wait
  (0-1.6 s instead of 8-64 s, alternating pairs). Details, measurements and the VS Code issue
  draft: [investigations/notebook-open-slow.md](investigations/notebook-open-slow.md).
  Since 2026-10-20 the integration tests start VS Code with that flag
  (`test/integration/runElectron.ts`; `MD_RUNBOOK_VSCODE_KEEP_BACKGROUNDING=1` leaves it out), so
  CI no longer sees these hangs by design; the retry and the probe stay in place and will show
  any slow open that remains. To observe VS Code's own behaviour: the macOS open probe workflow
  with "keep_backgrounding" or "ab".

## Ideas for later

1. Shell choice per runbook, only with a safe design (e.g. picking among installed shells, never
   a path from the file).

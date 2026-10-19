# Handoff

State of the project for whoever picks it up next (person or new Claude session).

## Where things are

- **Released:** 0.1.0 to 0.3.0 as GitHub releases with the `.vsix` attached; the Visual Studio
  Marketplace (publisher `smojon`) gets each one by a manual upload. Not on Open VSX or npm yet.
  The GitHub Action is used as `smojon/md-runbook@v<version>` (the release tags).
- **Branch:** everything is on `main`, which is the default branch. Work happens on short-lived
  `feature/...` branches; CI must pass on all three systems before they are merged.
- **Code:** `src/core` is pure (no `vscode`; `test/purity.test.ts` checks it), `src/*.ts` is the
  VS Code layer, `src/cli` the command-line runner, `renderer/` the notebook renderer for
  clickable checklists. Feature docs: `docs/features/*.md`. Store and release steps:
  `PUBLISHING.md`. GitHub Action: `action.yml` + `scripts/action-run.js`.
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

## Ideas for later

1. Shell choice per runbook, only with a safe design (e.g. picking among installed shells, never
   a path from the file).

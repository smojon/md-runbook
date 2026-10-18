# Handoff

State of the project for whoever picks it up next (person or new Claude session).

## Where things are

- `main` and `claude/md-runbook-vscode-extension-8f4yog` both contain everything. Version 0.1.0, not
  published yet.
- Tests: `npm test` (unit, ~410) and `npm run test:integration` (real VS Code, ~50 tests).
  CI runs both on Windows, macOS and Linux on every push (`.github/workflows/ci.yml`).
- Feature docs: `docs/features/*.md`. Store/release steps: `PUBLISHING.md`.
- Security rule for every feature: it can be turned off in settings, the default is the most secure
  choice, and settings that weaken security are `"scope": "machine"` (user settings only).

## Run the tests locally

```sh
npm ci
npm test                                   # unit tests
MD_RUNBOOK_PWSH=/path/to/pwsh npm test     # also the real PowerShell tests (value is a path)
npm run test:integration                   # needs a VS Code download (xvfb-run on Linux)
```

## To do before publishing (owner)

1. GitHub: make `main` the default branch (Settings → General → Default branch), then delete the
   `claude/...` branch if you like.
2. Make the repository public, so the README screenshots show on the Marketplace.
3. Create the publisher accounts and add the `VSCE_PAT` / `OVSX_PAT` secrets (see `PUBLISHING.md`).
4. `git tag v0.1.0 && git push origin v0.1.0`: the release workflow tests, packages and publishes.

## Known gaps (small, documented or deliberate)

- Session mode, PowerShell: native commands that read stdin wait for input; use `$null | cmd`
  (documented in `docs/features/session.md`).
- Secret values seen in a run are kept for redaction until VS Code restarts (not cleared when the
  notebook closes).
- With `safety.recordContext` on, a cell's secret prompts come before its confirmation
  (documented in `docs/features/safety.md`).
- Terminal mode is tested through the integration suite and the pure command-line parts; it has
  not been tried by hand on Windows/macOS.
- The controller's try/finally cleanup has no unit test (it needs VS Code).

## Done in the 2026-10-19 batch (not released yet)

Line runs (Run Line or Selection, Run Lines One by One, Step Through, Step Through from This
Line, also for terminal cells), checks (`expect=`), retries (`retry=`), captured values
(`capture=` / `${out:NAME}`), save after each run, front matter `cwd:` / `timeout:`, the Get
started walkthrough, `os=` alternatives, and the command-line runner (`out/dist/cli.js`, with
HTML/PDF/JUnit reports). See `CHANGELOG.md` under "Unreleased" and `docs/features/`.

## Ideas for later

1. Publish the command-line runner to npm (`npx md-runbook run …`): needs an npm account and a
   package without the extension's files (or `bin` from the extension package as today).
2. PDF in the extension's **Export Report**, using the CLI's headless-browser printing.
3. Fresh Marketplace screenshots of the newer features (progress, CodeLens, AI context, line
   runs, checks).
4. Shell paths stay out of the front matter on purpose (a file must not choose the program that
   runs cells); revisit only with a safe design (e.g. a choice among installed shells).

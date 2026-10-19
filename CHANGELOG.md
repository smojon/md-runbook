# Changelog

## Unreleased

- **Security fixes** from a review of the 0.2 and 0.3 features:
  - A value captured by a cell written by an assistant is no longer used by your own cells
    (`${out:NAME}` fails there), and approval now lists `capture=`, `expect=`, `retry=` and
    similar options.
  - Regular expressions from a runbook (`expect=`, `capture=`) may run for at most 1 second, so
    a runaway pattern can't freeze VS Code. `retry=` allows at most 100 attempts, `every=` at
    most 1 hour, and a risky command's confirmation says how often it may run.
  - Front matter `cwd:` and `timeout:` no longer apply to assistant cells, and follow
    `mdRunbook.cellOptions.enabled`. The recorded context comes from the folder the cell runs in.
  - A line run refuses to start if the cell changed while it waited.
  - A `capture-secret=` value is redacted even when another capture of the cell failed.
  - Command line: secrets from environment variables are redacted from every step (also before
    the step that uses them); `capture-secret=` output is printed only once redacted; the
    notification URL is kept out of the cells' environment and redacted; reports and step
    titles are redacted; a malformed placeholder fails its step instead of stopping the run
    (and its notification); `-h`/`--help`/`--version` only count as the first argument.
  - Release workflow: test jobs get a read-only token; the npm token is only in the publish
    step. The Run-workflow template's comments now say that Pages gets every result file, and
    how to protect secrets with environment approvals.

- **Sample runbook:** new sections 13 to 17 try line runs, checks and retries, captured values
  (also secret ones), blocks for one OS, reports, problem markers and the command line.
- **Walkthrough:** a new step for problems, reports and the command line.
- **Command line:** `--json FILE` writes the step results (status, exit code, message, output)
  for scripts.
- CI checks that the sample runbook still does what its text says (`scripts/check-sample.js`).

## 0.3.0

- **Checking runbooks:** invalid or unknown cell options, `${out:NAME}` without an earlier
  `capture=NAME`, undeclared `${param:NAME}` and ignored front matter values are underlined
  while you edit (`mdRunbook.lint.enabled`), and `md-runbook lint` checks files in CI, with
  GitHub annotations on pull requests.
- **Export Report (PDF):** a new command next to Export Report (HTML) prints the report with the
  Chrome, Edge or Chromium already installed (`mdRunbook.report.browserPath` to pick one).
- **GitHub Action:** `uses: smojon/md-runbook@v0.3.0` runs a runbook in a workflow and keeps
  the filled-in runbook and HTML, PDF and JUnit reports. It builds the runner from its own
  source at the version you pin. This repository's CI runs a runbook with it on Windows, macOS
  and Linux.
- **Run from the web:** `examples/github/run-runbook.yml` adds a **Run workflow** button that
  runs a runbook and keeps its results; publishing the report to GitHub Pages is opt-in.
- **Scheduled checks and notifications:** `examples/github/scheduled-check.yml` is a weekday
  health check. `MD_RUNBOOK_NOTIFY_URL` (or `--notify URL`) posts a summary of a failed run to
  Slack, Microsoft Teams (Workflows), Discord or Google Chat; `--notify-on always` also on
  success.
- **npm package (prepared):** the command line is packaged for npm as `md-runbook` and will be
  published with the first release after the npm token is set up. Until then use the GitHub
  Action, or `node out/dist/cli.js` from a clone.
- **Terminal mode:** a cell no longer waits forever when VS Code's terminal never reports the end
  of a command (seen occasionally on Linux): it ends a few seconds after the command has written
  its exit code.
- **Demo runbook** `examples/screenshots.runbook.md`: a realistic restart runbook that only
  prints simulated output, for trying line runs, checks, retries and captures.

## 0.2.0

- **Line by line:** the dropdown next to a code cell's run button has new commands.
  **Run Line or Selection** (`Ctrl+Alt+Enter`, also in the cell's context menu) runs the line
  under the cursor, or the selected text. **Run Lines One by One** runs each line in turn and
  stops at the first that fails. **Step Through Lines** pauses before each line, like a debugger
  (`F10` next, `F5` the rest, `Shift+F5` stop), and **Step Through from This Line** starts at
  the cursor. Each line shows as `$ command` in the output, and `cd` and variables carry over
  between lines, in `terminal` cells too. A run that didn't cover every line is saved with
  `lines=` and doesn't count as done.
- **Checks:** `expect="text"` or `expect=/regex/`, `expect-not=…` and `expect-exit=N` cell
  options. A step whose output isn't what the runbook expects fails, even with exit code 0
  (`check=failed` on the marker), and `expect-exit=1` makes exit code 1 a pass.
- **Retries:** `retry=10 every=15s` runs a cell again until it passes, for "wait until ready"
  steps. Only the last attempt's output is kept; the marker records `attempts=`.
- **Captured values:** `capture=NAME` or `capture=NAME:/regex/` keeps a value from a cell's
  output, and later cells use it as `${out:NAME}`. `capture-secret=NAME` redacts the value
  everywhere and never saves it.
- **Blocks for one OS:** `os=windows` or `os=linux,macos` on a block. Blocks for another OS are
  not run (and keep their output), and adjacent alternatives count as one step, so one runbook
  works on Windows, Linux and macOS.
- **Command line:** `md-runbook run file.md` (`out/dist/cli.js` in a clone of the repository)
  runs a runbook outside VS Code, for CI, servers and scheduled checks, with the same cell
  options, checks and redaction. It writes the outputs into the file and can write HTML, PDF
  (with an installed Chrome, Edge or Chromium) and JUnit reports, plus a GitHub Actions job
  summary. Risky commands need `--yes`, secrets come from environment variables, and proposed or
  assistant-written cells never run.
- **Get started walkthrough:** *Help → Welcome → Get started with Markdown Runbook* walks
  through running steps, line runs, sessions, placeholders, checks and sharing.
  **md-runbook: Open Sample Runbook** opens a safe sample as an untitled runbook.
- **Save after each run:** with `mdRunbook.output.saveAfterRun` on, the runbook is saved after
  every run, so outputs are on disk even if VS Code closes.
- **Runbook defaults:** `cwd:` and `timeout:` in the front matter set the folder and timeout for
  every cell of a runbook; a cell's own `cwd=` / `timeout=` still wins.
- **Report:** prints cleanly (light colours, wrapped output) for PDF and paper.

## 0.1.2

- **Checklists:** clicking a checkbox, or **Check Next Item**, now shows the tick right away.
  Before, the file changed but the box only looked ticked after reopening the runbook.
- **Sample runbook:** the terminating-error example no longer leaves `$ErrorActionPreference =
  'Stop'` set in session mode, which made the next cell's `Write-Error` fail and stopped Run All.

## 0.1.1

- **Faster start:** the extension is now bundled into a single file, so it loads much faster
  when VS Code opens a runbook.
- **Clickable checklists:** `- [ ]` items in Markdown cells show as checkboxes; clicking one ticks
  or unticks it in the file.
- **Earlier runs in the notebook:** with `mdRunbook.output.historySize` set, a cell's status line
  shows how many earlier runs are kept (`exit code 0 · 1.2s · bash · 2 earlier runs`), and a
  collapsed section below it expands to their outputs.
- **Tidier settings:** the settings are grouped into sections (Running cells, Saved output, Safety
  and redaction, Secrets and environment, AI assistant, Assistant proposals), with the common
  ones first.
- **Session mode at a glance:** the notebook toolbar button now reads **Session: on** or
  **Session: off** for the open runbook instead of "Toggle Session Mode"; clicking it switches.
- **Terminal mode:** window-title codes (e.g. `]0;C:\WINDOWS\...\powershell.exe`) no longer
  appear in the output.
- **Terminal option explained:** a cell marked `terminal` while terminal mode is off now says so
  in its output instead of being ignored silently.
- **New icon**, and **Copy Cell for AI** in the cell toolbar is now an icon instead of text that
  overlapped the other buttons.
- New sample runbook, `examples/sample.runbook.md`, for trying every feature by hand.

## 0.1.0

First release (preview).

- Open Markdown files as notebooks ("Open as Runbook"), with a byte-identical round trip.
- Run `sh`/`bash`, `pwsh`/`powershell` and `cmd` blocks natively on Windows, macOS and Linux.
- Live streaming output, cancel and timeout with process-tree kill, Run All with stop on failure.
- Outputs persisted in the `.md` file, with secret redaction, ANSI stripping and truncation.
- "Clear All Outputs" command.
- Terminal mode (`mdRunbook.terminal.mode`, off by default): run cells in a VS Code terminal to
  answer interactive prompts, with output and exit code still saved.
- Proposed cells with approval, an audit trail, a command policy and read-only credentials for
  assistant-written cells (which never run inside a shared session).
- Copy for AI / Paste AI Proposal with untrusted-output boundaries, pseudonymization and a leak
  check; Check for Leaks.
- AI assistance (Explain Output, Suggest Next Steps, Summarize Incident) via VS Code language
  models or the Claude API. Off by default.
- Secure defaults throughout; security-sensitive settings are user-settings only.
- Persistent session mode (`mdRunbook.execution.mode: session`) with Restart/Stop Session, a
  per-runbook toggle, `mode:` in front matter and `mdRunbook.session.resetOnRunAll`.
- Secrets in the OS keychain, `${secret:…}` / `${input:…}` / `${param:…}` references passed as
  environment variables, front-matter parameters, `.env` files and exact-value redaction.
- Per-cell fence options (`timeout=`, `cwd=`, `env.X=`, `continue-on-error`, `skip`,
  `confirm`), confirmation before risky commands (declining stops Run All), and context
  attributes recorded in output markers.
- Mark steps done/skipped, checklist progress in the status bar, Resume Run, Clear Outputs
  Above/Below.
- Output history in a collapsed `<details>` block, Run All as Copy, `changed=` attribute and
  Compare With Previous Run.
- "▶ Run" CodeLens in the Markdown text editor and HTML report export.
- Output markers record `ended=` and `duration=`.

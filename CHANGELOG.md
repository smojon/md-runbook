# Changelog

## Unreleased

Security fixes from a review of the assistant, signed runbooks and md-runbook-gate:

- **An AI answer can no longer add a runnable cell.** Summarize Incident and Explain Output →
  Insert as Note put the model's text into the runbook; a ```` ```bash ```` block in it (for
  example from a prompt injection in a server's output) became an ordinary cell that ran without
  approval. Code in AI text is now kept as a `text` block. (Extension and app.)
- **The signer's name is no longer presented as checked.** It is written in the file next to the
  signature, and nothing checked it outside a gate: `md-runbook verify` now says "signed by X (as
  the file says)" and "signature: NOT checked" without `--allowed-signers`, and the app shows the
  signer a gate accepted once a block ran through it. A signer name can't end the HTML comment.
- **Line runs of signed blocks split like bash.** A here-doc whose delimiter has quotes
  (`<<E"O"F`) or a function whose body starts on the next line was split into wrong commands, so
  Step through could run here-doc text as a command. Signing now also checks each command with
  `bash -n` where bash is installed.
- **md-runbook-gate:** a client could replace a queued command by reusing a request id (running a
  later command before an earlier one); the client's locale could change what a parameter pattern
  matches; one runbook's parameters stayed set for the next; `PATH`, `IFS`, `BASH_ENV`, `LD_*`
  and similar names are refused as parameters and `env.*`; the revoked list tolerates CRLF, upper
  case and a `sha256:` prefix.
- **Signing** refuses those names too, patterns with JavaScript-only syntax (`\d`, `(?…)`, lazy
  `*?`), `${param:X:…}`, and impossible dates. `verify --allowed-signers` accepts a signer line
  with several principals.

## 0.9.1

- **The toolbar's Run, Values, Assistant, Share and Help show.** In 0.9.0 VS Code drew them as
  blank 21-pixel buttons (it shows an extension's submenu in the notebook toolbar as a bare icon,
  and dropped the icon). They are now labeled buttons, each opening a list of its actions to
  click or type in; the toolbar's **⋯** has the same five menus as submenus.
- **README:** a new demo GIF and screenshots, with the current toolbar.

## 0.9.0

- **Every command is in the runbook's toolbar**, no command palette needed: **Run**, **Values**,
  **Assistant**, **Share** and **Help** dropdowns next to Resume Run and the session switch.
  Approve and Reject are in a cell's ⋯ menu while the runbook has proposals. New: **Get
  Started** (the walkthrough) and **Cheat Sheet** in Help.
- **Cheat sheet** (`docs/cheatsheet.md`, Help ▸ Cheat Sheet): every action of the extension, the
  app and the command line, where it is, and when it matters to you.
- **Open in the App** (Share ▾) copies a link that opens the runbook in the md-runbook app on a
  phone (its GitHub or GitLab file), and warns when the phone would get an older version. See
  `docs/switching.md` for moving runbooks between VS Code and the app.
- **The app** (in development) got the extension's features and names: one-tap Run all /
  Continue / Run again with progress, ⋯ More with every action (searchable), a cell's ⋯, steps,
  sessions, Run All as Copy, reports and sharing, secrets and inputs, the assistant, approving
  proposals with the same policy, `${out:NAME}` captures, breakpoints, Explain on a line, and
  output history with Compare With Previous Run; proposals no longer run there unapproved.
- **Set Inputs** asks for every `${input:NAME}` of the runbook, the current values filled in, to
  set or change them before running; **Set Parameters** also covers parameters the cells use
  without declaring them.

## 0.8.0

- **Signed runbooks.** **md-runbook: Sign Runbook** (or `md-runbook sign`) signs a runbook's
  bash blocks with an SSH key (`ssh-keygen -Y sign`) and writes the signature at the end of the
  file, invisible on screen. Servers whose support keys are restricted to the new
  **md-runbook-gate** (`apps/gate`, one POSIX `sh` script) run only runbooks signed by keys
  they trust, unchanged, with scopes, expiry dates, revoked releases, patterns for
  `${param:NAME}`, and a JSON log of every run; unsigned blocks can be allowed per server or per
  key. `md-runbook verify` shows what a signature covers; lint and the editor warn about blocks
  changed since signing. New cell option `lines=any` (single lines of a signed block may run)
  and setting `mdRunbook.signing.key`. See `docs/features/signed-runbooks.md`.
- **Lint:** `host=` is a known cell option (it was reported as unknown).
- **The md-runbook app** (in development, not in the stores yet) runs signed runbooks through
  md-runbook-gate, shows who signed them, and asks for `${param:NAME}` values on the runbook.

## 0.7.0

- **`host=NAME` blocks** are for the md-runbook app, which runs them on that host over SSH. The
  extension and the CLI run cells on this machine, so they never run one, even with cell
  options turned off: Run All passes over it, ▶ does nothing, the cell's status line says
  "Runs on NAME · not run here", and progress counts it as skipped. Before, the option was
  unknown and such a block would have run locally.
- **Syntax reference** (`docs/syntax.md`): the whole file format on one page, written from the
  parser: fence info-string grammar, every cell option with its value type, placeholders, front
  matter keys, output markers and their attributes, and a checklist for an assistant that
  writes runbooks. Linked from the README, the CLI README and the default **Copy for AI** header.
- **Settings regrouped** (no key changed): editor settings (code lens, lint, line buttons,
  breakpoints) have their own group **Editor and lines**; the context recording settings and
  the status bar ones sit under **Saved output**; `execution.refreshPath` under **Running
  cells**; the four **Copy for AI** settings have their own group, leaving **AI assistant** with
  the model and privacy settings.
- **On Open VSX** as well as the Visual Studio Marketplace, so Cursor, Windsurf and VSCodium can
  install it; each release now publishes to both.
- **README**: a demo GIF at the top (Run All, a retried check, then the same file as plain
  Markdown with the output saved in it), store links, and a comparison with Runme.

## 0.6.0

- **A block for another OS says so before you click it:** its status line reads
  `⊘ For macOS · not run on Windows`. VS Code shows ▶ on every code cell and cannot hide it
  for one, so clicking it still only reports which OS the block is for.
- **Tools installed by a runbook are found by its next step (Windows):** every cell inherited
  VS Code's `PATH`, read once when VS Code started, so a runbook that installed Git or uv with
  `winget` in one step failed to find it in the next until VS Code was restarted. Each cell now
  also gets the `PATH` directories added since then, read from the registry (Machine, then User)
  as a new terminal does. They are only appended, so the inherited `PATH` keeps its order and its
  own entries (a virtualenv, a `PATH` set before starting VS Code) still win.
  The shell itself is looked up on it too, so a PowerShell 7 installed by an earlier step runs
  the next `pwsh` cell. A session gets the directories when it starts (**Restart Session** starts
  a new one); a running session keeps its `PATH`. `mdRunbook.execution.refreshPath` (default on)
  turns it off.

## 0.5.0

- **Line hover, plain click:** rest the mouse on a command of a cell (with two or more) for
  **Run line**, **Run lines 1-N** (up to and including it), **Run lines N-end**, **Step from
  here**, **Check**, **Breakpoint**, **Copy with values** and, with an AI provider set,
  **Explain**, with VS Code's own icons. Below the buttons: whether it will ask before running,
  the last known target context (`output.recordContext`), and the current value of each
  `${param:…}`, `${out:…}`, `${input:…}` (secrets never shown). A plain click is enough; the
  inline `▶ ☐` needed Ctrl+click.
- Checked lines get a ☑ in the margin, and the cell's status line has **Run 2 checked lines**,
  one click to run them.
- `mdRunbook.lines.buttons` is now `hover` (default), `inline` (the `▶ ☐` in front of each
  command, as in 0.3.2 to 0.4.0) or `off`. An earlier `true` still means inline, `false` off.
- **Run copies are saved after each run:** `mdRunbook.output.saveAfterRun` is now `"copies"` by
  default, so a file made by **Run All as Copy** has its outputs on disk after every run, also
  when a cell in it is re-run later. Runbooks run in place are still saved only when you save
  them; `true` saves those too (as before), `false` never saves after a run.
- **Slow opens explained:** when a runbook takes more than 10 s to show its cells, md-runbook says
  once that this is VS Code delaying notebooks on a busy computer, and how to avoid it (start VS
  Code with `--disable-renderer-backgrounding`), with **Learn More** and **Don't Show Again**. See
  [Troubleshooting](docs/troubleshooting.md) and the
  [investigation](docs/investigations/notebook-open-slow.md). The integration tests now start
  their VS Code with that flag, so a busy CI runner no longer fails a test for it.

## 0.4.0

- **Regular expressions** in `expect=`, `expect-not=` and `capture=NAME:/…/` now use RE2 syntax,
  which runs in linear time instead of being stopped after 1 second. Look-around and
  back-references are not available: such a cell shows an option error (the linter reports it
  too).
- The parser, writer and the rest of the core moved to a shared package (`packages/core`) that
  the coming phone and web app will use too. No change in behaviour.
- Marketplace: listed under **Testing** (instead of Other), with the keywords checks, ci, junit
  and lint.

## 0.3.2

- **Line buttons:** `▶ ☐` in front of each command of a cell (with two or more): `▶` runs that
  command, `☐` checks it, and **Run Checked Lines** runs the checked ones in order
  (`lines=1,3`). `mdRunbook.lines.buttons` turns them off.
- **Breakpoints:** click the margin of a `bash`, `pwsh` or `cmd` cell to set one; running the
  cell then pauses before that line (`F10` next line, `F5` continue to the next breakpoint,
  `Shift+F5` stop). A breakpoint on a blank line or comment pauses at the next command.
  `mdRunbook.lines.breakpoints` turns them off.
- **Menus:** "…Selection" entries show only when text is selected; the right-click menu of a
  code cell has **Run This Line** / **Step Through from This Line** (they were missing there).
  `F5` while paused now continues to the next breakpoint.

## 0.3.1

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

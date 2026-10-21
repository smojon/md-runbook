# md-runbook

Open Markdown files as VS Code notebooks: run the shell code blocks and store their output
inside the same `.md` file. It runs natively on **Windows** (PowerShell, cmd, Git Bash; no WSL),
**macOS** and **Linux**.

- The file stays plain Markdown. Opening and saving without running anything leaves it
  **byte-for-byte unchanged**: CRLF/LF (even mixed), blank lines, `` ``` `` vs `~~~` fences, info
  strings and annotations, BOM, and a missing trailing newline are all kept.
- Fenced `sh`, `bash`, `pwsh`, `powershell` and `cmd` blocks become runnable cells. Everything
  else, including other fenced blocks (`json`, `yaml`, …), stays Markdown.
- Output streams live into the cell. On save it is written right after the code block, and it
  is **redacted for secrets** first.

![A runbook open as a notebook after Run All](docs/1-notebook.png)

The same file saved and opened as plain Markdown, with output blocks and redacted secrets:

![The saved Markdown with output blocks](docs/2-saved-markdown.png)

## Install

From the Visual Studio Marketplace or Open VSX: search for **Markdown Runbook** in the Extensions
view (once published; see [PUBLISHING.md](PUBLISHING.md)). Requires VS Code 1.93 or newer.

Or build the `.vsix` yourself and install it:

```sh
npm ci
npm run package          # produces md-runbook-<version>.vsix
code --install-extension md-runbook-0.1.0.vsix
```

You can also use **Extensions view → ⋯ → Install from VSIX…**.

## Usage

md-runbook does **not** replace the normal Markdown editor. To open a file as a runbook, use any of:

- right-click a `.md` file in the Explorer → **Open as Runbook**,
- the notebook icon in the title bar of a Markdown editor,
- **Open With… → Markdown Runbook**,
- the command **md-runbook: Open as Runbook**.

New to it? **Help → Welcome → Get started with Markdown Runbook** is a short walkthrough, and
**md-runbook: Open Sample Runbook** opens a safe sample to try (untitled, so nothing is written
until you save it).

To make it the default for some files, add for example
`"workbench.editorAssociations": { "*.runbook.md": "md-runbook" }`.

Run cells with the usual notebook controls: run cell, **Run All**, Run Above/Below.
**md-runbook: Open as Markdown Text** switches back to the text editor.

Everything md-runbook reads from a file (fence options, placeholders, front matter) and writes
into it (output markers) is on one page: the [syntax reference](docs/syntax.md). Hand it to an
AI assistant that writes runbooks for you.

### Shells

| Fence | Windows | macOS / Linux |
| --- | --- | --- |
| `pwsh`, `powershell` | `pwsh`, falling back to `powershell.exe` | `pwsh` |
| `cmd` | `cmd.exe` | not available |
| `sh`, `bash` | Git Bash (auto-detected or `mdRunbook.shell.bashPath`) | `bash` (falls back to `sh`) |

- **Working directory:** the folder containing the `.md` file.
- **Programs installed during the session (Windows):** each cell gets the `PATH` directories
  added since VS Code started, read from the registry as a new terminal does, so a runbook can
  install a tool in one step and use it in the next without restarting VS Code. Directories are
  only appended; the inherited `PATH` keeps its order. A [session](docs/features/session.md) gets
  them when it starts and keeps its `PATH` while it runs. `mdRunbook.execution.refreshPath` turns
  it off. On macOS and Linux most installers write into a folder that is already on the `PATH`;
  when one adds a new folder through your shell profile (uv, cargo, nvm), restart VS Code or
  start the cell with `export PATH="$HOME/.local/bin:$PATH"`.
- **How a cell runs:** by default each cell is written to a temporary script file and run as a
  separate process, so variables and `cd` don't carry over between cells. Set
  `mdRunbook.execution.mode` to `session` to keep one shell per runbook instead
  ([session mode](docs/features/session.md)).
- **No input:** stdin is closed, so interactive prompts fail fast instead of hanging (or use
  [terminal mode](docs/features/terminal.md)). Otherwise use
  non-interactive flags (`oc login --token=…`) or environment variables
  (`mdRunbook.execution.env`).
- **Exit codes:**
  - **bash/sh:** the script's exit status (use `set -e` to stop at the first failing command).
  - **cmd:** the last command's `ERRORLEVEL`. `@echo off` and `chcp 65001` (UTF-8) are applied
    automatically.
  - **PowerShell:** a cell fails if it throws a terminating error, calls `exit N` with N ≠ 0, or
    if the **last native command it ran** (e.g. `oc`, `kubectl`) exited non-zero. Non-terminating
    errors (`Write-Error`, a failed `Get-Item`) follow PowerShell's own rules: add
    `$ErrorActionPreference = 'Stop'` to make them fatal. Output is UTF-8.
- **Git Bash on Windows** is searched for in `Program Files\Git`, `%LOCALAPPDATA%\Programs\Git`,
  Scoop, and next to `git.exe` on `PATH`. The WSL launcher (`System32\bash.exe`) is never used.

### Cancel and timeout

Stopping a cell kills its **whole process tree**: `taskkill /T /F` on Windows, the process group
on macOS/Linux. `mdRunbook.execution.timeoutSeconds` does the same automatically. Cancelled
and timed-out cells are recorded as `exit=cancelled` / `exit=timeout`.

**Run All** runs cells in order and stops at the first cell that fails, times out or is
cancelled (`mdRunbook.execution.stopOnFailure`). Cells of one runbook never run concurrently.

## More features

Each has its own page with examples and settings:

- **[Working with an AI assistant](docs/features/approval.md):** the `.md` file is a safe
  interface between you and an assistant. The assistant only ever **proposes** cells
  (```` ```bash proposed by=ai reason="…" ````); they don't run until you approve them, a
  command policy (`.md-runbook-policy.json`) blocks or flags risky commands, approved AI cells
  run with read-only credentials and never inside a shared session, and the output marker
  records who proposed and who approved each command.
- **[Copy for AI, pseudonymization and leak check](docs/features/ai-context.md):** hand a runbook
  to any assistant as redacted text with outputs marked as untrusted data, with hostnames, IPs,
  namespaces and emails replaced by stable aliases (`host-1`, `ip-2`) that are mapped back when you
  **Paste AI Proposal**. A leak check runs before anything is shared.
- **[AI assistance](docs/features/ai.md):** **Explain Output**, **Suggest Next Steps** and
  **Summarize Incident** with VS Code's language models (e.g. Claude via GitHub Copilot) or the
  Claude API with your own key. Off by default; every send is confirmed and can be previewed.
- **[Terminal mode](docs/features/terminal.md):** run a cell in a real VS Code terminal so you can
  answer password prompts and confirmations; output and exit code are still saved. Off by
  default; enable it with `mdRunbook.terminal.mode` and mark cells with ```` ```bash terminal ````.
- **[Persistent session mode](docs/features/session.md):** one bash and one PowerShell process
  per runbook, so `oc login`, `cd`, exported variables and functions carry over between cells.
  Turn it on per runbook with the toolbar toggle or `mode: session` in the front matter, restart
  or stop it from the status bar, and optionally start every Run All in a fresh session.
- **[Line by line](docs/features/lines.md):** hover a command for **Run line** and **Check** to
  run it or check it for **Run Checked Lines**; run the selected text (`Ctrl+Alt+Enter`), a cell's lines one by one,
  or step through them with `F10`, like a debugger; set **breakpoints** in a cell's margin and its
  runs pause there. `cd` and variables carry over between lines; partial runs are saved with
  `lines=`.
- **[Checks, retries and captured values](docs/features/checks.md):** `expect="Running"` or
  `expect=/regex/` fails a step whose output is wrong, `retry=10 every=15s` waits until it passes,
  and `capture="POD:/name: (\S+)/"` keeps a value from the output for later cells as `${out:POD}`.
- **[Blocks for one OS](docs/features/safety.md#blocks-for-one-os):** mark alternatives with
  `os=windows` / `os=linux,macos`; each user's run uses the block for their OS, and the
  alternatives count as one step.
- **[Command line](docs/features/cli.md):** `md-runbook run deploy.md` runs a runbook without
  VS Code (CI, servers, scheduled checks) and writes the outputs into the file, with HTML, PDF
  and JUnit reports and a GitHub job summary. Risky commands need `--yes`; secrets come from
  environment variables and are redacted.
- **[Checking runbooks](docs/features/lint.md):** problems such as unknown cell options or
  `${out:NAME}` without a capture are underlined while you edit; `md-runbook lint` checks files
  in CI.
- **[On the web](docs/features/web.md):** a GitHub Actions workflow with a Run button
  (`examples/github/run-runbook.yml`), the `smojon/md-runbook` GitHub Action, and running the
  extension in GitHub Codespaces.
- **[Phone and browser app](docs/app.md)** (in development, not in the stores yet): the same
  runbooks on iPhone, Android and the web, run on your servers over SSH, with the SSH key kept
  in the phone's secure hardware. `host=NAME` cells are for the app: the extension and the CLI
  never run them.
- **[Secrets, inputs, parameters and `.env`](docs/features/secrets.md):** keep secrets in the OS
  keychain and reference them as `${secret:NAME}`. They reach the cell as environment variables,
  never as script text, and are redacted by exact value. `${input:NAME}` prompts once per session,
  front-matter `params:` make one runbook work for dev, test and prod, and a `.env` file can be
  loaded per runbook.
- **[Cell options, confirmations and context](docs/features/safety.md):** per-cell options in the
  fence line (```` ```bash timeout=30 cwd=../infra continue-on-error ````), a confirmation
  dialog before risky commands (`delete`, `drain`, `rm -rf`, `--force`, …), and the cluster
  context (`kubectl config current-context`, `oc whoami --show-server`) recorded in each output
  marker and shown in the status bar.
- **[Progress, manual steps and Resume](docs/features/progress.md):** mark steps done or skipped
  without running them, tick Markdown checklists, see `4/7 · ✗ step 5` in the status bar, and
  **Resume Run** from the first failed or unrun step. Also Clear Outputs Above / Below.
- **[Output history, run copies and diffs](docs/features/history.md):** keep the last N runs in a
  collapsed `<details>` block, **Run All as Copy** into a timestamped `.md` (the original stays
  a clean template), and **Compare With Previous Run**. Re-run outputs get `changed=yes|no`.
- **[Run from the text editor and export a report](docs/features/codelens-report.md):** "▶ Run"
  links above each block in the normal Markdown editor, and a self-contained HTML report with a
  step summary table, also as PDF (printed by the Chrome or Edge you have).

## Output format

On save, each cell's output is written directly after its code block:

````markdown
```bash
oc whoami
```
<!-- md-runbook:output start exit=0 ran=2026-10-18T14:20:00+02:00 ended=2026-10-18T14:20:01+02:00 duration=1.234s -->
```text
system:admin
```
<!-- md-runbook:output end -->
````

- `exit` is the exit code, or `timeout`, `cancelled`, `error` (the shell could not start) or a
  signal name.
- `ran` and `ended` are the start and end times, in local time with their UTC offset.
  `duration` is the elapsed time in seconds with millisecond precision.
- Blocks written by older versions (with only `exit` and `ran`) still load; any other
  `key=value` attributes are read too.
- The output fence is made longer than any backtick fence inside the output, so the output can
  never break the document.
- Output blocks of indented code blocks (e.g. in lists) are indented the same way.
- stdout and stderr are merged in the order they arrived. The status line shown in the editor
  (`exit code 0 · 1.2s · pwsh`) is not written to the file.
- When the file is opened, output blocks become the cell's output again, not separate cells.
  Re-running a cell replaces its block. Output blocks you don't re-run are kept byte for byte.
- An output block is only recognized directly after a runnable code block (blank lines in
  between are allowed) and only with the exact structure above. Anything else stays Markdown.
- Before writing, output is cleaned up: ANSI codes are stripped and carriage-return progress
  lines are collapsed to their final state. Then it is redacted and truncated (the first and last
  lines are kept, with `… [md-runbook: N lines truncated] …` in between).

**md-runbook: Clear All Outputs** (notebook toolbar, Explorer context menu, Command Palette)
removes all output blocks from the file. It works on an open runbook, on a file open as text,
and on a file that isn't open at all. Only output blocks are removed; every other byte stays
as it is.

## Secret redaction

Output is redacted **before it is written to disk**, replacing matches with `[REDACTED]`. The
built-in patterns cover:

- Bearer tokens, JWTs, `Authorization` / `Proxy-Authorization` / `Cookie` / `Set-Cookie` headers
- secret key/value pairs, where the key contains `password`, `pass`, `pwd`, `secret`, `token`,
  `api_key`, `access_key`, `private_key`, `credentials` or ends in `.key`, in `key=value`,
  `key: value`, `"key": "value"` (whole quoted value), query-string and `--key=value` form
- secrets passed as flags: `--password value`, `--client-secret "…"`, `oc login -p …`,
  `mysql -p…`, `curl -u user:…`
- **Kubernetes Secrets**: every value under `data:` / `stringData:` of `oc get secret -o yaml|json`
  (key names are kept), plus base64-encoded keys and docker configs anywhere
- PEM private keys (the BEGIN/END lines are kept). Certificates are not touched.
- Keycloak client secrets (`{"type":"secret","value":"…"}`, "client secret … <uuid>")
- credentials in URLs (`https://user:[REDACTED]@host`)
- OpenShift `sha256~…`, GitHub, GitLab, npm, Slack, Anthropic/OpenAI, Google and Azure tokens and
  AWS access key IDs

Add your own patterns with `mdRunbook.redaction.patterns`. These are JavaScript regular
expressions, and each whole match is replaced. Use lookbehind to keep context:

```json
"mdRunbook.redaction.patterns": [
  "(?<=X-Api-Key:\\s*)\\S+",
  { "pattern": "internal-[0-9a-f]{32}", "flags": "i" }
]
```

The live view in the editor is redacted too, so secrets don't appear on screen or in screen
shares (redaction then works line by line as output arrives). Turn
`mdRunbook.redaction.applyToLiveOutput` off to see raw output while debugging. Redaction is
pattern-based, so review the output before committing a runbook to a shared repository.

## Security defaults

Every feature that changes behaviour can be switched off in the settings, and every default is
the most secure choice. Turn things on as you need them:

| Area | Secure default |
| --- | --- |
| Redaction | On for saved **and** live output; known secret values are always redacted. |
| Risky commands | Ask before running cells that match `mdRunbook.execution.confirmPatterns`; declining stops Run All. The `no-confirm` cell option is ignored unless `mdRunbook.execution.allowNoConfirmOption` is on. |
| Execution | Each cell in its own process (`isolated`). In session mode, Run All starts in a fresh session. |
| Terminal mode | Off. When on, assistant-written cells never run in a terminal; what you type never passes through md-runbook. |
| Text-editor runs (CodeLens) | Off. When on, proposed and assistant-written cells are refused and risky commands still ask. |
| Secrets | Passed as environment variables, never as script text; no `.env` file is loaded unless configured. |
| History | Off (`historySize: 0`), so old outputs are not kept. |
| AI | Provider `off`: nothing is sent until you choose one. Every send is confirmed, names are pseudonymized, and a leak check blocks sharing unless you choose otherwise. |
| Proposals | Proposed cells never run until approved; approval resets when the code changes and is only trusted when made on this machine; the command policy applies; AI cells need read-only credentials (`approval.readOnlyOnly`) and always run isolated. |

Settings that could weaken these (redaction on/off and default patterns, confirmation mode and
patterns, `allowNoConfirmOption`, context commands, shell paths, known-secret redaction, the AI
provider, gateway URL and confirmations, pseudonymization, the leak check, all approval
settings and terminal mode) can only be set in **user** settings: a repository's `.vscode/settings.json` cannot change them. The
extension is also disabled in untrusted workspaces (Restricted Mode).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.output.persist` | `true` | Write new outputs into the file on save. Existing blocks are kept unless re-run or cleared. |
| `mdRunbook.output.saveAfterRun` | `"copies"` | Save after each run (a cell, a range, Run All, a line run), so outputs are on disk even if VS Code closes: `"copies"` only run copies (Run All as Copy), `true` every runbook, `false` never. |
| `mdRunbook.output.maxLines` | `2000` | Max lines written per output (head + tail kept). `0` = unlimited. |
| `mdRunbook.output.stripAnsi` | `true` | Strip ANSI escape codes from written output. |
| `mdRunbook.redaction.enabled` | `true` | Redact secrets before writing output. |
| `mdRunbook.redaction.useDefaultPatterns` | `true` | Use the built-in patterns listed above. |
| `mdRunbook.redaction.patterns` | `[]` | Extra regexes (strings or `{ pattern, flags }`). |
| `mdRunbook.redaction.applyToLiveOutput` | `true` | Also redact the output shown in the editor. |
| `mdRunbook.execution.stopOnFailure` | `true` | Run All stops at the first failed cell. |
| `mdRunbook.execution.timeoutSeconds` | `0` | Kill a cell's process tree after N seconds. `0` = no timeout. |
| `mdRunbook.execution.refreshPath` | `true` | Windows: add the `PATH` directories installed since VS Code started to each cell. |
| `mdRunbook.execution.env` | `{}` | Extra environment variables for every cell. |
| `mdRunbook.shell.bashPath` | `""` | bash executable for `sh`/`bash` (e.g. `C:\\Program Files\\Git\\bin\\bash.exe`). |
| `mdRunbook.shell.pwshPath` | `""` | PowerShell executable for `pwsh`/`powershell`. |

The settings of the features above are listed on their own pages.

## Round-trip details

- Each cell stores the exact bytes it came from. Unchanged cells are written back from those
  bytes.
- Edited cells are rebuilt with their original fence characters, fence length, info string,
  indentation and line ending. The fence is lengthened automatically if the code now contains
  a matching fence.
- Changing a cell's language rewrites only the language word of its info string.
- New cells use the file's dominant line ending and are separated by a blank line.
- Two Markdown cells next to each other merge into one when the file is reopened, since the file
  has no cell boundaries between Markdown paragraphs.
- Fences are recognized at any indentation (so blocks in lists work). Blocks inside blockquotes
  (`> ```sh`) are not runnable.
- Fences nested inside another fence (e.g. a ```` ````markdown ```` example) are not cells.
- An unclosed fence makes the rest of the file Markdown, as in CommonMark.
- The file must be valid UTF-8 for a byte-identical round trip.

## Troubleshooting

- **A runbook opens slowly or stays empty** when the computer is busy: a VS Code notebook
  behaviour; start VS Code with `--disable-renderer-backgrounding`
  ([details](docs/troubleshooting.md#a-runbook-opens-slowly-or-stays-empty)).

## Development

```sh
npm ci
npm test                  # compile + unit, round-trip, fuzz, redaction and shell smoke tests
npm run test:integration  # end-to-end tests in a downloaded VS Code
```

- **Shared core:** the parser, serializer, cell options, checks and redaction live in
  `packages/core` (`@md-runbook/core`, an npm workspace). They never import `vscode` or Node
  modules, so the phone and web app can use them too; running local processes is in
  `@md-runbook/core/node`.
- **VS Code layer:** `src/serializer.ts`, `src/controller.ts` and `src/extension.ts` are thin
  adapters over the core.
- **Smoke tests:** these run real shells and skip any shell that isn't installed. On Windows they
  exercise `pwsh`/`powershell.exe` and `cmd` natively. Set `MD_RUNBOOK_PWSH` / `MD_RUNBOOK_BASH`
  to test a specific executable.
- **CI** runs everything on Windows, macOS and Linux.

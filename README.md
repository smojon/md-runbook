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

Build the `.vsix` and install it:

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

To make it the default for some files, add for example
`"workbench.editorAssociations": { "*.runbook.md": "md-runbook" }`.

Run cells with the usual notebook controls: run cell, **Run All**, Run Above/Below.
**md-runbook: Open as Markdown Text** switches back to the text editor.

### Shells

| Fence | Windows | macOS / Linux |
| --- | --- | --- |
| `pwsh`, `powershell` | `pwsh`, falling back to `powershell.exe` | `pwsh` |
| `cmd` | `cmd.exe` | not available |
| `sh`, `bash` | Git Bash (auto-detected or `mdRunbook.shell.bashPath`) | `bash` (falls back to `sh`) |

- **Working directory:** the folder containing the `.md` file.
- **How a cell runs:** each cell is written to a temporary script file and run as a separate
  process, so variables don't carry over between cells.
- **No input:** stdin is closed, so interactive prompts fail fast instead of hanging. Use
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
  step summary table.

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

- Bearer tokens: `Bearer eyJ…` → `Bearer [REDACTED]`
- JWTs (`eyJ….….…`)
- secret key/value pairs, where the key contains `password`, `passwd`, `pwd`, `secret`, `token`,
  `api_key`, `access_key`, `private_key` or `credentials`, in `key=value`, `key: value`,
  `"key": "value"`, query-string and `--key=value` form
- PEM private keys (the BEGIN/END lines are kept, the body is redacted). Certificates are not
  touched.
- `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` headers (e.g. `curl -v`)
- credentials in URLs (`https://user:[REDACTED]@host`)
- OpenShift `sha256~…` tokens, GitHub tokens and AWS access key IDs

Add your own patterns with `mdRunbook.redaction.patterns`. These are JavaScript regular
expressions, and each whole match is replaced. Use lookbehind to keep context:

```json
"mdRunbook.redaction.patterns": [
  "(?<=X-Api-Key:\\s*)\\S+",
  { "pattern": "internal-[0-9a-f]{32}", "flags": "i" }
]
```

By default the live view in the editor is **not** redacted, so you can see what happened.
Set `mdRunbook.redaction.applyToLiveOutput` to redact the live view too (redaction then works
line by line as output arrives). Redaction is pattern-based, so review the output before
committing a runbook to a shared repository.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.output.persist` | `true` | Write new outputs into the file on save. Existing blocks are kept unless re-run or cleared. |
| `mdRunbook.output.maxLines` | `2000` | Max lines written per output (head + tail kept). `0` = unlimited. |
| `mdRunbook.output.stripAnsi` | `true` | Strip ANSI escape codes from written output. |
| `mdRunbook.redaction.enabled` | `true` | Redact secrets before writing output. |
| `mdRunbook.redaction.useDefaultPatterns` | `true` | Use the built-in patterns listed above. |
| `mdRunbook.redaction.patterns` | `[]` | Extra regexes (strings or `{ pattern, flags }`). |
| `mdRunbook.redaction.applyToLiveOutput` | `false` | Also redact the output shown in the editor. |
| `mdRunbook.execution.stopOnFailure` | `true` | Run All stops at the first failed cell. |
| `mdRunbook.execution.timeoutSeconds` | `0` | Kill a cell's process tree after N seconds. `0` = no timeout. |
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

## Development

```sh
npm ci
npm test                  # compile + unit, round-trip, fuzz, redaction and shell smoke tests
npm run test:integration  # end-to-end tests in a downloaded VS Code
```

- **Pure core:** the parser, serializer, redaction and shell selection live in `src/core` and
  never import `vscode`.
- **VS Code layer:** `src/serializer.ts`, `src/controller.ts` and `src/extension.ts` are thin
  adapters over the core.
- **Smoke tests:** these run real shells and skip any shell that isn't installed. On Windows they
  exercise `pwsh`/`powershell.exe` and `cmd` natively. Set `MD_RUNBOOK_PWSH` / `MD_RUNBOOK_BASH`
  to test a specific executable.
- **CI** runs everything on Windows, macOS and Linux.

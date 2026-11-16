# md-runbook

Open Markdown files as VS Code notebooks: run their shell blocks and store the output in the
same `.md` file. It runs natively on **Windows** (PowerShell, cmd, Git Bash; no WSL), **macOS**
and **Linux**.

![Run All on a runbook, then the same file as plain Markdown with the output saved in it](docs/demo.gif)

- The file stays plain Markdown. Opening and saving it without running anything leaves it
  **byte-for-byte unchanged**. It keeps CRLF/LF (even mixed), blank lines, `` ``` `` vs `~~~`
  fences, info strings, annotations, BOM and a missing trailing newline.
- Fenced `sh`, `bash`, `pwsh`, `powershell` and `cmd` blocks become runnable cells. Everything
  else, including other fenced blocks (`json`, `yaml`, …), stays Markdown.
- Output streams live into the cell. On save it is written right after the code block, and it
  is **redacted for secrets** first.

**Try it in a minute:** install it (below), run **md-runbook: Open Sample Runbook**, then **Run
All**.

- The **Steps** view on the left lists every step by name, with its state and time. Before the
  run, it says what each step will need from you (a confirmation, a secret, a value). When one
  fails, it has **Resume** and **Retry step**.
- Steps done by hand wait for you on the cell (**Done** / **Skip** / **Stop**).
- Blocks without an estimate learn their usual time from past runs, so the status bar can show
  the time left.
- While you work in another file, the status bar keeps showing the run. A notification says when
  it ends or waits for you.

![A run in VS Code: the Steps view on the left with three steps done and a step by hand waiting with Done, Skip and Stop, which are also on the code block it waits before; the status bar says Waiting for you](docs/vscode-steps-run.png)

![A runbook open as a notebook after Run All](docs/1-notebook.png)

The same file saved and opened as plain Markdown, with output blocks and redacted secrets:

![The saved Markdown with output blocks](docs/2-saved-markdown.png)

## Install

Search for **Markdown Runbook** in the Extensions view. It is on the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=smojon.md-runbook)
(VS Code) and on [Open VSX](https://open-vsx.org/extension/smojon/md-runbook) (Cursor, Windsurf,
VSCodium). Requires VS Code 1.93 or newer.

Or build the `.vsix` yourself and install it:

```sh
npm ci
npm run package          # produces md-runbook-<version>.vsix
code --install-extension md-runbook-*.vsix
```

You can also use **Extensions view → ⋯ → Install from VSIX…**.

**Useful to you?** A [rating on the Marketplace](https://marketplace.visualstudio.com/items?itemName=smojon.md-runbook&ssr=false#review-details)
or on [Open VSX](https://open-vsx.org/extension/smojon/md-runbook/reviews) helps others find it,
and an [issue](https://github.com/smojon/md-runbook/issues) tells us what is missing or broken.

## Compared with Runme

[Runme](https://runme.dev) also opens Markdown as a notebook, and has a much larger community. The
differences that matter most:

| | md-runbook | Runme |
|---|---|---|
| In a browser, on a phone | Its own web app (a container or a static site) and iOS and Android apps; they reach your servers over SSH | VS Code itself in the browser, on your machine (`runme open`, through code-server; [docs](https://docs.runme.dev/getting-started/web)) |
| Where the output goes | Into the runbook itself, under each block, so the file is its own record of what ran (or into a timestamped copy with **Run All as Copy**) | Into a separate Session Outputs file, off by default ([docs](https://docs.runme.dev/usage/auto-save)) |
| Windows | Native: PowerShell, cmd and Git Bash, no WSL | Needs WSL 2 ([docs](https://docs.runme.dev/installation/windows)); PowerShell support is "rudimentary" ([limitations](https://docs.runme.dev/resources/limitations)) |
| One runbook for several OSes | `os=windows`, `os=linux,macos` blocks: each OS runs its own | Open request ([runme#960](https://github.com/runmedev/runme/issues/960)) |

As of November 2026, from Runme's documentation and issue tracker.

## Usage

md-runbook does **not** replace the normal Markdown editor. To open a file as a runbook, use any of:

- right-click a `.md` file in the Explorer → **Open as Runbook**,
- the notebook icon in the title bar of a Markdown editor,
- **Open With… → Markdown Runbook**,
- the command **md-runbook: Open as Runbook**.

New to it?

- **Help → Welcome → Get started with Markdown Runbook** is a short walkthrough.
- **md-runbook: Open Sample Runbook** opens a short, safe sample to try.
- **Open Feature Tour** opens one section per feature.

The sample and the tour are untitled, so nothing is written until you save them. A Markdown file
that looks like a runbook offers **Open as Runbook** once, when it opens in the text editor. It
looks like one with a `*.runbook.md` name, saved outputs, or runbook front matter.

To make it the default for some files, add for example
`"workbench.editorAssociations": { "*.runbook.md": "md-runbook" }`.

Run cells with the usual notebook controls: run cell, **Run All**, Run Above/Below.
Everything else is in the runbook's toolbar, so you never need the command palette. Each ▾ button
opens a list of its actions (type to filter); the toolbar's **⋯** has the same menus:

| Toolbar | What's in it |
| --- | --- |
| **Resume Run**, **Session: on/off**, the Markdown icon | resume where a run stopped, switch session mode, open as text |
| **Run** ▾ | Resume Run, Run All as Copy, Go to Next Step, Session…, Restart / Stop Session, Clear All Outputs |
| **Values** ▾ | Set Parameters, Set Inputs, Reset Inputs, Set / List / Delete Secret |
| **Assistant** ▾ | Suggest Next Steps, Summarize Incident, Copy for AI, Paste AI Proposal, Check for Leaks, proposals, the API key |
| **Share** ▾ | Export Report (HTML, PDF), Sign Runbook, Publish to Library… |
| **Help** ▾ | Get Started, Cheat Sheet, Open Sample Runbook, Open Feature Tour |

A cell's **⋯** menu has its own actions:

- mark the step done or skipped;
- clear outputs above or below;
- compare with the previous run;
- explain the output;
- approve or reject a proposal.

Each line of a code cell has its run buttons when you hover it. The
**[cheat sheet](docs/cheatsheet.md)** lists every action, where it is, and when it matters.

The [syntax reference](docs/syntax.md) is one page with everything md-runbook reads from a file
and writes into it. It covers fence options, placeholders, front matter and output markers. Hand
it to an AI assistant that writes runbooks for you.

### Shells

| Fence | Windows | macOS / Linux |
| --- | --- | --- |
| `pwsh`, `powershell` | `pwsh`, falling back to `powershell.exe` | `pwsh` |
| `cmd` | `cmd.exe` | not available |
| `sh`, `bash` | Git Bash (auto-detected or `mdRunbook.shell.bashPath`) | `bash` (falls back to `sh`) |

A runbook can name other installed shells in its front matter, also in the app on the server:

- `shell: zsh` or `shell: sh` for its `sh`/`bash` cells;
- `shell: pwsh` or `shell: windows-powershell` (5.1) for its PowerShell cells.

Only names, never a path; see [the syntax](docs/syntax.md#front-matter).

- **Working directory:** the folder containing the `.md` file.
- **Programs installed during the session (Windows):** each cell gets the `PATH` directories
  added since VS Code started. They are read from the registry, as a new terminal does. So a
  runbook can install a tool in one step and use it in the next without restarting VS Code.
  - Directories are only appended; the inherited `PATH` keeps its order.
  - A [session](docs/features/session.md) gets them when it starts and keeps its `PATH` while it
    runs.
  - `mdRunbook.execution.refreshPath` turns it off.
  - On macOS and Linux most installers write into a folder that is already on the `PATH`. When
    one adds a new folder through your shell profile (uv, cargo, nvm), restart VS Code. Or start
    the cell with `export PATH="$HOME/.local/bin:$PATH"`.
- **How a cell runs:** by default each cell is written to a temporary script file and run as a
  separate process. So variables and `cd` don't carry over between cells. Set
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
  - **PowerShell:** a cell fails if it throws a terminating error or calls `exit N` with N ≠ 0.
    It also fails if the **last native command it ran** (e.g. `oc`, `kubectl`) exited non-zero.
    Output is UTF-8.
    - Non-terminating errors (`Write-Error`, a failed `Get-Item`) follow PowerShell's own rules:
      add `$ErrorActionPreference = 'Stop'` to make them fatal.
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
  interface between you and an assistant.
  - The assistant only ever **proposes** cells (```` ```bash proposed by=ai reason="…" ````).
    They don't run until you approve them.
  - A command policy (`.md-runbook-policy.json`) blocks or flags risky commands.
  - Approved AI cells run with read-only credentials and never inside a shared session.
  - The output marker records who proposed and who approved each command.
- **[Copy for AI, pseudonymization and leak check](docs/features/ai-context.md):** hand a runbook
  to any assistant as redacted text, with outputs marked as untrusted data. Hostnames, IPs,
  namespaces and emails become stable aliases (`host-1`, `ip-2`), mapped back when you
  **Paste AI Proposal**. A leak check runs before anything is shared.
- **[AI assistance](docs/features/ai.md):** **Explain Output**, **Suggest Next Steps** and
  **Summarize Incident**. They use VS Code's language models (e.g. Claude via GitHub Copilot) or
  the Claude API with your own key. Off by default; every send is confirmed and can be previewed.
- **[Agent mode tools](docs/features/ai.md#use-md-runbook-from-vs-codes-agent-mode):** two tools
  for Copilot's agent mode (VS Code 1.99 or later). `#runbookState` reads where a run is and why
  a step failed (output redacted). `#proposeRunbookStep` adds a step as a proposal that you
  approve before it can run.
- **[Terminal mode](docs/features/terminal.md):** run a cell in a real VS Code terminal, so you
  can answer password prompts and confirmations. Output and exit code are still saved. Off by
  default; enable it with `mdRunbook.terminal.mode` and mark cells with ```` ```bash terminal ````.
- **[Persistent session mode](docs/features/session.md):** one bash and one PowerShell process
  per runbook, so `oc login`, `cd`, exported variables and functions carry over between cells.
  Turn it on per runbook with the toolbar toggle or `mode: session` in the front matter. Restart
  or stop it from the status bar, and optionally start every Run All in a fresh session.
- **[Line by line](docs/features/lines.md):** hover a command for **Run line** and **Check**, to
  run it or check it for **Run Checked Lines**.
  - Run the selected text (`Ctrl+Alt+Enter`), a cell's lines one by one, or step through them
    with `F10`, like a debugger.
  - Set **breakpoints** in a cell's margin, and its runs pause there.
  - `cd` and variables carry over between lines; partial runs are saved with `lines=`.
- **[Checks, retries and captured values](docs/features/checks.md):** `expect="Running"` or
  `expect=/regex/` fails a step whose output is wrong. `retry=10 every=15s` waits until it
  passes. `capture="POD:/name: (\S+)/"` keeps a value from the output for later cells as
  `${out:POD}`.
- **[Blocks for one OS](docs/features/safety.md#blocks-for-one-os):** mark alternatives with
  `os=windows` / `os=linux,macos`. Each user's run uses the block for their OS, and the
  alternatives count as one step.
- **[Command line](docs/features/cli.md):** `md-runbook run deploy.md` runs a runbook without
  VS Code (CI, servers, scheduled checks) and writes the outputs into the file. It also makes
  HTML, PDF and JUnit reports and a GitHub job summary. Risky commands need `--yes`; secrets come
  from environment variables and are redacted.
- **[Checking runbooks](docs/features/lint.md):** problems such as unknown cell options or
  `${out:NAME}` without a capture are underlined while you edit. `md-runbook lint` checks files
  in CI.
- **[Dev containers and Codespaces](docs/features/devcontainer.md):** one line in
  `devcontainer.json` installs the command line and the extension.
- **[On the web](docs/features/web.md):** a GitHub Actions workflow with a Run button
  (`examples/github/run-runbook.yml`), the `smojon/md-runbook` GitHub Action, and running the
  extension in GitHub Codespaces.
- **[Phone and browser app](docs/app.md)** (in development, not in the stores yet): the same
  runbooks on iPhone, Android and the web. They run on your servers over SSH, and the SSH key is
  kept in the phone's secure hardware. `host=NAME` cells are for the app: the extension and the
  CLI never run them.
  - [Moving between VS Code and the app](docs/switching.md): a synced folder, **Open in the App**
    from VS Code, **Share Runbook** from the app. The run carries on where it stopped.
- **[On call and incidents](docs/features/on-call.md):** a pager alert's link opens the runbook in
  the app, with the host and parameters filled in. QR codes on machines open runbooks the same
  way (`md-runbook qr --labels`).
  - **Start Incident** records who ran what, where and when.
  - **Add Note** records the decisions and milestones.
  - **Export Report** turns them into an incident record and timeline for the postmortem and the
    auditors. **Sign Run Record** vouches for it.
- **[Drills and training](docs/features/drills.md):** a dated drill record measured against its
  recovery-time objective, run on a practice server so nothing reaches production.
- **[Kubernetes](docs/features/kubernetes.md):** `kube-context: prod-eu` stops every cell on
  the wrong cluster. Or, with `kube-context-mode: pin`, it runs every cell on that cluster
  without touching your default context.
  - The ops host runs the app's runbooks against your clusters with no credential on the phone.
  - `md-runbook-probe` checks endpoints and certificates from inside the cluster, and its
    results go into the record and the audit.
- **[For auditors](docs/features/for-auditors.md):** what md-runbook records and enforces, for:
  - approvals (signatures, two signers, version floors);
  - execution (the gate's log, `md-runbook audit`);
  - evidence (run records, matched against the log and signed).
- **[Signed runbooks](docs/features/signed-runbooks.md):** sign a runbook (**Sign Runbook**, or
  `md-runbook sign`) and ship it anywhere. Servers whose support keys are restricted to
  `md-runbook-gate` run only runbooks signed by keys they trust, unchanged. The gate adds
  scopes, expiry, revocation and a log of every run.
- **[Secrets, inputs, parameters and `.env`](docs/features/secrets.md):** keep secrets in the OS
  keychain and reference them as `${secret:NAME}`. They reach the cell as environment variables,
  never as script text, and are redacted by exact value.
  - `${input:NAME}` prompts once per session.
  - Front-matter `params:` make one runbook work for dev, test and prod.
  - A `.env` file can be loaded per runbook.
- **[Cell options, confirmations and context](docs/features/safety.md):**
  - per-cell options in the fence line
    (```` ```bash timeout=30 cwd=../infra continue-on-error ````);
  - a confirmation dialog before risky commands (`delete`, `drain`, `rm -rf`, `--force`, …);
  - the cluster context (`kubectl config current-context`, `oc whoami --show-server`), recorded
    in each output marker and shown in the status bar.
- **[Progress, the Steps view and Resume](docs/features/progress.md):** the status bar says where
  the run is (`Step 3/6 · Push image · 1m 40s left`), also while another file is in front.
  - The **Steps** view lists every step by name, with what each will need before you run. It
    has Retry / Resume when one fails.
  - Checklist items are steps done by hand that Run All waits at.
  - Mark steps done or skipped without running them, and **Resume Run** from the first failed or
    unrun step.
  - Notifications when a run ends or waits while you look away.
  - Clear Outputs Above / Below.
- **[How long it takes](docs/syntax.md#steps-and-progress):** `estimate=2m30s` on a block, as
  measured on a real run. The block shows it, and while it runs a bar fills at the estimate.
  - The runbook shows how far it is and about how long is left, in VS Code, the app and
    `md-runbook run`.
  - `md-runbook estimate` sums them per section.
  - A [runbook call](docs/features/calls.md) counts as what it runs.
  - [Setup and teardown](docs/features/setup-teardown.md) count apart: a ready check skips a
    setup that is already up, and the teardown is offered, not run.

  ![A deploy runbook in the md-runbook app: 2 of 4 steps done, 56% by the estimates, about 4 min left](docs/app/web-estimates.png)

- **Coloured output:** stderr in red, and log levels in the colours log viewers use (Grafana,
  VS Code's log files). A program's own colours win; the file keeps plain text.
  - `ERROR` red, `WARN` yellow, `INFO` blue, `DEBUG` grey, `OK`/`PASSED` green.
  - Nevis's `5-NOTICE` and Kubernetes' `E1022 …` lines included.
  - Settings: `mdRunbook.output.colorLevels`, `stderrInRed`, `forceColor` (also in the app,
    under Hosts & settings).
- **Cloud console views:** when a cell prints JSON from the AWS or Google Cloud CLI, a table shows
  under the output. Each resource in it has a link to the console. Display only (also in the
  app).
  - Commands such as `aws ec2 describe-instances`, `gcloud compute instances list --format=json`,
    …
  - Resources: EC2 instances, EKS clusters, Compute Engine instances, GKE clusters or Cloud Run
    services.
- **[Output history, run copies and diffs](docs/features/history.md):**
  - Keep the last N runs in a collapsed `<details>` block.
  - **Run All as Copy** into a timestamped `.md`: the original stays a clean template.
  - **Compare With Previous Run**. Re-run outputs get `changed=yes|no`.
  - Every run is also appended to a **transcript** as it happens, saved or not. It goes in a
    `.md-runbook` folder next to the runbook (`.md-runbook/deploy.runbook.transcript.log`).
  - **Run ▾ › Open Transcript** follows the transcript (or `tail -f`); **Run ▾ › Transcript**
    turns it off or on.
- **[Run from the text editor and export a report](docs/features/codelens-report.md):**
  - "▶ Run" links above each block in the normal Markdown editor;
  - a self-contained HTML report with a step summary table, also as PDF (printed by the Chrome
    or Edge you have).

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
- The output fence is made longer than any backtick fence in the output, so it can never break
  the document.
- Output blocks of indented code blocks (e.g. in lists) are indented the same way.
- stdout and stderr are merged in the order they arrived. The status line shown in the editor
  (`exit code 0 · 1.2s · pwsh`) is not written to the file.
- When the file is opened, output blocks become the cell's output again, not separate cells.
  Re-running a cell replaces its block. Output blocks you don't re-run are kept byte for byte.
- An output block is only recognized directly after a runnable code block, and only with the
  exact structure above. Blank lines in between are allowed. Anything else stays Markdown.
- Before writing, output is cleaned up to what a terminal would show:
  - carriage returns, backspaces, erased lines and cursor movements are applied. A progress bar
    or spinner is saved as it ended, not frame by frame.
  - other control characters are dropped;
  - ANSI codes are stripped.
- Cleaned output is then redacted and truncated: the first and last lines are kept, with
  `… [md-runbook: N lines truncated] …` in between.
- On Windows, cells get `PYTHONIOENCODING=utf-8` unless an encoding is set. Python otherwise
  writes to pipes in the ANSI code page. So `é` was saved as `�`, and a `✓` stopped the script.

**md-runbook: Clear All Outputs** (notebook toolbar, Explorer context menu, Command Palette)
removes all output blocks from the file. It works on an open runbook, a file open as text, and a
file that isn't open at all. Only output blocks are removed; every other byte stays as it is.

## Secret redaction

Output is redacted **before it is written to disk**, replacing matches with `[REDACTED]`. The
built-in patterns cover:

- Bearer tokens, JWTs, `Authorization` / `Proxy-Authorization` / `Cookie` / `Set-Cookie` headers
- secret key/value pairs, where the key contains `password`, `pass`, `pwd`, `secret`, `token`,
  `api_key`, `access_key`, `private_key`, `credentials` or ends in `.key`. Forms: `key=value`,
  `key: value`, `"key": "value"` (whole quoted value), query-string and `--key=value`
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

A workspace's patterns (`.vscode/settings.json`) are added to your own. A workspace can't drop
yours.

The live view in the editor is redacted too, so secrets don't appear on screen or in screen
shares. There, redaction works line by line as output arrives. Turn
`mdRunbook.redaction.applyToLiveOutput` off to see raw output while debugging.

Redaction is pattern-based, so review the output before committing a runbook to a shared
repository.

## Security defaults

Every feature that changes behaviour can be switched off in the settings. Every default is the
most secure choice but one: the transcript (below). Turn things on as you need them:

| Area | Secure default |
| --- | --- |
| Redaction | On for saved **and** live output; known secret values are always redacted. |
| Risky commands | Ask before running cells that match `mdRunbook.execution.confirmPatterns`; declining stops Run All. The `no-confirm` cell option is ignored unless `mdRunbook.execution.allowNoConfirmOption` is on. |
| Execution | Each cell in its own process (`isolated`). In session mode, Run All starts in a fresh session. |
| Terminal mode | Off. When on, assistant-written cells never run in a terminal; what you type never passes through md-runbook. |
| Text-editor runs (CodeLens) | Off. When on, proposed and assistant-written cells are refused and risky commands still ask. |
| Secrets | Passed as environment variables, never as script text; no `.env` file is loaded unless configured. |
| History | Off (`historySize: 0`), so old outputs are not kept. |
| Transcript | **On**, the one exception: every run is appended, redacted, to `.md-runbook/<runbook>.transcript.log` next to the runbook, so a run is on disk even if the runbook is never saved. In a Git repository the first one offers to add `.md-runbook/` to `.gitignore`. Turn it off: **Run ▾ › Transcript** (the setting `mdRunbook.output.transcript`). |
| AI | Provider `off`: nothing is sent until you choose one. Every send is confirmed, names are pseudonymized, and a leak check blocks sharing unless you choose otherwise. |
| Proposals | Proposed cells never run until approved; approval resets when the code changes and is only trusted when made on this machine; the command policy applies; AI cells need read-only credentials (`approval.readOnlyOnly`) and always run isolated. |

Settings that could weaken these can only be set in **user** settings: a repository's
`.vscode/settings.json` cannot change them. They are:

- redaction on/off and default patterns;
- confirmation mode and patterns, `allowNoConfirmOption`;
- context commands, shell paths, known-secret redaction;
- the AI provider, gateway URL and confirmations, pseudonymization, the leak check;
- all approval settings and terminal mode.

The extension is also disabled in untrusted workspaces (Restricted Mode).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.output.persist` | `true` | Write new outputs into the file on save. Existing blocks are kept unless re-run or cleared. |
| `mdRunbook.output.saveAfterRun` | `"copies"` | Save after each run (a cell, a range, Run All, a line run), so outputs are on disk even if VS Code closes: `"copies"` only run copies (Run All as Copy), `true` every runbook, `false` never. |
| `mdRunbook.output.transcript` | `true` | Append every run of a cell to `<runbook>.transcript.log` as its output arrives (command, output, exit, time; redacted), and checklist items ticked. `transcriptFolder` (`.md-runbook` next to the runbook; empty = beside it) and `transcriptExtension` (`.transcript.log`) say where. User settings only. |
| `mdRunbook.output.maxLines` | `2000` | Max lines written per output (head + tail kept). `0` = unlimited. |
| `mdRunbook.output.stripAnsi` | `true` | Strip ANSI escape codes from written output. |
| `mdRunbook.output.colorLevels` | `true` | Colour log levels in the output as log viewers do: `FATAL`/`CRITICAL` purple, `ERROR`/`FAILED` red, `WARN` yellow, `INFO`/`NOTICE` blue, `DEBUG` grey, `TRACE` light blue, `OK`/`PASSED`/`SUCCESS` green. Display only. |
| `mdRunbook.output.stderrInRed` | `true` | Show stderr in red, also when the file is opened again (the block's `stderr=` lists those lines). |
| `mdRunbook.output.cloudViews` | `true` | AWS / Google Cloud JSON output (EC2, EKS, Compute Engine, GKE, Cloud Run) gets a table with a console link per resource. Display only. |
| `mdRunbook.output.forceColor` | `false` | Cells get `FORCE_COLOR=1` and `CLICOLOR_FORCE=1`, so programs colour their output although it isn't a terminal. |
| `mdRunbook.redaction.enabled` | `true` | Redact secrets before writing output. |
| `mdRunbook.redaction.useDefaultPatterns` | `true` | Use the built-in patterns listed above. |
| `mdRunbook.redaction.patterns` | `[]` | Extra regexes (strings or `{ pattern, flags }`). |
| `mdRunbook.redaction.applyToLiveOutput` | `true` | Also redact the output shown in the editor. |
| `mdRunbook.execution.stopOnFailure` | `true` | Run All stops at the first failed cell. |
| `mdRunbook.execution.launchForm` | `true` | Run All first opens the launch form in the Steps view when the runbook has a parameter, an input, a secret not stored or a risky step. Off: Run All asks for the values in boxes. |
| `mdRunbook.execution.followRun` | `true` | Run All scrolls the cell about to run into view while you follow it (scroll away to stop). |
| `mdRunbook.notifications.enabled` | `true` | A notification when a run ends or waits for you while you're in another editor or window. A run of one cell notifies after `notifications.afterSeconds` (30); `notifications.system` (off) also uses the system's notification centre. |
| `mdRunbook.estimates.learn` | `true` | A block without `estimate=` learns its usual time from its runs that passed (`est. ~1m15s`), kept on this machine. |
| `mdRunbook.execution.timeoutSeconds` | `0` | Kill a cell's process tree after N seconds. `0` = no timeout. |
| `mdRunbook.execution.refreshPath` | `true` | Windows: add the `PATH` directories installed since VS Code started to each cell. |
| `mdRunbook.execution.kubeContextPin` | `true` | Runbooks with `kube-context-mode: pin` run their cells against their `kube-context` (a `KUBECONFIG` that sets only the current context, then yours). Off: they are only checked. User settings only. |
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
- Two adjacent Markdown cells merge into one on reopening, since the file has no cell boundaries
  between Markdown paragraphs.
- Fences are recognized at any indentation (so blocks in lists work). Blocks inside blockquotes
  (`> ```sh`) are not runnable.
- Fences nested inside another fence (e.g. a ```` ````markdown ```` example) are not cells.
- An unclosed fence makes the rest of the file Markdown, as in CommonMark.
- The file must be valid UTF-8 for a byte-identical round trip.

## Troubleshooting

- **A runbook opens slowly or stays empty** when the computer is busy. It is a VS Code notebook
  behaviour. Start VS Code with `--disable-renderer-backgrounding`
  ([details](docs/troubleshooting.md#a-runbook-opens-slowly-or-stays-empty)).

## Development

```sh
npm ci
npm test                  # compile + unit, round-trip, fuzz, redaction and shell smoke tests
npm run test:integration  # end-to-end tests in a downloaded VS Code
```

- **Shared core:** the parser, serializer, cell options, checks and redaction live in
  `packages/core` (`@md-runbook/core`, an npm workspace). They never import `vscode` or Node
  modules, so the phone and web app can use them too. Running local processes is in
  `@md-runbook/core/node`.
- **VS Code layer:** `src/serializer.ts`, `src/controller.ts` and `src/extension.ts` are thin
  adapters over the core.
- **Smoke tests:** these run real shells and skip any shell that isn't installed. On Windows they
  exercise `pwsh`/`powershell.exe` and `cmd` natively. Set `MD_RUNBOOK_PWSH` / `MD_RUNBOOK_BASH`
  to test a specific executable.
- **CI** runs everything on Windows, macOS and Linux.

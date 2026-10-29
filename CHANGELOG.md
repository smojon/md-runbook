# Changelog

## 0.15.0

- **Line buttons on the cell's status line.** The run buttons of the line the cursor is on
  (**Run line**, **Run lines 1-N**, **Run lines N-end**, **Step from here**) are also under the
  cell, and stay while the cell is selected: click in the line, then on the button. The hover
  was hard to reach on a cell's first lines, where VS Code draws it above the cell and closes it
  as soon as the mouse leaves the cell's text. Reported by the user.

## 0.14.1

- **The hover's line buttons work on Windows.** Clicking **Run line**, **Run lines …**, **Step from
  here**, **Check**, **Breakpoint** or **Copy** said *open a runbook and pick a code cell first*:
  VS Code decodes a command link's arguments twice, so the cell's address arrived with `c:` for
  `c%3A` and was not found. The ▶ ☐ buttons (`lines.buttons: inline`), the right-click menu and
  Ctrl+Alt+Enter were not affected.

## 0.14.0

- **The transcript in the menus.** **Run ▾ › Open Transcript** opens `<runbook>.transcript.log`
  beside the runbook (it grows as later runs append); **Run ▾ › Transcript** turns it off or on
  (a check mark while on; the user setting `mdRunbook.output.transcript`). Before, only someone
  who knew the setting's name could turn it off.
- **Help ▾ › Settings…** opens md-runbook's settings, so every one can be found from a menu.
- **`md-runbook run --section` refuses a section that matches the runbook's title**: the title
  holds every step, so `--section "6."` for `## 6. The scheduled check` also matched
  `# 6. Are the backends up?` and ran the whole runbook. The message names the heading meant and
  how to say it (`--section "6. The"`).

## 0.13.0

- **Saved output is what the terminal showed.** Carriage returns overwrite from the first
  column (`abcdefXY` was saved as `XY`, a terminal shows `XYcdef`), backspaces and the
  erase-line, cursor up/down/forward/back, column and save/restore sequences are applied, so a
  spinner or a multi-line progress display is saved as it ended instead of every frame; other
  control characters, which showed as odd symbols, are dropped. Clearing the screen keeps what
  was printed. Colours are stripped as before.
- **Python's `é` and `✓` on Windows.** A Python script's output was saved as `�` (and a `✓`
  stopped it with `UnicodeEncodeError`): Python writes to a pipe in the ANSI code page
  (cp1252). Cells on Windows now get `PYTHONIOENCODING=utf-8`, unless `PYTHONIOENCODING` or
  `PYTHONUTF8` is already set. Reported by a tester as a difference between the terminal and
  the runbook.

- **Transcript** ([details](docs/features/history.md#transcript)): every run of a cell is
  appended to `<runbook>.transcript.log` next to the runbook as its output arrives: a header
  (time, step, heading, name), the script, each output line (`| ` stdout, `! ` stderr), each
  retry, and a footer (exit, duration, check, attempt), plus checklist items ticked by clicking.
  It is on disk even if the runbook is never saved, so a run can be followed with `tail -f` and
  read afterwards. Redacted like a saved runbook; a `capture-secret=` cell is written when it
  has finished. Past 10 MB the file starts again (one older kept as `.1`). **On by default**, the
  one default that is not the most secure choice: add `*.transcript.log` to `.gitignore`, or
  turn it off with `mdRunbook.output.transcript`. `transcriptFolder` and `transcriptExtension`
  say where and how it is named (user settings only). The command line writes one with
  `--transcript FILE`.

## 0.12.0

- **Command line: part of a runbook** ([details](docs/features/cli.md#part-of-a-runbook)).
  `md-runbook run --from 6` resumes a long run at the step it stopped at, numbered as the run's
  `▶ Step N` lines number them (the same with or without a range), `--to 9` ends earlier, and
  `--section "3."` (repeatable) runs only the steps under the headings that start with that
  text, sub-headings included. The steps left out are skipped and keep their outputs. A range
  outside the runbook, a section that matches no heading, or a selected step whose
  `${out:NAME}` is captured only by a step left out stops the run before it starts (exit code 2).
- **Command line: cells that need `--yes` are found before the first step.** Without `--yes`, a
  run that has a risky command or a `confirm` block it would run (for this OS, in the selected
  steps) now stops before anything runs, with exit code 2 and a list of those steps and why,
  instead of after the steps before them. With `--keep-going` they are declined where they are,
  as before. Nothing more runs without `--yes` than before.
- **Pin the Kubernetes context** ([details](docs/features/kubernetes.md#check-or-pin)):
  `kube-context-mode: pin` in the front matter makes the runbook's and its cells' `kube-context`
  the context their cells run against, instead of only checking it. Each cell run in VS Code or
  on the command line (isolated or in a session) gets a `KUBECONFIG` whose first file only says
  `current-context: NAME`, followed by your own kubeconfig, so kubectl, helm and k9s use that
  context without `--context` flags and without changing your default context. No credential is
  copied, a `use-context` in a cell only changes the temporary file, and the file is removed when
  the run ends or the runbook closes. Before each cell md-runbook checks that your kubeconfig has
  the context. Cells on an SSH host (`host=`, the app) are still only checked, and lint warns.
  The user setting `mdRunbook.execution.kubeContextPin` turns pinning off.
- **`git-bash-path-conversion: off`** in the front matter: on Windows, Git Bash no longer rewrites
  arguments that look like POSIX paths (`kubectl exec pod -- cat /opt/x` reaching kubectl as
  `C:/Program Files/Git/opt/x`) in the runbook's bash cells. It sets `MSYS_NO_PATHCONV=1` and
  `MSYS2_ARG_CONV_EXCL=*`; other shells and systems are unchanged.
- Lint knows both front matter keys and reports values it ignores.
- **md-runbook-probe** ([guide](docs/features/kubernetes.md#is-everything-up-endpoint-and-certificate-checks)):
  - **Behaviour change: `--ca FILE` now adds to the system's CAs** instead of replacing them, so
    a cluster's CA and public endpoints are trusted in the same run (before, public endpoints
    failed with *certificate not trusted: unable to get local issuer certificate*). `--ca-only
    FILE` is the old behaviour: only that CA is trusted.
  - **`--format json`** (one object per target and line: target, ok, address, reachable,
    tcp_ms, tls, trusted, not_after, days_left, subject, issuer, detail, labels) and **`--format
    prometheus`** (`md_runbook_probe_ok`, `md_runbook_probe_reachable`,
    `md_runbook_probe_certificate_expiry_timestamp_seconds`,
    `md_runbook_probe_last_run_timestamp_seconds`, labelled `target="host:port"`). The text
    lines stay as they were. **Labels:** `--label NAME=VALUE` adds a label to every metric and
    JSON object, and `NAME=VALUE` words after a target label that target only (on stdin: the
    targets on that line), over a `--label` of the same name, e.g. `tls://idm-web:8989
    component=proxy`. So one scrape tells components apart; the same endpoint with other labels
    is another series.
  - **`tls://host:port` and `tcp://host:port` targets** check TLS on any port, or never, per
    target.
  - **Audit outside the gate.** Where no gate runs the probe (no `/etc/md-runbook/gate.conf`,
    e.g. `kubectl exec` into a Pod), `MD_RUNBOOK_PROBE_LOG` names where its events go: a file,
    `stderr` or `syslog`; in a container `/proc/1/fd/1` is its log. Where the gate runs it,
    `gate.conf` alone decides, as before. A destination it can't write is reported once on
    stderr instead of being skipped silently.
- **The probe image** `ghcr.io/smojon/md-runbook-probe` ([apps/probe](apps/probe/README.md)):
  md-runbook-probe alone, without sshd, the gate or kubectl, non-root, published with each
  release next to the ops host image. Its example manifest runs the probe as a Pod next to your
  services, publishing the checks as Prometheus metrics, without a service account token and
  with a read-only root filesystem.

## 0.11.0

- **Kubernetes** ([guide](docs/features/kubernetes.md)):
  - **Wrong-cluster guard.** `kube-context: prod-eu` in the front matter, or `kube-context=` on
    a cell, means a cell runs only while `kubectl config current-context` is that context. The
    check runs where the cell runs, before each cell: in VS Code, on the command line, and in
    the app over SSH. md-runbook-gate answers the check (its new `context` request) also where
    only signed runbooks run.
  - **The ops host** ([apps/ops](apps/ops/README.md)). An SSH server whose only command is
    md-runbook-gate, with kubectl, as a container image. Run it inside a cluster (a manifest
    with its own service account and a restricted ClusterRole, Pod Security `restricted`) or
    next to the relay (`docker compose --profile ops`). The app reaches your clusters through
    it, and no cluster credential is ever on a phone.
  - **md-runbook-probe** on the ops host checks, from inside the cluster, that each endpoint
    resolves, accepts a TCP connection and has a TLS certificate that is trusted, is for that
    name and doesn't expire within 14 days. It accepts only host names, addresses and URLs as
    targets. Every check is a `probe` event in the gate's log, tied to the signed run that made
    it, and `md-runbook audit` lists these events. Export Report and the JSON export show a
    record's checks under **Endpoint checks**.
  - An example runbook: [examples/kubernetes.runbook.md](examples/kubernetes.runbook.md).
- **Incident records for audits and postmortems:** **Start Incident** (Run ▾, and ⋯ More in the
  app) makes a dated copy with `incident:` and `severity:` in its front matter and a first note,
  *detected*. Such a runbook (also `evidence: true`, or the setting
  `mdRunbook.output.recordRunner`) records on every run who ran it (`by=`) and where (`on=`), and
  keeps every attempt. **Add Note** records a decision or a milestone (*detected*, *mitigated*,
  *resolved*) with the time and your name. Export Report (HTML, PDF, the command line's
  `--report`/`--pdf`, the app) then starts with the incident record: start, end, time to
  mitigate and to resolve, the `rto:` target met or missed, failed runs, people and machines,
  and a timeline of every run, attempt, mark and note in time order; printed, every page shows
  the incident and a page number. The command line's `--json` carries the same record.
- **Hosts for teams and providers (app)** ([details](docs/app.md#hosts-and-the-apps-key)): host
  groups with a filter, **Run on a Group…** (one cell on every host of a group, a section per host),
  **Share hosts** as a file or QR code and **Import…** (never a private key; the sender's host keys
  only if you trust them), and **Install my key…** (one password login adds the app's key).
- **Drills and training** ([details](docs/features/drills.md)): **Start Incident** can start a
  drill (`drill: true`; the report says *Drill record* and measures it against `rto:`), and in
  the app **Practice on a Host…** (or `practice: NAME`) runs every cell on a practice server,
  whatever `host=` says; nothing runs if that host is missing.
- **`md-runbook audit`** ([for auditors](docs/features/for-auditors.md)): what servers with
  md-runbook-gate ran, from their logs: every run with the key, account, client, runbook,
  signer, parameters, exit code and duration, and the findings (refusals, unsigned code, stopped
  runs), as HTML, PDF or JSON; `--record` matches a saved run record against the log.
- **Request Co-signature** (Share ▾, ⋯ More → Share in the app): a message with a link that opens
  the signed runbook on Co-sign Runbook in the reviewer's app (VS Code links the pushed file,
  pinned; the app puts the runbook in the link); `md-runbook link --cosign` prints one.
- **Sign Run Record** (Share ▾, ⋯ More in the app, `md-runbook sign --record`): vouch for the
  record of an incident or a drill as it happened, outputs and notes included; a second person
  co-signs it. Export Report shows who signed and whether the record changed since, and
  `md-runbook verify --allowed-signers` checks each signature.
- **Export Run Record (JSON)** (Share ▾, ⋯ More → Share in the app): the timeline, its summary and
  the record's signature as `<name>.record.json`, redacted as the report is, for audit and ticket
  tools.

- **Runbook links:** one link format for Open in the App, QR codes, pager alerts and co-sign
  requests ([details](docs/switching.md#runbook-links)): `sha256=` pins the content (the app
  refuses any other text), `host=` picks a host the app has, `p.NAME=` fills a parameter,
  `action=cosign` opens on Co-sign Runbook, and `rb=` carries a small runbook in the link itself
  (no network needed). Nothing runs from a link. The app shows whether what it opened is signed,
  pinned or neither; **Hosts & settings → Links** can refuse runbooks that aren't signed. **Open in
  the App** now pins the pushed file.
- **`md-runbook link`** prints a runbook link for a pager alert ([on call](docs/features/on-call.md):
  Alertmanager, PagerDuty and Opsgenie examples).
- **QR codes** ([details](docs/switching.md#qr-codes)): **Share ▾ → Make QR Code** writes
  `<name>.qr.svg` for the pushed file (pinned) or the runbook itself (no network needed), with an
  optional host and parameter values; `md-runbook qr --labels hosts.csv` prints a label sheet
  with one code per machine (HTML or PDF). In the app, **Scan a code** on the start screen opens
  a code like a link, and **⋯ More → Share → Show QR Code** shows a code for another phone.

- **The app's own icon and a new look:** the app and the web app's favicon use the extension's
  icon (Android's adaptive and themed icons included). The start screen has the icon in its
  header, **Hosts & settings** as the gear at the top right, **Open a runbook…** and **Open a
  link…** side by side (they no longer run off a narrow phone), and the runbooks as a card with
  each one's file. Hosts & settings shows the hosts as a card ending with **Add a host**, and
  each setting in its own card. The "Core OK" line is gone: the app only says something when its
  self-check fails. An **App APK** workflow builds an arm64 APK to install on an Android phone
  by hand.
- **Terminal mode shows what runs.** Before a cell runs in a terminal, its commands appear there
  as typed at a prompt (`$ `, `PS> `), so whoever watches the terminal sees the cell's commands,
  not only the line that starts its script. They show as written, `${secret:…}` references
  included, never a value, and they are not part of the cell's output, its checks or the saved
  file. Useful for teaching: `terminal.mode: always` runs every cell visibly.

## 0.10.0

- **The front matter isn't drawn in the notebook:** a runbook's YAML front matter showed as a
  `params: • …` list above its title; now the notebook hides it, as VS Code's Markdown preview and
  the app do (editing the first cell still shows it). The README GIF shows the notebook that way.
- **Signing in the app:** **Sign Runbook** and **Co-sign Runbook** (⋯ More) sign with the app's
  own key, inside the phone's Secure Enclave or Android Keystore, in the same OpenSSH format as
  VS Code and the command line, so md-runbook-gate checks them the same way: a reviewer can
  co-sign from a phone. A card asks what VS Code asks (name and scopes the first time, days of
  validity, missing patterns). **Hosts & settings → Signing runbooks** holds your name for
  signatures and the key's line for the servers' `allowed_signers`, with Copy.
- **A runbook can choose its shell:** front matter `shell: zsh` or `shell: sh` runs its `sh`/`bash`
  cells in zsh or POSIX sh, `shell: pwsh` its PowerShell cells in PowerShell 7 only, and
  `shell: windows-powershell` in Windows PowerShell 5.1 even when 7 is installed (`shell: zsh,
  windows-powershell` for both). Only names of installed shells, never a path. In VS Code, the
  command line and the app (which starts that shell on the server); in sessions and terminal
  mode too. A missing shell is an error on the cell. With `shell: zsh`, an assistant's proposal is
  never approved by the allowlist alone, and earlier approvals no longer count (in the app, a
  proposal approved as bash also doesn't run where the server's login profile starts zsh); Sign Runbook
  refuses a Unix shell other than bash (servers run signed runbooks in bash). Lint warns about
  names it ignores.
- **App look and feel, from a screen-by-screen check:** iOS-style toggles on every platform;
  sheets with a grabber, rounded corners, and a raised colour and stronger dim in dark mode; a
  focused field's border in the accent colour on the web (no thick black ring); placeholders
  lighter than typed values; output lines no longer wrap (tables and JSON keep their shape,
  wide output scrolls sideways); why a cell can't run on its own line under the cell; the
  front matter no longer drawn as a list (its values are in the Parameters card); the browser's
  relay notice is a quiet line with a link to set it up; a runbook or link opened directly has
  a back arrow; the link screen has a title and a way back after an error; Hosts is now
  **Hosts & settings**.
- **Cloud console views:** JSON from the AWS or Google Cloud CLI gets a table of its resources
  under the output, each with a link to it in the console: EC2 instances, EKS clusters,
  Compute Engine instances, GKE clusters, Cloud Run services (recognized by the JSON's shape).
  Display only; setting `mdRunbook.output.cloudViews` (on), and in the app under Hosts & settings.
- **Two signers for signed runbooks (four eyes):** a reviewer adds a signature to the signed
  manifest with **Co-sign Runbook** or `md-runbook sign --cosign`, unchanged; md-runbook-gate with
  `signers = 2` (or `--signers=2` on a key) runs only runbooks signed by two distinct trusted
  signers. `verify --allowed-signers` checks every signature; the app shows all signers.
- **Version floors:** `floors = FILE` in gate.conf (`ops/restart-api 7`) refuses older versions
  of a runbook at once, instead of listing each one's hash in `revoked`.
- **Terminal mode for `cmd` cells:** they run from a PowerShell terminal (cmd.exe has no shell
  integration), each in a `cmd.exe` of its own, so prompts like `set /p`, `pause` or `choice` can
  be answered there; `terminal.mode: always` now includes them.
- **Signed runbooks can use `${input:NAME}` and `${out:NAME}`**, each with a pattern like a
  parameter: the app sends the typed or captured value to md-runbook-gate, which checks it
  against the signed pattern. Sign Runbook asks for the missing patterns. Secrets
  (`${secret:}`, `${input:NAME:secret}`, `capture-secret=` values) still can't be signed: the
  gate logs the values it gets.
- **stderr shows in VS Code.** What a cell wrote to stderr was saved but never shown: VS Code
  draws one item of each output, and the stderr items sat next to stdout ones. Now each stretch
  of one stream is an output of its own, in order.
- **Coloured output, in VS Code and the app:** stderr in red, also when a runbook is opened again
  (the output block's new `stderr=` attribute lists those lines), and log levels in the colours
  log viewers use (Grafana's levels, VS Code's log rules, syslog, Nevis, klog): `FATAL` purple,
  `ERROR`/`FAILED` red, `WARN` yellow, `INFO`/`NOTICE` blue, `DEBUG` grey, `TRACE` light blue,
  `OK`/`PASSED`/`SUCCESS` green. A program's own ANSI colours win; the file keeps plain text.
  New settings `mdRunbook.output.colorLevels`, `stderrInRed` (both on) and `forceColor` (off:
  asks programs for colours with `FORCE_COLOR=1`, `CLICOLOR_FORCE=1`); the app has the same.
- **The app runs runbooks on Windows servers** (OpenSSH Server): `pwsh`, `powershell` and `cmd`
  cells, with nothing to set up. The app finds Windows PowerShell there by itself; PowerShell
  cells share one session (variables, functions, the folder), `cmd` cells each run in a
  `cmd.exe` of their own, as in VS Code. `os=` blocks follow the server, and Hosts shows what
  each server runs.

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
- **Deleted and reordered signed blocks are reported.** Blocks match their signature by content,
  so removing a backup step or swapping two `cd` blocks showed "0 changed". Lint, the editor,
  `verify` (which now fails) and the app name the missing blocks and the moved ones.
- **Signing refuses blocks GitHub doesn't show as code:** a bash block inside an HTML comment, or
  fences indented 4 spaces or more, which a reviewer of the rendered pull request would miss.
- **The app doesn't take a signed block's parameter values from the front matter**, which isn't
  signed: they are typed on the runbook.
- The signature block is the last one outside code blocks (an example in a code block isn't
  read as the signature); a repeated command (two `sleep 5`) runs as the right signed step.
- **The app gives each runbook its own shell on a host.** One shell per host was shared by every
  runbook, so a cell of one runbook could print another's secrets or redefine the commands the
  next cells run with. A secret given to an earlier cell is also redacted from later cells.
- **`host=` asks before it switches hosts.** A cell naming a host other than the selected one
  waits for a yes (once per host while the runbook is open); approval cards name the cell's host.
  Run all waits at that question, and at the trust and missing-value questions, instead of
  going on to the next cell.
- `autorun=1` in a link no longer starts Run all (only Run All as Copy does); the gate passes
  unsigned text to the shell without writing it (with its secrets) to disk; a link's runbook
  is refused by its size before it is read; the relay's `*:22` reaches public hosts only.

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

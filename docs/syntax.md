# Runbook syntax reference

Everything md-runbook reads from or writes into a `.md` file, on one page. It is written from the
parser, so it says what the code accepts; the feature pages linked from the
[README](../README.md#more-features) explain how each part behaves and how to turn it on.

A runbook is an ordinary Markdown file. md-runbook only cares about three things in it:

1. **fenced code blocks** whose language is a shell (`sh`, `bash`, `pwsh`, `powershell`, `cmd`):
   these are the **cells** that run; options go on the fence line;
2. **output blocks** it writes after a cell when the cell has run;
3. an optional **front matter** at the top with runbook-wide defaults and parameters.

Everything else is Markdown and is kept byte for byte. A file with no md-runbook syntax at all is
a valid runbook: every shell block is a runnable step.

````markdown
---
mode: isolated
timeout: 300
params:
  - NAMESPACE
  - REGION: eu-west-1
---

# Roll out the web service

Check the pods first.

```bash name="List pods" expect=/Running/ retry=10 every=15s capture="POD:/^(web-\S+)/m"
kubectl get pods -n "${param:NAMESPACE}" -l app=web
```

```bash timeout=60 continue-on-error
kubectl logs "${out:POD}" -n "${param:NAMESPACE}" --tail=20
```

```pwsh os=windows
Remove-Item "$env:LOCALAPPDATA\app\cache" -Recurse -Force
```

```bash os=linux,macos
rm -rf ~/.cache/app
```

```bash proposed by=ai reason="check the ingress before the restart"
kubectl get ingress -n "${param:NAMESPACE}"
```
````

## Cells

A cell is a fenced code block as in CommonMark, with these rules:

- The fence is three or more backticks or tildes. The closing fence uses the same character and
  is at least as long. Any indentation is allowed, so blocks inside lists work.
- The **info string** is everything after the opening fence. Its first word is the language;
  the cell runs only when that word is exactly `sh`, `bash`, `pwsh`, `powershell` or `cmd`
  (lower case). Any other language (`yaml`, `text`, `python`, …) is plain Markdown.
- A backtick fence whose info string contains a backtick is not a fence (CommonMark).
- Blocks inside a blockquote (`> ```bash`) are not cells. Fences nested inside another fence
  (for example inside a ```` ````markdown ```` example) are not cells. An unclosed fence makes
  the rest of the file Markdown.
- The file must be UTF-8. A byte-order mark is accepted and kept.

The working directory of a cell is the folder of the `.md` file unless `cwd` says otherwise.
Each cell runs as its own process unless the runbook is in session mode (see `mode:` below).

## The info string

```text
<lang> [token]...
```

Tokens are separated by spaces or tabs. There are three forms:

| Form | Example | Notes |
| --- | --- | --- |
| bare flag | `skip`, `continue-on-error` | no value |
| `key=value` | `timeout=30`, `cwd=../infra` | value ends at the next space |
| `key="value"` or `key='value'` | `name="Rotate token"`, `expect='say "hi"'` | value may contain spaces; it ends at the next same quote; there are **no escape sequences**, so pick the other quote to include one |

- Keys are case-insensitive. The variable name in `env.NAME=` keeps its case.
- Backslashes are literal: `cwd="C:\Program Files\x"` works as written.
- A pandoc attribute block `{…}` is skipped. Anything else that is not a known option is
  ignored; the linter reports it as a warning (`unknown cell option "retires" (ignored)`).
- A known option with an invalid value (`timeout=abc`, `os=dos`, `expect=/(/`) is an error:
  the linter reports it and the cell does not run (`invalid cell option timeout=abc: …`).
- The same key written twice: the last one wins (`capture=` may be repeated and all are kept).

### Options

| Option | Value | Effect |
| --- | --- | --- |
| `timeout=N` | seconds: `30`, `30s`, `0.5`; `0` = none | Kill the cell after N seconds. Per attempt when `retry=` is set. |
| `cwd=PATH` | relative to the folder of the `.md` file, or absolute | Working directory. |
| `continue-on-error` | flag | Run All goes on after this cell fails. |
| `skip` | flag | Never run; recorded as `exit=skipped`. |
| `confirm` | flag | Always ask before running. |
| `no-confirm` | flag | Never ask, even for a risky command. Ignored unless the user enabled it in their settings. |
| `terminal` | flag | Run in a VS Code terminal (interactive). Ignored unless terminal mode is enabled. Never for assistant cells. |
| `env.NAME=value` | any | Environment variable for this cell. |
| `name="…"` | any | Step name, copied into the output marker as `name=`. |
| `expect=MATCH` | text or `/regex/flags` | Cell fails unless the output contains the text / matches the regex. |
| `expect-not=MATCH` | text or `/regex/flags` | Cell fails if the output contains / matches it. |
| `expect-exit=N` | integer | Exit code N counts as success instead of 0. |
| `capture=NAME` or `capture=NAME:/regex/flags` | variable name | Keep stdout (trimmed), or the first group of the first match (the whole match without a group), as `${out:NAME}` for later cells. Several allowed. |
| `capture-secret=…` | as `capture=` | The same, redacted everywhere and never written to disk. |
| `os=LIST` | `windows`, `linux`, `macos`, comma-separated; also `win`, `win32`, `mac`, `osx`, `darwin` | Run only on these systems. Adjacent `os=` blocks with no OS repeated are alternatives of one step. |
| `host=NAME` | a host's name in the md-runbook app; quote it if it has spaces | The md-runbook app runs the block on that host over SSH, whichever host is selected. The VS Code extension and the CLI run cells on the local machine, so they never run such a block: it counts as skipped. |
| `kube-context=NAME` | a Kubernetes context name | Run only while `kubectl config current-context` prints NAME, checked where the cell runs just before it runs; otherwise nothing runs and the cell fails. Overrides the front matter's `kube-context:`. With `kube-context-mode: pin` in the front matter, the cell runs against NAME instead (on this machine; checked only on a `host=`). See [Kubernetes](features/kubernetes.md). |
| `lines=any` | the word `any` | In a signed runbook: servers with md-runbook-gate also run single lines and ranges of this block (otherwise only the whole block, or its commands in order). See [signed runbooks](features/signed-runbooks.md). |
| `retry=N` | integer 1 to 100 | Run up to N times in all until it passes. |
| `every=D` | `15s`, `500ms`, `2m`, or seconds as a number; at most 1 hour | Wait between attempts (default 5 s). Only with `retry=`. |
| `proposed` | flag | The cell was written by an assistant or a colleague and needs approval before it runs. |
| `by=NAME` | word | Who proposed the cell (`ai`, a model name, a person). A cell with `by=` and no approval is a proposal even without the `proposed` flag. |
| `reason="…"` | any | Why it was proposed. |
| `approved-by=NAME`, `approved-at=ISO-TIME` | word, timestamp | Written by md-runbook when the user approves; replaces `proposed`. Stamps that come with a file are not trusted unless the user enabled that. |

**Matchers.** A value that starts and ends with `/` is a regular expression: `/source/flags`,
flags `i`, `m`, `s` (`u` is accepted and changes nothing). Anything else is plain text matched
as an exact, case-sensitive substring. Regular expressions use
[RE2 syntax](https://github.com/google/re2/wiki/Syntax): no look-around, no back-references.
Checks read everything the cell printed (stdout and stderr) without colour codes and with `\n`
line endings; captures read only stdout. Quote a matcher that contains spaces:
`expect="pod Running"`, `capture="POD:/name: (\S+)/"`.

**Passing.** A cell passes when its exit code is 0 (or `expect-exit=N`) **and** every check
passes. With `retry=`, only the last attempt's output is kept.

## Placeholders in cell source

Inside the code of a cell, these are replaced before it runs:

| Placeholder | Value |
| --- | --- |
| `${secret:NAME}` | from the OS keychain (the user stores it once); redacted in outputs |
| `${input:NAME}` | asked from the user once per runbook session |
| `${input:NAME:secret}` | asked once, masked, redacted (also when NAME ends in `_PASSWORD`, `_TOKEN` or `_SECRET`) |
| `${param:NAME}` | a runbook parameter declared under `params:` in the front matter, asked once with its default filled in; on the command line `--param NAME=value` |
| `${out:NAME}` | the value captured by an earlier cell with `capture=NAME` |

- `NAME` is `[A-Za-z_][A-Za-z0-9_]*`. One name is one kind: `${secret:X}` and `${input:X}` in
  the same cell is an error.
- The value never enters the script text. The placeholder becomes the shell's own variable
  syntax (`${NAME}` in bash, `${env:NAME}` in PowerShell, `!NAME!` in cmd) and the value is put
  in the environment. So write it where a variable expands: inside double quotes, not single
  quotes. In a cmd cell with placeholders a literal `!` must be written `^^!`.
- The file keeps the placeholder. `${env:NAME}` is PowerShell syntax, not a placeholder.
- Placeholders work only in cell source, not in option values or Markdown.

## Front matter

Optional. The first line of the file must be `---`; the block ends at the next `---` or `...`
line. Only these keys are read; every other key (`title:` and so on) is ignored and kept:

```yaml
---
mode: session        # session | isolated (default: the user's setting)
timeout: 300         # seconds for every cell: 300 or 300s; a cell's timeout= wins
cwd: ../infra        # folder cells run in, relative to the .md file; a cell's cwd= is still relative to the .md file
shell: zsh, windows-powershell   # which installed shells run the cells (see below)
incident: INC-1234   # this file is the record of an incident (Start Incident writes it); implies evidence
severity: SEV2       # the incident's severity, as you name them
evidence: true       # every run records by= and on=, and every attempt is kept (also implied by incident:)
rto: 30m             # recovery time objective: 90s, 30m, 1h30m or seconds; the report says met or missed
drill: true          # the record is a drill or exercise (the report says Drill record)
practice: training-1 # the app runs every cell on this host, whatever host= says (drills, training)
kube-context: prod-eu # every cell runs only while kubectl's current context is prod-eu; a cell's kube-context= wins
kube-context-mode: pin # check (default) | pin: cells run on their kube-context without changing your default context
git-bash-path-conversion: off # on (default) | off: Git Bash on Windows leaves /opt/x-style arguments alone
params:
  - NAMESPACE        # asked, no default
  - REGION: eu-west-1
  - REPLICAS: "3"    # quotes are removed
---
```

`#` starts a comment. A value that is not understood (`mode: sometimes`) is ignored with a lint
warning.

`kube-context:` is a guard against the wrong cluster. Before each cell, `kubectl config
current-context` runs where the cell would run: the session shell, or the app's SSH host,
through md-runbook-gate if the host has one. The cell runs only if that prints the name.
Otherwise nothing runs and the cell fails with both names: VS Code and the command line record
it as `exit=error`, and the app shows the reason on the cell. A `kubectl config use-context` in
an earlier cell is therefore caught too. The front matter isn't signed, so in
a signed runbook put `kube-context=` on the cells themselves.

`kube-context-mode: pin` makes the runbook's and its cells' `kube-context` the context the
cells run against instead of only checking it: each cell run on this machine (VS Code and the
command line) gets a `KUBECONFIG` whose first file only says `current-context: NAME`, followed by
your own kubeconfig list (`$KUBECONFIG`, else `~/.kube/config`). kubectl, helm, k9s and other
client-go tools then use NAME, your default context is never changed, and no credential is
copied. Before each cell md-runbook checks that your kubeconfig has NAME. A cell with no
`kube-context` gets your own list. Cells on an SSH host (`host=`, the app) are only checked; lint
warns. The user setting `mdRunbook.execution.kubeContextPin` (on by default) turns pinning off,
and such runbooks are then only checked. See [Kubernetes](features/kubernetes.md#check-or-pin).

`git-bash-path-conversion: off` stops Git Bash on Windows from rewriting arguments that look like
POSIX paths when a bash cell starts a Windows program (`kubectl exec pod -- cat /opt/x/probe.sh`
would otherwise get `C:/Program Files/Git/opt/x/probe.sh`). It sets `MSYS_NO_PATHCONV=1` and
`MSYS2_ARG_CONV_EXCL=*` for the runbook's `sh`/`bash` cells on Windows; it changes nothing for
PowerShell and cmd cells or on other systems. The default stays `on` because some commands rely
on the conversion (a Windows program given `/c/Users/me/file` needs `C:/Users/me/file`).

The runbook view (VS Code and the app) doesn't draw the front matter, as VS Code's
Markdown preview doesn't; editing the first cell shows it. In session mode one bash and one PowerShell process live for the whole runbook, so
`cd`, exported variables and `oc login` carry over between cells; `cmd` cells always run alone.

`shell:` names, separated by commas or spaces, at most one of each kind:

| Name | Runs the runbook's | Found |
| --- | --- | --- |
| `bash` (default) | `sh` and `bash` cells | as without `shell:`, but sh doesn't stand in for a missing bash |
| `zsh` | `sh` and `bash` cells | `zsh` on the `PATH` (on Windows a native one such as MSYS2's; WSL's is never used) |
| `sh` | `sh` and `bash` cells | `/bin/sh`; on Windows Git for Windows' `sh.exe` |
| `pwsh` | `pwsh` and `powershell` cells | PowerShell 7, with no fallback to Windows PowerShell |
| `windows-powershell` | `pwsh` and `powershell` cells | Windows PowerShell 5.1 even when PowerShell 7 is installed (Windows only) |

Without `shell:`, `sh`/`bash` cells run in bash (Git Bash on Windows, sh if there is no bash) and
PowerShell cells in PowerShell 7, else Windows PowerShell. A missing shell is an error on the
cell, never a silent switch to another one. Only names are read, never a path: a runbook can't
choose a program to run (paths are your settings, `mdRunbook.shell.bashPath` and
`mdRunbook.shell.pwshPath`, which apply to the default shells). Lint warns about names it
ignores.

`shell:` applies to every cell, including an assistant's proposals. With `shell: zsh` a proposal
is never approved by the allowlist alone (zsh reads some text differently from bash: its glob
qualifiers can run commands), and an approval given before the runbook switched to zsh no longer
counts. Signed runbooks run in bash on the server, so Sign Runbook refuses another Unix shell.
The app starts the named shell on the server (`zsh -l`, `sh -l`, or `pwsh` on Windows servers)
and says so on the cell when the server doesn't have it.

## Output blocks

When a cell has run and the file is saved, its output is written directly after the code block.
This is the only structure md-runbook recognizes; anything else stays Markdown:

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

- The start marker must follow the cell's closing fence (blank lines between them are allowed).
  Attributes are `key=value` or `key="value"`; keys are `[\w-]+`. Attributes not listed below
  are read and shown too. Running the cell again replaces the whole block, attributes included.
- The output fence is a backtick fence with `text`, longer than any backtick run inside the
  output, so output can never break the document. Its indentation matches the code block's.
- stdout and stderr are merged in arrival order; `stderr=` lists the lines that came from stderr,
  so both clients show them in red again when the file is opened. Before writing, output becomes what a terminal
  would show (carriage returns, backspaces, erased lines and cursor movements applied, other
  control characters dropped), ANSI codes are stripped, secrets are redacted, and long output is
  cut in the middle with `… [md-runbook: N lines truncated] …`.
- Re-running a cell replaces its block. Blocks of cells that did not run are kept byte for byte.
- The status line shown in the editor (`exit code 0 · 1.2s · bash`) is not in the file.

### Marker attributes

| Attribute | Value |
| --- | --- |
| `exit` | `0` or another exit code; `timeout`; `cancelled`; `error` (the shell could not start); a signal name such as `SIGKILL`, or `unknown`; `skipped` (the `skip` option or marked skipped); `done` (marked done by hand); `declined` (a confirmation was refused); `proposed` (an unapproved proposal that Run All passed over) |
| `ran`, `ended` | start and end, local time with UTC offset (`2026-10-18T14:20:00+02:00`) |
| `duration` | elapsed seconds with millisecond precision, `1.234s` |
| `name` | the cell's `name=` option |
| `check` | `ok` or `failed`: the result of `expect=` / `capture=` checks. Progress follows it over the exit code |
| `attempts` | the number of attempts made with `retry=` |
| `changed` | `yes` or `no`: whether the output differs from the previous run (absent on a first run) |
| `lines` | the 1-based lines of the cell that ran (`2-3`), when not the whole cell ran; such a step is not done yet |
| `stderr` | the 1-based lines of the output that came from stderr (`3,5-7`); absent when none did |
| `proposed-by`, `approved-by` | audit trail of an approved assistant cell |
| `by` | the OS user who marked the step done or skipped by hand (the output body is `[md-runbook] marked done by NAME`); and, when the runbook keeps evidence (`incident:`, `evidence: true`, or `mdRunbook.output.recordRunner`), who ran it: the OS user in VS Code and the command line, the name for signatures in the app |
| `on` | where it ran, when the runbook keeps evidence: `user@machine` in VS Code and the command line, the SSH account `user@host` in the app |
| any other, e.g. `context`, `server` | the first output line of a context command configured by the user (`kubectl config current-context`), recorded before the cell ran |

### Output history

With history enabled, earlier runs follow the latest output block in a collapsed block, newest
first. Only this exact shape is recognized:

````markdown
<!-- md-runbook:output end -->
<details><summary>md-runbook: 2 previous runs</summary>

<!-- md-runbook:output start exit=1 ran=… ended=… duration=0.640s -->
```text
error: You must be logged in to the server (Unauthorized)
```
<!-- md-runbook:output end -->

</details>
````

A runbook that keeps evidence (`incident:` or `evidence: true`) keeps every attempt (up to 100 per
step) whatever the history setting, in VS Code, the app and the command line.

### Notes

**Add Note** (and **Start Incident**, for when the incident was detected) writes a note: a marker
with the time, the author and an optional milestone (`detected`, `mitigated`, `resolved`), then a
quote. Anywhere in the Markdown; Export Report puts notes in the timeline by their time.

```markdown
<!-- md-runbook:note at=2026-10-26T22:08:00+01:00 by=ana milestone=mitigated -->
> **22:08 · mitigated · ana:** Failover done; errors back to 0
```

## Steps and progress

A runbook's **steps** are its cells plus GitHub task-list items in Markdown (`- [ ]`, `* [x]`,
`1. [ ]`; not inside code blocks). A cell is:

- **done** with `check=ok`, `exit=0` or `exit=done` (and no `lines=`);
- **skipped** with `exit=skipped`;
- **pending** with no output, `exit=declined`, `exit=proposed`, or a partial `lines=` run;
- **failed** with `check=failed` or any other exit.

A group of adjacent `os=` blocks is one step, judged by the block for the current OS. A
`host=` block is skipped in the extension and the CLI. Run All
runs cells in order and stops at the first failure unless the cell has `continue-on-error`.
Cells of one runbook never run concurrently.

## Proposed cells and approval

Anything an assistant writes must be a proposal. The user approves it in the editor, which
rewrites the fence line; md-runbook then records the audit trail in the output marker:

````markdown
```bash proposed by=ai reason="list pods in the namespace"
kubectl get pods -n checkout
```
````

After approval the fence reads ```` ```bash approved-by=smojon approved-at=2026-10-18T17:20:00+02:00 by=ai reason="…" ````.
An approval is bound to the code, the fence options and the file; editing any of them needs a
new approval. A command policy (`.md-runbook-policy.json` next to the runbook) can block or flag
commands before they are approved. Approved assistant cells never run in a terminal or a shared
session, and values they capture are not used by the user's own cells.

## Signature block

`md-runbook sign` (or **Sign Runbook** in VS Code) writes one HTML comment at the end of the
file; it is invisible on screen and kept byte for byte like the rest of the Markdown:

```
<!-- md-runbook:signature v1 signer=NAME signed=YYYY-MM-DD
manifest
BASE64 (wrapped at 76 columns)
signature
BASE64 (wrapped at 76 columns)
-->
```

The manifest is the signed text: `md-runbook-manifest 1`, then one item per line (`name`,
`version`, `expires`, `scope`, `param NAME PATTERN`, and per bash/sh block `cell N all|any`,
`info`, `code`, `needs NAME`, `cwd`, `env NAME VALUE`, `step`), values that can hold anything in
base64, then `end`. `code` and `step` are the block's code and its commands with
`${param:NAME}` written as `${NAME}`. The signature is OpenSSH's SSHSIG over the manifest with
namespace `md-runbook`, without its armor lines. A block is signed while its fence info string
and code equal a manifest cell's; signing again replaces the block. Never write or edit it by
hand: change the runbook and sign it again.

### Run record signature

**Sign Run Record** (VS Code, the app, `md-runbook sign --record`) vouches for a run record, the
file with its outputs, notes and history, as it is. It covers every byte of the file except its
own block (a runbook signature block included), and what is signed is the statement
`md-runbook run record v1\nsha256 HEX\n` with the SHA-256 of those bytes, in the same SSHSIG
namespace, so one allowed_signers file checks both (`md-runbook verify --allowed-signers`); a
statement is never a manifest, so a record signature can't pass for a runbook's. `signed=` is
local time with its offset. Co-signers (`--cosign`) sign the same statement.

```markdown
<!-- md-runbook:record-signature v1 signer=ana@example.net signed=2026-10-26T22:40:00+01:00 sha256=3f0c…
signature
U1NIU0lH…
cosign signer=lead@example.net signed=2026-10-26T22:45:00+01:00
U1NIU0lH…
-->
```

## Writing a runbook as an assistant

- Use only `sh`, `bash`, `pwsh`, `powershell` or `cmd` fences for steps. Put one command or one
  short related group in each block, with a sentence before it saying what it does.
- When adding steps to someone else's runbook, write them as proposals:
  `<lang> proposed by=ai reason="…"`. Never remove the `proposed` flag or write `approved-by=`.
- Never write output blocks yourself: they record what actually ran. Never claim a step ran.
- Never write or change a signature block. Editing a block of a signed runbook makes it unsigned
  (servers that only run signed runbooks refuse it until a publisher signs it again): say so.
- Never put a credential in the code. Reference it as `${secret:NAME}` or `${input:NAME:secret}`
  and let the user supply it.
- Prefer read-only diagnostics. Risky commands (`delete`, `drain`, `rm -rf`, `--force`, …) ask
  the user for confirmation before they run; say in the prose why such a step is needed.
- Make steps self-checking where it helps: `expect=` for the condition that proves the step
  worked, `retry=` and `every=` to wait for a state, `capture=` to hand a value to the next step.
- Use `os=` alternatives for a step that differs between Windows and Unix shells.
- Run `md-runbook lint file.md` (or trust the editor's underlines) to catch unknown options and
  `${out:NAME}` without a capture.

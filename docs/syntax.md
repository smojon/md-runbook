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
params:
  - NAMESPACE        # asked, no default
  - REGION: eu-west-1
  - REPLICAS: "3"    # quotes are removed
---
```

`#` starts a comment. A value that is not understood (`mode: sometimes`) is ignored with a lint
warning. In session mode one bash and one PowerShell process live for the whole runbook, so
`cd`, exported variables and `oc login` carry over between cells; `cmd` cells always run alone.

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
- stdout and stderr are merged in arrival order. Before writing, ANSI codes are stripped,
  carriage-return progress lines are collapsed, secrets are redacted, and long output is cut in
  the middle with `… [md-runbook: N lines truncated] …`.
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
| `proposed-by`, `approved-by` | audit trail of an approved assistant cell |
| `by` | the OS user who marked the step done or skipped by hand; the output body is `[md-runbook] marked done by NAME` |
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

## Steps and progress

A runbook's **steps** are its cells plus GitHub task-list items in Markdown (`- [ ]`, `* [x]`,
`1. [ ]`; not inside code blocks). A cell is:

- **done** with `check=ok`, `exit=0` or `exit=done` (and no `lines=`);
- **skipped** with `exit=skipped`;
- **pending** with no output, `exit=declined`, `exit=proposed`, or a partial `lines=` run;
- **failed** with `check=failed` or any other exit.

A group of adjacent `os=` blocks is one step, judged by the block for the current OS. Run All
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

## Writing a runbook as an assistant

- Use only `sh`, `bash`, `pwsh`, `powershell` or `cmd` fences for steps. Put one command or one
  short related group in each block, with a sentence before it saying what it does.
- When adding steps to someone else's runbook, write them as proposals:
  `<lang> proposed by=ai reason="…"`. Never remove the `proposed` flag or write `approved-by=`.
- Never write output blocks yourself: they record what actually ran. Never claim a step ran.
- Never put a credential in the code. Reference it as `${secret:NAME}` or `${input:NAME:secret}`
  and let the user supply it.
- Prefer read-only diagnostics. Risky commands (`delete`, `drain`, `rm -rf`, `--force`, …) ask
  the user for confirmation before they run; say in the prose why such a step is needed.
- Make steps self-checking where it helps: `expect=` for the condition that proves the step
  worked, `retry=` and `every=` to wait for a state, `capture=` to hand a value to the next step.
- Use `os=` alternatives for a step that differs between Windows and Unix shells.
- Run `md-runbook lint file.md` (or trust the editor's underlines) to catch unknown options and
  `${out:NAME}` without a capture.

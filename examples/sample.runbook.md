---
title: md-runbook test drive
timeout: 600
params:
  - TARGET: staging
  - REPLICAS: "2"
---

# md-runbook test drive

A safe runbook for trying the extension by hand. Nothing here changes your machine: every cell
only prints text, sleeps, lists files or uses a file in the temp folder. Sections 13 to 17 show
line runs, checks and retries, captured values, blocks for one OS, reports and the command line.

Open it with right-click → **Open as Runbook** (or the notebook icon in the editor title bar),
then run cells one by one or use **Run All**. Outputs are written into this file when you save;
use **md-runbook: Clear All Outputs** to reset it, or **Run All as Copy** to keep this file clean.

## 1. Shells

PowerShell (`pwsh`, or Windows PowerShell 5.1 when PowerShell 7 isn't installed):

```pwsh
Write-Output "PowerShell $($PSVersionTable.PSVersion) in $((Get-Location).Path)"
```

Git Bash on Windows, bash on macOS/Linux:

```bash
echo "bash $BASH_VERSION in $(pwd)"
```

cmd (Windows only; on macOS/Linux this cell fails and Run All carries on):

```cmd continue-on-error
echo cmd in %CD%
ver
```

Non-ASCII output should come through intact:

```pwsh
Write-Output "héllo – ✓ – 日本語"
```

This block is JSON, so it stays Markdown and has no run button:

```json
{ "runnable": false }
```

## 2. Live output, cleanup and truncation

Lines should appear one per second, not all at the end:

```bash
for i in 1 2 3 4 5; do echo "tick $i"; sleep 1; done
```

Colours show in the editor but are stripped from the saved file, and the progress line is
saved only in its final state:

```bash
printf '\033[32mgreen\033[0m and \033[31mred\033[0m\n'
for p in 10 40 70 100; do printf '\rprogress %s%%' "$p"; sleep 0.3; done; echo
```

2,500 lines: the saved output keeps the first and last lines with a truncation note between
(`mdRunbook.output.maxLines`, default 2000):

```bash
seq 1 2500
```

## 3. Exit codes and failures

Fails with exit code 3. `continue-on-error` lets Run All go on:

```bash continue-on-error
echo "about to fail"
exit 3
```

A PowerShell terminating error fails the cell:

```pwsh continue-on-error
Get-Item 'C:\does\not\exist\md-runbook' -ErrorAction Stop
```

A non-terminating error alone does not fail the cell (exit 0), as in PowerShell itself:

```pwsh
Write-Error 'boom'
Write-Output 'after'
```

Killed after 2 seconds and recorded as `exit=timeout`:

```bash timeout=2 continue-on-error
echo "sleeping 10s"
sleep 10
echo "you should not see this"
```

Never runs; recorded as `exit=skipped`:

```bash skip
echo "skipped cells don't run"
```

Stop this one with the cell's stop button while it runs; it is recorded as `exit=cancelled`:

```bash continue-on-error
for i in $(seq 1 30); do echo "waiting $i/30"; sleep 1; done
```

## 4. Cell options

Runs in the repository root (`cwd=..`), with an extra environment variable and a name that is
recorded in the output marker:

```bash cwd=.. env.GREETING=hello name="Options demo"
echo "$GREETING from $(pwd)"
ls package.json
```

Environment variables for every cell come from your user settings. This prints `not set` until
you add `"mdRunbook.execution.env": { "MDRB_DEMO": "from settings" }`:

```bash
echo "MDRB_DEMO=${MDRB_DEMO:-not set}"
```

A cell's own `env.` option wins over the setting:

```bash env.MDRB_DEMO=from-the-cell
echo "MDRB_DEMO=${MDRB_DEMO:-not set}"
```

The front matter's `timeout: 600` is the default timeout for every cell of this runbook; a
cell's own `timeout=` (section 3) wins. `cwd:` there would set the folder cells run in.

## 5. Parameters and inputs

`TARGET` and `REPLICAS` come from the front matter; you're asked for them once, with the
defaults pre-filled. **md-runbook: Reset Inputs** asks again.

```pwsh
Write-Output "Deploying to ${param:TARGET} with ${param:REPLICAS} replicas (not really)"
```

Asked once per session:

```bash
echo "Hello, ${input:YOUR_NAME}"
```

Masked and redacted, because the name ends in `_TOKEN`. Type any made-up value; it should show
as `[REDACTED]`:

```bash
echo "the token you typed is ${input:DEMO_TOKEN}"
```

## 6. Secret redaction

Every value below is fake. Each one should be replaced with `[REDACTED]` on screen and in the
saved file:

```bash
echo "password=hunter2-not-real"
echo "Authorization: Bearer abc123.fake.token"
echo "db_url=https://admin:s3cr3t-fake@db.example.com/app"
echo '{"api_key": "fake-key-0000"}'
```

## 7. Confirmation before risky commands

The word "delete" matches a confirmation pattern, so a dialog asks before running. The cell only
prints text. Choose anything but **Run** to see it recorded as `exit=declined` (that also stops
Run All):

```bash
echo "kubectl delete pod demo  # dry run: only printed, nothing is deleted"
```

## 8. Proposed cell

Written as an assistant's proposal: it doesn't run until you approve it (**Approve Proposed
Cell** in the cell's `⋯` menu). Even then, assistant cells only run with read-only credentials,
so with the default settings the approved cell fails with a message explaining how to set them up
(`mdRunbook.approval.readOnlyEnv`) or turn the requirement off (`mdRunbook.approval.readOnlyOnly`):

```bash proposed by=ai reason="Show the current date for the incident log"
date
```

## 9. Manual steps

Checklist items count as steps in the status bar. Tick them with **Check Next Item** or by
editing:

- [ ] Read the output of section 1
- [ ] Confirm secrets are redacted in section 6
- [ ] Save the file and open it as text (**Open as Markdown Text**) to see the output blocks

## 10. Session mode (optional)

By default each cell is its own process, so the second cell prints `unset`. Turn on session
mode with the notebook toolbar toggle and run both again: the second cell then prints `kept`.

```bash
export DEMO_VAR=kept
cd ..
```

```bash
echo "DEMO_VAR=${DEMO_VAR:-unset}, now in $(pwd)"
```

## 11. Interactive prompts (terminal mode)

Normal runs have no input attached, so a prompt gets nothing and moves on at once. To answer
prompts, turn on terminal mode in your **user** settings:

```json
"mdRunbook.terminal.mode": "perCell"
```

Cells marked `terminal` then run in a VS Code terminal that takes the focus: type your answers
there. When the command ends, its output and exit code come back to the cell. The password is
typed straight into the program, so it's never shown or saved.

```bash terminal
read -r -p "Your favourite colour? " colour
echo "You said: $colour"
read -r -s -p "A made-up password (not echoed): " pw; echo
echo "Got ${#pw} characters; the password itself is never printed"
```

Answer `y` to succeed; anything else fails the cell with exit code 1:

```pwsh terminal continue-on-error
$answer = Read-Host "Continue? [y/N]"
if ($answer -ne 'y') { Write-Output 'Stopped by you'; exit 1 }
Write-Output 'Continuing'
```

## 12. Working with an AI assistant

Optional. Nothing is sent anywhere unless you paste it yourself or turn on a provider.

Run this cell first. It prints made-up internal names:

```bash
echo "api-7d4b9c8f6d-x2k9p on db01.corp.acme.lan (10.20.30.40): CrashLoopBackOff"
echo "owner: alice@example.com"
```

**With any chat assistant (no setup):**

1. Click **Copy for AI** in the notebook toolbar. The preview shows how many names were replaced;
   choose **Copy to Clipboard**.
2. Paste it into the assistant. The host, IP and email appear as placeholders such as `host-1`,
   `ip-1` and `user-1@example.invalid` (the numbers carry on across copies in a session), and
   outputs are marked as untrusted data. Names the detector doesn't recognize, such as short
   two-part hostnames, can be added with `mdRunbook.ai.internalDomains`; project or customer
   names go in `mdRunbook.ai.terms`.
3. Ask it for the next step. Copy its whole answer and run **md-runbook: Paste AI Proposal**: its
   commands are inserted as proposed cells with the real names restored, and they don't run until
   you approve them (section 8).

**md-runbook: Check for Leaks** (Command Palette) scans the runbook for secrets and internal names
before you share it.

**Built-in AI:** set `mdRunbook.ai.provider` in your user settings to `vscode` (GitHub Copilot or
another VS Code model) or `anthropic` (the Claude API with your own key). Then **Explain Output**
and **Suggest Next Steps** appear in a cell's `⋯` menu, and **Summarize Incident** in the Command
Palette. Every send asks first and can show exactly what will be sent.

## 13. Line by line

You can run parts of a cell. Try each on this cell:

```bash
echo "step one"
cd ..
echo "now in $(pwd)"
ls package.json
```

- **Hover line 3** and click **Run line 3**: only that line runs. The output is saved with
  `lines=3`, and the step stays pending in the progress until the whole cell has run.
- **Hover lines 1 and 3** and click **Check** on each: they get a ☑ in the margin, and
  **Run 2 checked lines** appears under the cell. Click it: only those two run, in order, saved
  as `lines=1,3`. **Uncheck All Lines** (the dropdown next to the cell's ▶) clears them.
- **The hover has more:** **Run until here** on line 3 runs lines 1 to 3, **Run from here** on
  line 2 runs lines 2 to 4, **Step from here** pauses before each, **Breakpoint** sets one,
  **Copy** copies the line (with `${param:…}` and `${out:…}` values filled in), and **Explain**
  asks the AI about it when `mdRunbook.ai.provider` is set. Below the buttons, the hover says if
  the line will ask before running and what its `${…}` references stand for right now.
- **Right-click a line:** **Run This Line**, or **Step Through from This Line**. Select `pwd`
  first and the menu offers **Run Selection** instead: only the selection runs.
  `Ctrl+Alt+Enter` (`Cmd+Alt+Enter` on macOS) does the same from the keyboard.
- **Run Lines One by One** (dropdown): each line shows as `$ command` before its output, and the
  `cd` on line 2 carries over to line 3.
- **Step Through Lines** (dropdown): the next line is highlighted and the cell waits. `F10` runs
  it, `F5` runs on to the next breakpoint (or the end), `Shift+F5` stops (the lines that ran are
  recorded).
- **Breakpoint:** click in the margin left of line 3 (a red dot), then run the whole cell with ▶:
  it stops before line 3. `F5` goes on. A breakpoint on a blank line or a comment stops at the
  next command.

`mdRunbook.lines.buttons` set to `inline` shows `▶ ☐` in front of each line instead
(`Ctrl+click`), and `off` hides them; `mdRunbook.lines.breakpoints` turns breakpoints off.

A block, a continuation line or a here-doc counts as one line, so the `foreach` here is one step:

```pwsh
$items = 1..3
foreach ($i in $items) {
  Write-Output "item $i"
}
Write-Output "done"
```

## 14. Checks and retries

Passes: the output contains the expected text.

```bash expect="all good"
echo "status: all good"
```

Fails although the exit code is 0, because the text is missing (`check=failed` in the output
marker):

```bash expect="all good" continue-on-error
echo "status: degraded"
```

Passes with exit code 1, because that is the expected one:

```bash expect-exit=1 expect="not found"
echo "setting not found"
exit 1
```

Waits until it passes: it fails twice, then passes on the third attempt, one second apart. Only
the last attempt's output is kept, and the status line shows `attempt 3/4`:

```bash retry=4 every=1s
f="${TMPDIR:-/tmp}/md-runbook-sample-retry"
n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$f"
echo "attempt $n"
if [ "$n" -lt 3 ]; then echo "not ready yet"; exit 1; fi
rm -f "$f"; echo "ready"
```

## 15. Passing values between cells

The first cell keeps the pod name from its output; the second one uses it as `${out:POD}`:

```bash capture="POD:/^(web-\S+)/m"
echo "NAME              READY   STATUS"
echo "web-7c9d5b-x2kqp  1/1     Running"
```

```bash
echo "logs of ${out:POD}"
```

A value captured with `capture-secret=` is redacted everywhere: in its own output (once the cell
has finished), in later outputs and in the saved file.

```bash capture-secret=SESSION_TOKEN
echo "tok-$RANDOM$RANDOM-demo"
```

```bash
echo "using token ${out:SESSION_TOKEN}"
```

## 16. Blocks for one OS

Only the block for your system runs; the other one keeps whatever output it had. Together they
count as one step in the progress:

```pwsh os=windows
Write-Output "Temp folder: $env:TEMP"
```

```bash os=linux,macos
echo "Temp folder: ${TMPDIR:-/tmp}"
```

## 17. Reports, problems and the command line

**Reports:** **md-runbook: Export Report (HTML)** (notebook toolbar) writes
`sample.runbook.report.html` next to this file: every step with its result and output.
**Export Report (PDF)** prints the same report with the Chrome or Edge installed on your
machine.

**Problems:** the next block has a misspelled option on purpose (`retires=3`). It is underlined
on the cell and listed in the **Problems** panel; when it runs, the option is ignored.

```bash retires=3
echo "the misspelled option is ignored"
```

**Command line:** the same runbook runs without VS Code, for CI or scheduled checks. From the
repository folder, after `npm run compile`:

```text
node out/dist/cli.js lint examples/sample.runbook.md
node out/dist/cli.js run examples/sample.runbook.md --check --keep-going --report report.html
```

`lint` reports the misspelled option. `run --check` runs every cell without changing this file.
Expect a few steps that don't run there: the risky command in section 7 needs `--yes`, the
proposed cell in section 8 never runs from the command line, and section 5's inputs have no
value unless you pass `--input`. The cells that fail on purpose (sections 3, 11 and 14) fail
there too, so the run ends with exit code 1.

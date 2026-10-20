# Running a cell line by line

A cell normally runs as one script. You can also run its lines separately:

- **Hover a command** (in cells with two or more) for its buttons and what you should know
  before running it (see [below](#the-line-hover)); a plain click on a button does it. Checked
  lines get a ☑ in the margin, and **Run 2 checked lines** appears on the cell's status line,
  under the cell.
- **The dropdown next to the cell's run button:** **Run Lines One by One**, **Step Through
  Lines**; **Run Checked Lines** and **Uncheck All Lines** when lines are checked; **Run
  Selection** and **Step Through from Selection** when text is selected in the cell.
- **Right-click in the cell's code:** **Run This Line** and **Step Through from This Line** (the
  line you clicked), or **Run Selection** and **Step Through from Selection** when text is
  selected.
- **`Ctrl+Alt+Enter`** (`Cmd+Alt+Enter` on macOS): the selection, or else the line the cursor is
  on.
- **Breakpoints:** a cell with breakpoints runs line by line and pauses at them (see
  [below](#breakpoints)).

| Command | What it does |
|---|---|
| **Run This Line** / **Run Selection** | Runs only that line, or exactly the selected text (even part of a line). |
| **Run Lines One by One** | Runs every line of the cell in order, stopping at the first line that fails. |
| **Run Checked Lines** | Runs the checked lines in order, in one shell, stopping at the first that fails. Checks are kept until you close the runbook; they aren't saved in the file. |
| **Step Through Lines** | Runs the first line, then pauses before each next one, like stepping in a debugger. |
| **Step Through from This Line** / **from Selection** | The same, starting at that line (or the next command after it). |

When not every line of the cell ran, the output is saved with `lines=` and the cell lines that
ran: `lines=3`, `lines=2-4`, or `lines=1,3` for checked lines that aren't next to each other.

The output shows each line before its own output (`$ ls -la` in bash, `PS> Get-Date` in PowerShell,
`> dir` in cmd), so the saved output is a readable record of what ran:

````markdown
```bash
cd deploy
kubectl get pods
kubectl rollout status deploy/web
```
<!-- md-runbook:output start exit=0 ran=… lines=1-2 -->
```text
$ cd deploy
$ kubectl get pods
NAME          READY   STATUS    RESTARTS   AGE
web-7c9d…     1/1     Running   0          3d
```
<!-- md-runbook:output end -->
````

To try it, open [`examples/sample.runbook.md`](../../examples/sample.runbook.md) (section 13) or
run **md-runbook: Open Sample Runbook**.

## The line hover

Rest the mouse on a command for a moment (each button has a VS Code icon in front):

```text
Run line 2 · Run lines 1-2 · Run lines 2-4 · Step from here
Check · Breakpoint · Copy with values · Explain
───────────────────────────────────────────────
Asks before running: matches delete
cluster: prod-eu · namespace: web (last known)
${param:ns} = prod
${out:POD} = no value yet: run the cell with capture=POD first
```

| | |
|---|---|
| **Run line** | Runs only that command. |
| **Run lines 1-2** (run-above icon) | Runs the commands before it and it, in order: on line 2, lines 1 and 2. Not on the first command. |
| **Run lines 2-4** (run-below icon) / **Step from here** | Runs that command and the ones after it, straight through or pausing before each (`F10`, `F5`, `Shift+F5`). Not on the last command. |
| **Check** | Checks it for **Run Checked Lines** (**Uncheck** when checked). |
| **Breakpoint** | Sets or removes a breakpoint on it, as a click in the margin does. Not with `mdRunbook.lines.breakpoints` off. |
| **Copy with values** | Copies the command with the current `${param:…}`, `${out:…}` and `${input:…}` values filled in, to paste into a terminal. `${secret:…}`, secret inputs and values captured as secret stay as references. Without references it is **Copy**. |
| **Explain** | Asks the AI what the command does; the answer opens beside. Only with `mdRunbook.ai.provider` set, and it asks before sending, like **Explain Output**. |
| **Asks before running** | The command matches `mdRunbook.execution.confirmPatterns` (or every run asks), so running it will ask first. |
| **Context** | Where it will run: the last values of `mdRunbook.output.recordContext` (cluster, server, …). Only when that is set. |
| **`${…}` values** | The value each reference will have, or why there is none yet. Secret values are never shown (••••). |

The hover only reads what md-runbook already knows: it never asks for a value or runs anything.

`mdRunbook.lines.buttons` chooses where the buttons are:

| Value | Buttons |
|---|---|
| `hover` (default) | In a hover on the command, a plain click. Nothing in the code until you hover. |
| `inline` | `▶ ☐` always in front of each command. They are VS Code *inlay hints*, which VS Code runs on `Ctrl+click` (`Cmd+click` on macOS) only, and which need `editor.inlayHints.enabled` on. |
| `off` | None. The dropdown, the right-click menu and `Ctrl+Alt+Enter` still run lines. |

VS Code doesn't let an extension put clickable buttons in the margin or next to the cell's run
button, so the hover is the closest a plain-click button can get to the line.

## Step Through

While a cell waits for its next line, that line is highlighted in the cell, the status bar shows
`line 3 next (3/5)`, and the cell toolbar has three buttons:

| Key | Button | |
|---|---|---|
| `F10` | **Run Next Line** | Runs the highlighted line, then pauses again. |
| `F5` | **Run Remaining Lines** | Continues without stepping, until the next breakpoint (or a failure, or the end). |
| `Shift+F5` | **Stop Stepping** | Ends the run here; the lines that ran are recorded. |

The keys only apply while a cell is paused, and not during a debug session. The cell's own Stop
button also ends the run where it is. While a cell is paused, the runbook's other cells wait,
because they would share its shell.

## Breakpoints

Click in the margin to the left of a line in a `bash`, `pwsh` or `cmd` cell to set a breakpoint
(the red dot, as in any VS Code editor). A run of that cell (its run button, Run All, Run Lines
One by One, …) then goes line by line in one shell and **pauses before each line with a
breakpoint**, highlighted as in Step Through: `F10` runs the next line, `F5` continues to the next
breakpoint, `Shift+F5` stops. Cells without breakpoints run as usual.

- Every enabled breakpoint in a runbook cell is used: one on a blank line, a comment or inside a
  multi-line block pauses before the command at or after it. Disable or remove them in the
  **Breakpoints** view of the Run and Debug side bar, like any breakpoint.
- `mdRunbook.lines.breakpoints` turns breakpoints off: `bash` and `cmd` cells then have no
  breakpoint margin, and breakpoints are ignored. If the PowerShell extension is installed, it
  still shows its own margin in `pwsh` cells; md-runbook ignores those breakpoints too then.
- md-runbook is not a debugger: it pauses *between* commands, it can't stop inside a running
  command or show variables.

## What counts as a line

A line is a command. Lines that belong together stay together:

- continuation lines: a trailing `\` (bash), backtick (PowerShell) or `^` (cmd), and a line
  ending in `|`, `&&` or `||` (PowerShell also: `,`, `=`, `-and`, `-or`, and a next line that
  starts with `|`);
- blocks: `if … fi`, `for/while … done`, `case … esac`, `{ … }` and `( … )` in bash; `{ … }`,
  `( … )`, `[ … ]`, and `else`/`elseif`/`catch`/`finally` on the next line in PowerShell;
  `( … )` in cmd;
- multi-line strings, bash here-docs (`<<EOF`) and PowerShell here-strings (`@' … '@`).

Blank lines and comment-only lines (`#`, `<# … #>`, `rem`, `::`, and cmd `:labels`) are not run.
**Run Line or Selection** on a line inside a block runs the whole block. To run a single line from
inside a block, select it.

## State between lines

`cd`, variables and functions carry over from one line to the next:

- in [session mode](session.md), the lines run in the runbook's session, like any cell;
- cells with the [`terminal` option](terminal.md) get a terminal of their own for the run,
  named `md-runbook: <file> (<shell>, lines)`, and every line runs in that terminal's shell. It
  is closed when the run ends, so the runbook's usual terminal is never changed;
- otherwise, they share a shell that is started for this run and stopped when it ends.

The exception is **cmd cells**: each line runs in its own process, so `cd` or a variable set on
one line is gone on the next.

The cell's timeout (`timeout=` or `mdRunbook.execution.timeoutSeconds`) applies to each line on
its own. Time spent paused doesn't count.

## Saved output and progress

The output of a line run replaces the cell's output, like a normal run. When not every line of
the cell ran (one line, a selection, a run stopped early or at a failure), the output marker gets
`lines=` with the cell's line numbers (1-based), and the status line shows `lines 2-3`:

- with `exit=0`, the step counts as **not done yet** in progress, Resume Run and the HTML report
  (`– lines 2-3 ran`);
- a failed line makes it **failed**, like a failed cell.

A run that covers every line (Run Lines One by One or Step Through to the end, or a selection of
the whole cell) is a normal run with no `lines=`.

## Safety

A line run goes through the same checks as a full run, once, before its first line:
approval of proposed cells, the command policy, cell options such as `skip`, and the risky-command
confirmation. For **Run Line or Selection** these apply to the text that runs, so a risky command
on a line you don't run doesn't ask. `${secret:…}`, `${input:…}` and `${param:…}` references are
asked for once and work in every line. Output is redacted like any other run.

Line runs work in the runbook (notebook) view only, not from the plain text editor's CodeLens.

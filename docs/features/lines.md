# Running a cell line by line

A cell normally runs as one script. Four commands run its lines separately instead. They're in
the dropdown next to a code cell's run button, and in the Command Palette:

| Command | What it does |
|---|---|
| **Run Line or Selection** (`Ctrl+Alt+Enter`, `Cmd+Alt+Enter` on macOS, or the cell editor's context menu) | Runs only the line the cursor is on. With text selected, it runs exactly that text, even part of a line. |
| **Run Lines One by One** | Runs every line of the cell in order, stopping at the first line that fails. |
| **Step Through Lines** | Runs the first line, then pauses before each next one, like stepping in a debugger. |
| **Step Through from This Line** (also in the cell editor's context menu) | The same, starting at the line the cursor is on (or the next command after it). The lines above it are not run, so the output is saved with `lines=`. |

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

## Step Through

While a cell waits for its next line, that line is highlighted in the cell, the status bar shows
`line 3 next (3/5)`, and the cell toolbar has three buttons:

| Key | Button | |
|---|---|---|
| `F10` | **Run Next Line** | Runs the highlighted line, then pauses again. |
| `F5` | **Run Remaining Lines** | Runs the rest without pausing (still stopping at a failure). |
| `Shift+F5` | **Stop Stepping** | Ends the run here; the lines that ran are recorded. |

The keys only apply while a cell is paused, and not during a debug session. The cell's own Stop
button also ends the run where it is. While a cell is paused, the runbook's other cells wait,
because they would share its shell.

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

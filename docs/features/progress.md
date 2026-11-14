# Progress, manual steps and Resume

A runbook is a list of steps. md-runbook tracks which ones are done, lets you tick off steps
you did by hand, and picks a stopped run up where it failed.

## Steps

- **Code cells:** a cell is **done** when its output has `exit=0` or `exit=done`, **skipped**
  with `exit=skipped` (the `skip` option, or marked skipped), **pending** when it has no output
  or `exit=declined` (its confirmation was answered with anything but Run) or `exit=proposed`
  (an assistant's proposal waiting for approval), and **failed** with any other exit
  (non-zero, `timeout`, `cancelled`, `error`, a signal).
- **Checklist items:** GitHub task-list items in Markdown (`- [ ]`, `* [x]`, `1. [ ]`) count
  as steps too: `[x]` is done, `[ ]` is pending. Items inside fenced code blocks don't count.

## Status bar

While a runbook is the active editor, the status bar shows its progress, in the same words as
the app's run bar:

| When | Status bar |
| --- | --- |
| Not running | `☰ 2/6 · ~4 min` (steps done or skipped, and the time left by the blocks' estimates) |
| A block runs | `⟳ Step 3/6 · Push image · 1m 40s left` (the block's `name=`, else its first line) |
| A step failed | `✗ Step 4/6 failed`, on a red background |
| All done | `✓ Done · 6/6 · teardown offered` |
| A value or a confirmation is asked | `✎ Waiting for you: parameter NAMESPACE`, on a yellow background |

The ready check is not a step, and a teardown that hasn't run is *offered*, not a step still to
do: a runbook whose own steps are done reads **Done**, and Resume Run offers the teardown. The
time left counts seconds under two minutes, so it moves while you watch.

The tooltip has one line for where the run is (`2 of 6 steps done · 41% by the estimates · 4 min
left · done ≈ 14:32`), the counts, a table of the setup, the steps and the teardown with their
times, and links: go to the running, failed or next step, Resume Run. Click the item (or run
**md-runbook: Go to Next Step**) to jump to the first failed step, or else the next pending one.

**Run All follows the run.** Before each block, the notebook scrolls it into view, as long as the
block before it is still in view: scroll away to read something else and it stops following
(`mdRunbook.execution.followRun`, on by default).

## A block's bar

A block with `estimate=` shows it on its status line (`⌚ est. 2m30s`). While it runs, a bar
against it that moves every few seconds, then a warning once past it:

```text
⌚ █████████████▌░░░░░░░░░░ 1m10s of 2m30s
⚠ ████████████████████████ +40s over 2m30s
```

After a run that took noticeably longer (more than a quarter and at least 10 s over), the line
says by how much: `⌚ est. 2m30s · took 3m10s (+40s)` (a warning icon past twice the estimate and
a minute over). Click it to set `estimate=` to what the run took, rounded up.

## Mark a step done or skipped

For steps you carry out by hand (or don't need), use **Mark Step Done** / **Mark Step
Skipped** from the cell's `⋯` menu or the Command Palette. They work on the cell whose menu you
opened, or on the selected cells. Nothing runs; the cell gets an output that is saved like any
other:

````markdown
```bash
oc adm drain node-3 --ignore-daemonsets
```
<!-- md-runbook:output start exit=done ran=2026-10-18T14:20:00+02:00 by=jane -->
```text
[md-runbook] marked done by jane
```
<!-- md-runbook:output end -->
````

`by` is your OS user name. **Unmark Step** removes a done/skipped mark again. It only clears
outputs made by Mark Step (they carry `by=`); real run output, including a run recorded as
`exit=skipped` by the `skip` option, is left alone. Marking a step also drops the run history
kept from its previous output, so no stale `changed=` / history is saved.

**Check Next Item** (`⋯` menu of a Markdown cell, or the Command Palette) changes the first
`- [ ]` of the selected Markdown cell to `- [x]`; the cell is saved like any edited Markdown cell.

## Resume Run

**md-runbook: Resume Run** (notebook toolbar, Command Palette) runs the first failed or pending
code cell and every failed or pending code cell after it, in order (declined and proposed cells
are pending, so they are included). Cells that are already done or skipped are not run again.
A proposed cell still needs approval; it is skipped again until it is approved, and unlike a
declined confirmation it does not stop the run. Run All's stop-on-failure rule applies
(`mdRunbook.execution.stopOnFailure`), so a typical flow is: Run All stops at a failing step →
fix the step → Resume Run.

## Clear outputs above / below

**Clear Outputs Above** clears the code cells before the selected cell; **Clear Outputs Below**
clears the selected cell and everything after it (like Run Above / Run Below). Both are in the
cell's `⋯` menu and the Command Palette. Cells that are running are left alone. The blocks
disappear from the file on the next save.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.progress.statusBar` | `true` | Show the active runbook's progress in the status bar. |
| `mdRunbook.execution.followRun` | `true` | When running several cells, scroll the cell about to run into view while the previous one is still in view. |

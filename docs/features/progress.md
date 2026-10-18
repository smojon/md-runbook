# Progress, manual steps and Resume

A runbook is a list of steps. md-runbook tracks which ones are done, lets you tick off steps
you did by hand, and picks a stopped run up where it failed.

## Steps

- **Code cells:** a cell is **done** when its output has `exit=0` or `exit=done`, **skipped**
  with `exit=skipped`, **failed** with any other exit (non-zero, `timeout`, `cancelled`,
  `error`, a signal) and **pending** when it has no output.
- **Checklist items:** GitHub task-list items in Markdown (`- [ ]`, `* [x]`, `1. [ ]`) count
  as steps too: `[x]` is done, `[ ]` is pending. Items inside fenced code blocks don't count.

## Status bar

While a runbook is the active editor, the status bar shows its progress:

```text
$(checklist) 4/7 · ✗ step 5
```

`4/7` counts done and skipped steps; `✗ step 5` names the first failed step. When nothing is
pending or failed the icon becomes a check mark. Click it (or run **md-runbook: Go to Next
Step**) to jump to the first failed step, or else the next pending one.

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

`by` is your OS user name. **Unmark Step** removes a done/skipped mark again (it leaves real run
output alone).

**Check Next Item** (`⋯` menu of a Markdown cell, or the Command Palette) changes the first
`- [ ]` of the selected Markdown cell to `- [x]`; the cell is saved like any edited Markdown cell.

## Resume Run

**md-runbook: Resume Run** (notebook toolbar, Command Palette) runs the first failed or pending
code cell and every failed or pending code cell after it, in order. Cells that are already done
or marked skipped are not run again. Run All's stop-on-failure rule applies
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

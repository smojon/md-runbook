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
  They are steps done by hand: **Run All waits at one that isn't ticked** and asks **Done by
  hand?** on the cell itself, not in a dialog, so the window stays free for the step: **Done**
  ticks it, **Skip** goes on without ticking it, **Stop** stops the run there (Resume Run asks
  again). The buttons are on the cell's status line and its row in the Steps view; ticking the
  box yourself counts as Done. Put `manual-steps: continue` in the front matter to run past them, as
  reminders.

## Status bar

While a runbook is the active editor, the status bar shows its progress, in the same words as
the app's run bar. While it runs or waits for you with another file in front, the item stays,
named (`deploy-checkout · ⟳ Step 2/5 · Build the image · 22s left`), and a click brings the
runbook back. The Steps view follows the same runbook, with its name under the view's title.

| When | Status bar |
| --- | --- |
| Not running | `☰ 2/6 · ~4 min` (steps done or skipped, and the time left by the blocks' estimates; `at least 4 min` while steps without any estimate are still to do) |
| A block runs | `⟳ Step 3/6 · Push image · 1m 40s left` (the block's `name=`, else its heading, else its first line) |
| A step failed | `✗ Step 4/6 failed`, on a red background; the failed cell's status line has **Retry**, **Resume from Here**, **Mark Done** and, with the assistant on, **Explain** |
| All done | `✓ Done · 6/6 · teardown offered` |
| A value or a confirmation is asked | `✎ Waiting for you: parameter NAMESPACE`, on a yellow background |

The ready check is not a step, and a teardown that hasn't run is *offered*, not a step still to
do: a runbook whose own steps are done reads **Done**, and Resume Run offers the teardown. The
time left counts seconds under two minutes, so it moves while you watch.

The tooltip has one line for where the run is (`2 of 6 steps done · 41% by the estimates · 4 min
left · ends ≈ 14:32`; the end time only while it runs and every step left has an estimate), the counts, a table of the setup, the steps and the teardown with their
times, and links: go to the running, failed or next step, Resume Run. Click the item (or run
**md-runbook: Go to Next Step**) to jump to the first failed step, or else the next pending one.

## Steps view

The **Steps** view (its own icon in the activity bar, which shows how many steps are left; **Show
Steps** on the toolbar and in Run ▾; **All steps** in the status bar's tooltip; it opens by itself
on the first Run All; drag it to the secondary side bar to keep it beside the runbook) is the runbook's progress as a rail beside its
steps, like the app's rail: at the top, where the run is, the bar and the time left; then each
`#`/`##` chapter and each step with its state on the rail (done, failed, running, waiting for
you, to do), its name (`name=`, else its heading, else its first line) and its time (`est. 2m`, `12s of 1m` while
it runs, with a bar, `took 3m10s (+40s)` after a run over its estimate). The rail fills down to
the step the run has reached, and the cells on screen are shaded. Click a row to go to it; its
buttons (on hover or with the keyboard) run that step, run from it, or mark it done or skipped,
and tick or untick a checklist item. The title bar has **Run All** (**Stop** while it runs),
**Resume Run** when there is something to resume, and **Go to Next Step**. The ready check's row
says what it answered (`not up → setup runs`). Up/Down, Home/End and Enter work in the list.

**Preflight.** Before a run, each step still to do says what it will need from you, and the
view's header sums it up: `Before you run: 2 confirmations · 1 secret to set · 1 value to type ·
1 step by hand`. A step can need your confirmation (`confirm`, or a risky command), a secret not
stored yet, an input or parameter to type, a value from an earlier step (`${out:…}`), or an
approval (a proposed cell). Nothing is asked or sent to find this out. The app's Steps sheet (and
the side panel on a wide screen) says the same: under each step what it needs, and the line
above the list (confirmations, secrets not stored on this device, inputs not typed yet,
proposals, steps by hand).

**A notification when you look away.** When a run ends while its runbook isn't the editor in
front (another file, another window), a notification says so: `deploy-checkout: step 4 of 6
failed — Push image` with **Go to Step** and **Resume Run**, or `deploy-checkout: done · 6 of 6`
with **Open**. A run of one cell notifies only when it took at least 30 s
(`mdRunbook.notifications.afterSeconds`). A question asked on the cell (a step by hand, the
teardown, a risky command while another file is in front) shows a notice that closes by itself
once answered; a value box or a dialog shows itself, so no notice for those. Nothing while you
watch the runbook. **Don't Show Again** turns them off (`mdRunbook.notifications.enabled`).
With `mdRunbook.notifications.system` (off by default), they also go to the system's
notification centre while the window is in the background: a Windows toast, a macOS
notification, or `notify-send` on Linux (best effort: it needs that tool).

**Questions name the step.** A risky command asks `Risky command in Roll out (step 3 of 5,
deploy-checkout): “apply”` with the command itself under it. While the runbook is in front it's a
dialog; with another file in front it's asked on the cell instead (**Run** / **Don't Run**), so it
doesn't land on top of something else. Escape on a value prompt doesn't fail the step: it isn't
run, stays to do (`exit=unanswered`), and the run stops there.

**Estimates that learn** can be forgotten with **Values ▾ → Forget Learned Times…** (this
runbook's or every runbook's) and turned off with `mdRunbook.estimates.learn`. A run copy
(`deploy.20261114-142000.md`) learns into the runbook it was copied from.

**Run All follows the run.** Before each block, the notebook scrolls it into view, as long as the
block before it is still in view: scroll away to read something else and it stops following
(`mdRunbook.execution.followRun`, on by default).

## A block's bar

A block with `estimate=` shows it on its status line (`⌚ est. 2m30s`). While it runs, a bar
against it, then a warning once past it:

```text
⌚ █████████░░░░░░░░░░░ 1m10s of 2m30s
⚠ ████████████████████ +40s over 2m30s
```

After a run that took noticeably longer (more than a quarter and at least 10 s over), the line
says by how much: `⌚ est. 2m30s · took 3m10s (+40s)` (a warning icon past twice the estimate and
a minute over). Click it to set `estimate=` to what the run took, rounded up.

**Learned estimates.** A block without `estimate=` learns its usual time from its runs that
passed: the median of the last 5, rounded up as `estimate=` would be, shown with a `~`
(`⌚ est. ~1m15s`). It counts in the runbook's time left like an estimate, so a runbook gets an
end time after one run. The times are kept on this machine (VS Code's workspace state, the app's
storage), never in the file; a step is kept under its `name=`, else under its text, so editing
a command starts again. Click a learned estimate to write it into the runbook as `estimate=`.
Line runs, skipped steps and the ready check don't count.

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
| `mdRunbook.notifications.enabled` | `true` | When a run of several cells ends (done, or a step failed) or waits for you while its runbook isn't the editor in front, show a notification with a button to go there. |

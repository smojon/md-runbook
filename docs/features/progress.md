# Progress, manual steps and Resume

A runbook is a list of steps. md-runbook tracks which ones are done, and lets you tick off steps
you did by hand. It picks a stopped run up where it failed.

## Steps

- **Code cells:** a cell is:
  - **done** when its output has `exit=0` or `exit=done`;
  - **skipped** with `exit=skipped` (the `skip` option, or marked skipped);
  - **pending** when it has no output, `exit=declined` or `exit=proposed`. `exit=declined`: its
    confirmation was answered with anything but Run. `exit=proposed`: an assistant's proposal
    waiting for approval.
  - **failed** with any other exit (non-zero, `timeout`, `cancelled`, `error`, a signal).
- **Checklist items:** GitHub task-list items in Markdown (`- [ ]`, `* [x]`, `1. [ ]`) count
  as steps too: `[x]` is done, `[ ]` is pending. Items inside fenced code blocks don't count.

Checklist items are steps done by hand. **Run All waits at one that isn't ticked** and asks
**Done by hand?** on the cell itself. It asks there, not in a dialog, so the window stays free
for the step.

The buttons are on the cell's status line and its row in the Steps view:

- **Done** ticks it; ticking the box yourself counts as Done.
- **Skip** goes on without ticking it.
- **Stop** stops the run there (Resume Run asks again).

Put `manual-steps: continue` in the front matter to run past checklist items, as reminders.

## Status bar

While a runbook is the active editor, the status bar shows its progress. It uses the same words
as the app's run bar.

While it runs or waits for you with another file in front, the item stays, named:
`deploy-checkout · ⟳ Step 2/5 · Build the image · 22s left`. A click brings the runbook back. The
Steps view follows the same runbook, with its name under the view's title.

| When | Status bar |
| --- | --- |
| Not running | `☰ 2/6 · ~4 min` (steps done or skipped, and the time left by the blocks' estimates; `at least 4 min` while steps without any estimate are still to do) |
| A block runs | `⟳ Step 3/6 · Push image · 1m 40s left` (the block's `name=`, else its heading, else its first line) |
| A step failed | `✗ Step 4/6 failed`, on a red background; the failed cell's status line has **Retry**, **Resume from Here**, **Mark Done** and, with the assistant on, **Explain** |
| All done | `✓ Done · 6/6 · teardown offered` |
| A value or a confirmation is asked | `✎ Waiting for you: parameter NAMESPACE`, on a yellow background |

The ready check is not a step. A teardown that hasn't run is *offered*, not a step still to do. A
runbook whose own steps are done reads **Done**, and Resume Run offers the teardown.

The time left counts seconds under two minutes, so it moves while you watch.

The tooltip has:

- one line for where the run is:
  `2 of 6 steps done · 41% by the estimates · 4 min left · ends ≈ 14:32`. The end time shows
  only while it runs and every step left has an estimate.
- the counts;
- a table of the setup, the steps and the teardown, with their times;
- links: go to the running, failed or next step, Resume Run.

Click the item (or run **md-runbook: Go to Next Step**) to jump to the first failed step. Without
a failed step, it jumps to the next pending one.

## Steps view

The **Steps** view is the runbook's progress as a rail beside its steps, like the app's rail. To
open it:

- its own icon in the activity bar, which shows how many steps are left;
- **Show Steps** on the toolbar and in Run ▾;
- **All steps** in the status bar's tooltip;
- the first Run All opens it by itself.

Drag it to the secondary side bar to keep it beside the runbook.

At the top: where the run is, the bar and the time left. Then each `#`/`##` chapter and each
step, with:

- its state on the rail (done, failed, running, waiting for you, to do);
- its name (`name=`, else its heading, else its first line);
- its time: `est. 2m`, or `12s of 1m` while it runs, with a bar and a spinning icon. After a run
  over its estimate: `took 3m10s (+40s)`.

A chapter with only one step is one row: the heading, with the step's dot, number and time. The
step's own name is under it when it has another one. Checklist items stay under the heading they
are written under.

The rail fills down to the step the run has reached. The cells on screen are shaded (a line on
the left in high contrast).

Click a row to go to it. Its buttons (on hover or focus, beside the time):

- run that step, or run from it;
- mark it done or skipped, or unmark it;
- tick a checklist item.

The title bar has:

- **Run All** (**Stop** while it runs);
- **Resume Run**, when there is something to resume;
- **Go to Next Step**.

The ready check's row says what it answered (`not up → setup runs`).

The view follows the runbook you work on. That is the one in front, else the one that runs or
waits for you. With no runbook open it offers **Open Sample Runbook** and **Open as Runbook**.

**When a step fails**, the header has two buttons:

- **Retry step** runs the failed step again;
- **Resume** runs it and the steps still to do (Resume Run).

Under the failed row is the last line of its error output (stderr, else its output).

**When the run waits for you** with a question on the cell, the step's row has the cell's
buttons:

- **Done by hand?**: **Done** / **Skip** / **Stop**;
- the teardown offer: **Take Down** / **Leave It Up**;
- a risky command while another file is in front: **Run** / **Don't Run**.

**In the app** the same view is the **Steps** side of a phone's **Runbook | Steps** switch
([the app](../app.md)). On a wide screen it is the side panel. It has:

- the same header with Retry step and Resume;
- the same rows with their error line;
- a tick box for checklist items;
- a long press for a step's actions;
- the waiting step's answers as buttons.

**Keyboard.** Up/Down and Home/End move between rows, and Enter goes to the step's cell. On a
row:

- **R** runs the step, **F** runs from it;
- **D** marks it done, **S** marks it skipped, **U** unmarks it;
- **Space** ticks or unticks a checklist item.

On a row that waits for you, **1**, **2** and **3** press its answers. Enter works on a focused
button too. A screen reader reads these keys with the row.

- Anywhere in VS Code: **Ctrl+Alt+S** (⌃⌘S on a Mac) shows the Steps view.
- In the runbook or the Steps view: **Ctrl+Alt+N** (⌃⌘N) goes to the next step, **Ctrl+Alt+R**
  (⌃⌘R) resumes the run.
- In the runbook: **Ctrl+Alt+D** (⌃⌘D) marks the selected step done.

None of them act while you type in a cell. Change them in **Keyboard Shortcuts** (search for
`mdRunbook`).

**Right-click a step** in the Steps view (or use the cell's ⋯) for:

- **Run Until Here**: from the first step still to do up to this one.
- **Pause Before This Step**: Run All stops there and asks **Continue** or **Stop** on the cell.
  The row and the cell show a pause icon.
- **Notify Me When It Starts**: a notification when it starts, once. The row shows a bell.

Pauses and notifications last for the session and never change the file.

**When a step fails**, its cell's status line and its row in the Steps view offer what to do
next:

- **Retry**, **Resume from Here**, **Mark Done**;
- the step named by `on-failure="Rollback"`, if the block has one;
- with the assistant on, **Explain** and **Suggest a Fix**: a proposal added after the step, to
  approve before it runs.

Hover the error line under the row for its last lines.

**Preflight.** Before a run, each step still to do says what it will need from you. The view's
header sums it up: `Before you run: 2 confirmations · 1 secret to set · 1 value to type ·
1 step by hand`.

A step can need:

- your confirmation (`confirm`, or a risky command);
- a secret not stored yet;
- an input or parameter to type;
- a value from an earlier step (`${out:…}`);
- an approval (a proposed cell).

Nothing is asked or sent to find this out. Each count is a link:

- values to type open **Set Parameters** and **Set Inputs**;
- secrets open **Set Secret** (the names are in the link's tooltip);
- confirmations, proposals and steps by hand go to the first step that needs one.

The app's Steps view (and the side panel on a wide screen) says the same:

- under each step, what it needs;
- the line above the list: confirmations, secrets not stored on this device, inputs not typed
  yet, proposals, steps by hand. Each count is a button there too.

**Launch form.** **Run All…** (Run ▾, or the Steps view's ⋯) opens one sheet before anything
runs. It shows in the Steps view, in place of the list:

- the parameters, each with its description from the front matter. When the comment says
  `One of: …`, it has a list to pick from. Each is filled in with this session's value, else the
  last one used, else the default.
- the inputs to type (secret ones masked, never filled in);
- the secrets not stored yet, with a **Set** button each;
- the risky steps, with their first command lines;
- the steps done by hand;
- the time the run takes;
- with `mdRunbook.output.recordContext`, the context it last recorded.

**Start** (or Enter) keeps the values for the session and runs: nothing is asked again in boxes.
The risky steps still ask for your confirmation when they run. A secret left unset is asked when
the run gets there.

A parameter with neither a value nor a default stops **Start**: the form names it.

Escape or **Back** closes the form; nothing runs.

With `mdRunbook.execution.launchForm` on (the default), the toolbar's **Run All** and the Steps
view's open the form too. They do so when the runbook has a parameter, an input, a secret not
stored or a risky step. Otherwise they just run.

**A notification when you look away.** When a run ends while its runbook isn't the editor in
front (another file, another window), a notification says so:

- `deploy-checkout: step 4 of 6 failed — Push image` with **Go to Step** and **Resume Run**;
- or `deploy-checkout: done · 6 of 6` with **Open**.

A run of one cell notifies only when it took at least 30 s
(`mdRunbook.notifications.afterSeconds`).

A question asked on the cell shows a notice that closes by itself once answered. Such questions
are a step by hand, the teardown, and a risky command while another file is in front. A value
box or a dialog shows itself, so no notice for those.

Nothing while you watch the runbook. **Don't Show Again** turns them off
(`mdRunbook.notifications.enabled`).

With `mdRunbook.notifications.system` (off by default), they also go to the system's
notification centre while the window is in the background:

- a Windows toast;
- a macOS notification;
- or `notify-send` on Linux (best effort: it needs that tool).

**Questions name the step.** A risky command asks
`Risky command in Roll out (step 3 of 5, deploy-checkout): “apply”` with the command itself
under it. While the runbook is in front it's a dialog.

With another file in front it's asked on the cell instead (**Run** / **Don't Run**). So it
doesn't land on top of something else.

Escape on a value prompt doesn't fail the step. It isn't run, stays to do (`exit=unanswered`),
and the run stops there.

**Estimates that learn** can be forgotten with **Values ▾ → Forget Learned Times…**, for this
runbook or every runbook. Turn them off with `mdRunbook.estimates.learn`. A run copy
(`deploy.20261114-142000.md`) learns into the runbook it was copied from.

**Run All follows the run.** Before each block, the notebook scrolls it into view, as long as the
block before it is still in view. Scroll away to read something else and it stops following
(`mdRunbook.execution.followRun`, on by default).

## A block's bar

A block with `estimate=` shows it on its status line (`⌚ est. 2m30s`). While it runs, a bar
against it, then a warning once past it:

```text
⌚ █████████░░░░░░░░░░░ 1m10s of 2m30s
⚠ ████████████████████ +40s over 2m30s
```

**Under the output while it runs**, a status block stays at the bottom, below the output as it
scrolls:

- a bar in the theme's progress colour, in the warning colour once past the estimate;
- `running · 12s of about 30s`, then `running · 45s · 15s over about 30s`;
- `attempt 2/5` beside it, for a block with `retry=`;
- without an estimate or a learned time, no bar: `running · 12s`.

The app uses the same words; `md-runbook run` shares only the run line (`Step 3/7 · …`).

With reduced motion on, the bar jumps instead of gliding. When the block ends, the status block
goes and the usual status line follows.

After a run that took noticeably longer, the line says by how much:
`⌚ est. 2m30s · took 3m10s (+40s)`.

- Noticeably longer: more than a quarter and at least 10 s over.
- A warning icon: past twice the estimate and a minute over.

Click the line to set `estimate=` to what the run took, rounded up:

- to whole seconds under 10 s (5.1 s → `6s`);
- to 5 s under a minute, 15 s under 10 minutes;
- to a minute under an hour, then to 5 minutes.

**Learned estimates.** A block without `estimate=` learns its usual time from its runs that
passed. It is the median of the last 5, rounded up as `estimate=` would be, and shown with a
`~`: `⌚ est. ~1m15s`.

It counts in the runbook's time left like an estimate, so a runbook gets an end time after one
run.

The times are kept on this machine (VS Code's workspace state, the app's storage), never in the
file. A step is kept under its `name=`, else under its text, so editing a command starts again.

Click a learned estimate to write it into the runbook as `estimate=`. Line runs, skipped steps
and the ready check don't count.

## Mark a step done or skipped

For steps you carry out by hand (or don't need), use **Mark Step Done** / **Mark Step
Skipped**. They are in the cell's `⋯` menu and the Command Palette.

They work on the cell whose menu you opened, or on the selected cells. Nothing runs; the cell
gets an output that is saved like any other:

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

`by` is your OS user name.

**Unmark Step** removes a done/skipped mark again. It only clears outputs made by Mark Step (they
carry `by=`). Real run output is left alone, including a run recorded as `exit=skipped` by the
`skip` option.

Marking a step also drops the run history kept from its previous output, so no stale
`changed=` / history is saved.

**Check Next Item** changes the first `- [ ]` of the selected Markdown cell to `- [x]`. It is in
the `⋯` menu of a Markdown cell and the Command Palette. The cell is saved like any edited
Markdown cell.

## Resume Run

**md-runbook: Resume Run** (notebook toolbar, Command Palette) runs the first failed or pending
code cell. Then it runs every failed or pending code cell after it, in order. Cells that are
already done or skipped are not run again.

Declined and proposed cells are pending, so they are included. A proposed cell still needs
approval: it is skipped again until it is approved. Unlike a declined confirmation, it does not
stop the run.

Run All's stop-on-failure rule applies (`mdRunbook.execution.stopOnFailure`). So a typical flow
is: Run All stops at a failing step → fix the step → Resume Run.

## Clear outputs above / below

Like Run Above / Run Below:

- **Clear Outputs Above** clears the code cells before the selected cell;
- **Clear Outputs Below** clears the selected cell and everything after it.

Both are in the cell's `⋯` menu and the Command Palette. Cells that are running are left alone.
The blocks disappear from the file on the next save.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.progress.statusBar` | `true` | Show the runbook's progress in the status bar; while it runs or waits with another file in front, named. |
| `mdRunbook.execution.followRun` | `true` | When running several cells, scroll the cell about to run into view while the previous one is still in view. |
| `mdRunbook.notifications.enabled` | `true` | When a run ends (done, or a step failed) or waits for you on the cell while its runbook isn't the editor in front, show a notification with a button to go there. |
| `mdRunbook.notifications.afterSeconds` | `30` | A run of one cell notifies when it took at least this long (several cells always do). |
| `mdRunbook.notifications.system` | `false` | Also send them to the system's notification centre while the window is in the background (Windows toast, macOS notification, `notify-send`). |
| `mdRunbook.estimates.learn` | `true` | Blocks without `estimate=` learn their usual time from their runs that passed; **Forget Learned Times…** clears them. |

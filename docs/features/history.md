# Output history, run copies and diffs

md-runbook can:

- keep earlier outputs of a cell;
- mark whether a re-run changed the output;
- show a diff against the previous run;
- run a runbook as a timestamped copy, so the original stays a clean template;
- append every run to a transcript file as it happens;
- list the runs of a runbook, with when it last ran green.

## Output history

Set `mdRunbook.output.historySize` to keep earlier runs. When a cell is re-run, its previous
output moves into a collapsed `<details>` block right after the latest output:

````markdown
```bash
oc get pods -n iam
```
<!-- md-runbook:output start exit=0 ran=2026-10-18T14:25:00+02:00 ended=… duration=0.812s changed=yes -->
```text
NAME        READY   STATUS
api-7d9f    1/1     Running
```
<!-- md-runbook:output end -->
<details><summary>md-runbook: 2 previous runs</summary>

<!-- md-runbook:output start exit=1 ran=2026-10-18T14:20:00+02:00 ended=… duration=0.640s -->
```text
error: You must be logged in to the server (Unauthorized)
```
<!-- md-runbook:output end -->

<!-- md-runbook:output start exit=0 ran=2026-10-17T09:02:00+02:00 ended=… duration=0.701s -->
```text
No resources found in iam namespace.
```
<!-- md-runbook:output end -->

</details>
````

- On GitHub and in other Markdown viewers, this renders as one collapsed line:
  **md-runbook: 2 previous runs**. It expands to the earlier outputs.
- The newest earlier run comes first. The block is trimmed to `historySize` entries.
- In the notebook, the cell's status line shows how many are kept:
  `exit code 0 · 1.2s · bash · 2 earlier runs`. **Compare With Previous Run** shows the last one
  as a diff.
- When the file is opened, the history stays with its cell; it does not become separate cells.
  A cell you don't re-run keeps its output and history byte for byte.
- Entries loaded from the file are written back byte for byte when they move into the history.
  The latest output, as always, is cleaned up and redacted before it is written.
- The block is only recognized directly after a cell's output block, and only with the structure
  above. Blank lines in between are allowed. Anything else, such as your own `<details>`, stays
  Markdown.
- With `historySize` set to `0` (the default), re-running a cell drops any history it had.
- **md-runbook: Clear All Outputs** removes the history blocks as well.

## Changed since last run

When a cell that already had an output is run again, the new marker gets `changed=yes` or
`changed=no`. A cell's first run has no `changed` attribute.

The comparison uses the text as it is written to the file: ANSI codes stripped, redacted,
truncated. So it doesn't flag differences that never reach the file.

**md-runbook: Compare With Previous Run** opens a diff of the previous output against the latest
one. It is in the cell's `⋯` menu, or the Command Palette for the selected cell.

The command works for runs in the current session. After reopening the file, it works for the
latest output against the first history entry.

## Run All as Copy

**md-runbook: Run All as Copy** (notebook toolbar, Command Palette) treats the runbook as a
template:

1. It writes the current content of the runbook to `<name>.<yyyyMMdd-HHmmss>.md` (for example
   `deploy.20261018-142000.md`). The copy includes unsaved edits, but comes **without** any
   outputs or history.
2. It opens the copy as a runbook and runs all cells.
3. It saves the copy with its outputs.

The original file is not changed. Cells of the copy run in the original runbook's folder. So
relative paths keep working, including `cwd=`, `.env` files and the context commands, even when
`mdRunbook.output.copyFolder` puts the copy elsewhere:

```json
"mdRunbook.output.copyFolder": "runs"
```

With `"mdRunbook.output.mode": "copy"`, **Run All as Copy** moves to the front of the notebook
toolbar. Running cells in place in a runbook also shows a one-time hint offering a copy instead.
Running in place still works.

A copy is the record of a run, so it is saved after every run. That covers the initial Run All
and any cell re-run in it later. `mdRunbook.output.saveAfterRun` is `"copies"` by default.

A runbook run in place is saved only when you save it. So nothing is written into your file
without that step. `true` saves those too; `false` never saves after a run.

## Transcript

Every run of a cell is also appended to a **transcript** as its output arrives. A transcript is a
plain text file in a `.md-runbook` folder next to the runbook: `deploy.runbook.md` gets
`.md-runbook/deploy.runbook.transcript.log`.

The transcript is on disk even if the runbook is never saved or VS Code closes. So a run can be
followed live from another window: `tail -f .md-runbook/deploy.runbook.transcript.log`, or an
assistant watching the file. It can also be looked at afterwards:

```text
===== 2026-10-28T22:14:05+01:00 · deploy.runbook.md · Step 12 · 5. Push · Push the platform
$ git push http://localhost:3000/lab/platform.git main
! fatal: unable to access 'http://localhost:3000/lab/platform.git/': The requested URL returned error: 503
! [md-runbook] check failed: the output does not contain "main -> main"
===== exit=128 · 9.1s · check failed

===== 2026-10-28T22:15:40+01:00 · deploy.runbook.md · checked: Open http://localhost:8080
```

- **A header per run:** the time, the runbook, the step number (as Export Report numbers it), its
  heading and its `name=` or first line. Then the script as it runs (`$ `). A line run leaves
  the script out, since each line is echoed in the output.
- **Output with a gutter:** `| ` for stdout, `! ` for stderr, so `grep '^! '` finds the errors.
  A line is written once it is complete, at most a tenth of a second after it arrived. It is
  written as the saved output writes it: what a terminal shows, no colours.
- **A footer:** exit, duration, and whether a check passed, the attempt and the lines of a line
  run. A retry marks each new attempt (`----- attempt 2/40`) below the last one's output.
- **Checklist items** ticked or unticked by clicking are noted on a line of their own.
- **Redacted like a saved runbook**, line by line and a private key block at once, also with
  live redaction off. A cell with `capture-secret=` holds its output until it has finished, so
  the captured value is redacted too. A file can't be redrawn.
- **The file only grows**, so a program redrawing lines already written (a spinner over several
  lines) leaves each frame here. Past 10 MB, the file is renamed to `….transcript.log.1`
  (replacing an older one) and a new one starts. A run copy has a transcript of its own.
- The folder is created when needed. If the file can't be written, a warning says so once and
  the transcript stops for the session. The runs are not affected.

The transcript is on by default. It holds what the outputs hold, so keep it out of Git. In a Git
repository, the first transcript written offers **Add to .gitignore**, which adds

```gitignore
# md-runbook run transcripts
.md-runbook/
```

(**Don't Ask Again** stops the offer). Transcripts kept beside the runbooks (an empty
`transcriptFolder`) need `*.transcript.log` and `*.transcript.log.1` instead.

- Turn it off with `mdRunbook.output.transcript`.
- Put the files elsewhere with `mdRunbook.output.transcriptFolder`: relative to the runbook's
  folder, or absolute.
- Name them with `mdRunbook.output.transcriptExtension` (`.transcript.log`): what replaces `.md`.
  It starts with a dot, has no spaces or slashes, and is not `.md`.

All three are user settings only. The command line writes one with
[`--transcript FILE`](cli.md#options).

## Run history

VS Code keeps a short record of each runbook run: one cell, a range, Run All or Resume Run. It is
kept in the workspace's storage on this machine. It is never written into the runbook.

Each record has:

- when the run started and ended;
- who ran it (the user name on this machine);
- the cells it ran;
- how many passed, failed and were skipped;
- the first step that failed;
- whether every step of the runbook was done afterwards.

**Show Runs…** (Run ▾, or the Command Palette) lists the runs of the runbook in front, newest
first:

```text
✓ Done · 6 of 6 · 14 Nov 14:32 · 3m10s
  by smojon · 6 passed
✗ Step 4 of 6 failed — Push image · 13 Nov 09:05 · 1m2s
  by smojon · 3 passed, 1 failed
```

Pick a run to open the [transcript](#transcript) at its first entry. Without one (the
transcript was off, or the file was rotated away), the runbook opens instead.

- **Last ran green:** a run after which every step was done, with nothing failed and nothing to
  do, is a green run. The status bar tooltip says `Last ran green: 3 days ago (by smojon)`, or
  `Never ran green`. Runbooks rot: this tells you whether this one still worked lately.
- **Steps that never ran:** a code step that never ran in any recorded run, and has no output
  now, gets a hint. It shows in the Problems panel once the runbook has a run recorded: "This
  step has never run here."
  - Blocks that don't run here (`skip`, `host=`, another OS's block, a proposal) get none.
  - The hint shows in the runbook view only.
  - A step is known by its `name=`, else by its text, so editing an unnamed step makes it new.
- **Run copies count for their runbook:** a run of `deploy.20261114-142000.md` is listed with
  the runs of `deploy.md`, as for learned times. A runbook call's copy has no record of its own.
  The call is a step of the runbook that called it.
- **Capped:** the last 50 runs of each runbook, for the 200 runbooks run most recently.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.output.historySize` | `0` | Earlier outputs kept per cell when it is re-run. `0` = off. |
| `mdRunbook.output.mode` | `"inPlace"` | `"copy"` makes **Run All as Copy** the primary action and hints at it when cells are run in place. |
| `mdRunbook.output.copyFolder` | `""` | Folder for run copies, relative to the runbook's folder (or absolute). Empty = next to the runbook. |
| `mdRunbook.output.saveAfterRun` | `"copies"` | Save after each run: `"copies"` only run copies, `true` every runbook, `false` never. |
| `mdRunbook.output.transcript` | `true` | Append every run to `<runbook>.transcript.log` as it happens ([Transcript](#transcript)). |
| `mdRunbook.output.transcriptFolder` | `".md-runbook"` | Folder for transcripts, relative to the runbook's folder (or absolute). Empty = beside the runbook. |
| `mdRunbook.output.transcriptExtension` | `".transcript.log"` | What replaces `.md` in a transcript's name. |

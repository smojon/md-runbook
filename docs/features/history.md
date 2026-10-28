# Output history, run copies and diffs

md-runbook can keep earlier outputs of a cell, mark whether a re-run changed the output, show
a diff against the previous run, run a runbook as a timestamped copy so the original stays
a clean template, and append every run to a transcript file as it happens.

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

- On GitHub and in other Markdown viewers this renders as one collapsed line,
  **md-runbook: 2 previous runs**, that expands to the earlier outputs.
- The newest earlier run comes first. The block is trimmed to `historySize` entries.
- In the notebook, the cell's status line shows how many are kept (`exit code 0 · 1.2s · bash ·
  2 earlier runs`); **Compare With Previous Run** shows the last one as a diff.
- When the file is opened, the history stays with its cell; it does not become separate cells.
  A cell you don't re-run keeps its output and history byte for byte.
- Entries loaded from the file are written back byte for byte when they move into the history.
  The latest output, as always, is cleaned up and redacted before it is written.
- The block is only recognized directly after a cell's output block (blank lines in between are
  allowed) and only with the structure above. Anything else, such as your own `<details>`, stays
  Markdown.
- With `historySize` set to `0` (the default), re-running a cell drops any history it had.
- **md-runbook: Clear All Outputs** removes the history blocks as well.

## Changed since last run

When a cell that already had an output is run again, the new marker gets `changed=yes` or
`changed=no`. The comparison uses the text as it is written to the file (ANSI codes stripped,
redacted, truncated), so it doesn't flag differences that never reach the file. A cell's first
run has no `changed` attribute.

**md-runbook: Compare With Previous Run** (in the cell's `⋯` menu, or the Command Palette for the
selected cell) opens a diff of the previous output against the latest one. It works for runs in
the current session and, after reopening the file, for the latest output against the first
history entry.

## Run All as Copy

**md-runbook: Run All as Copy** (notebook toolbar, Command Palette) treats the runbook as a
template:

1. it writes the current content of the runbook, including unsaved edits but **without** any
   outputs or history, to `<name>.<yyyyMMdd-HHmmss>.md` (for example `deploy.20261018-142000.md`),
2. opens the copy as a runbook and runs all cells,
3. saves the copy with its outputs.

The original file is not changed. Cells of the copy run in the original runbook's folder, so
relative paths (including `cwd=`, `.env` files and the context commands) keep working even when `mdRunbook.output.copyFolder` puts the copy elsewhere:

```json
"mdRunbook.output.copyFolder": "runs"
```

With `"mdRunbook.output.mode": "copy"`, **Run All as Copy** moves to the front of the notebook
toolbar, and running cells in place in a runbook shows a one-time hint offering a copy instead.
Running in place still works.

A copy is the record of a run, so it is saved after every run (the initial Run All, and any cell
re-run in it later): `mdRunbook.output.saveAfterRun` is `"copies"` by default. A runbook run in
place is saved only when you save it, so nothing is written into your file without that step;
`true` saves those too, `false` never saves after a run.

## Transcript

Every run of a cell is also appended to a **transcript**, a plain text file next to the runbook,
as its output arrives: `deploy.runbook.md` gets `deploy.runbook.transcript.log`. It is on disk
even if the runbook is never saved or VS Code closes, so a run can be followed live from another
window (`tail -f deploy.runbook.transcript.log`, or an assistant watching the file) and looked at
afterwards:

```text
===== 2026-10-28T22:14:05+01:00 · deploy.runbook.md · Step 12 · 5. Push · Push the platform
$ git push http://localhost:3000/lab/platform.git main
! fatal: unable to access 'http://localhost:3000/lab/platform.git/': The requested URL returned error: 503
! [md-runbook] check failed: the output does not contain "main -> main"
===== exit=128 · 9.1s · check failed

===== 2026-10-28T22:15:40+01:00 · deploy.runbook.md · checked: Open http://localhost:8080
```

- **A header per run:** the time, the runbook, the step number (as Export Report numbers it),
  the heading it is under, and its `name=` or first line; then the script as it runs (`$ `).
  A line run leaves the script out, since each line is echoed in the output.
- **Output with a gutter:** `| ` for stdout, `! ` for stderr, so `grep '^! '` finds the errors.
  A line is written once it is complete, as the saved output writes it (what a terminal shows,
  no colours), at most a tenth of a second after it arrived. A file only grows, so a program
  that redraws lines already written (a spinner over several lines) leaves each frame here.
- **A footer:** exit, duration, and whether a check passed, the attempt and the lines of a line
  run. A retry marks each new attempt (`----- attempt 2/40`) below the last one's output.
- **Checklist items** ticked or unticked by clicking are noted on a line of their own.
- **Redacted like a saved runbook**, line by line and a private key block at once, also with
  live redaction off. A cell with `capture-secret=` holds its output until it has finished, so
  the captured value is redacted too (a file can't be redrawn).
- **The file only grows:** past 10 MB it is renamed to `….transcript.log.1` (replacing an older
  one) and a new one starts. A run copy has a transcript of its own.
- The folder is created when needed. If the file can't be written, a warning says so once and
  the transcript stops for the session; the runs are not affected.

The transcript is on by default. It holds what the outputs hold, so keep it out of Git:

```gitignore
*.transcript.log
*.transcript.log.1
```

Turn it off with `mdRunbook.output.transcript`, or put the files elsewhere with
`mdRunbook.output.transcriptFolder` (relative to the runbook's folder, or absolute) and name them
with `mdRunbook.output.transcriptExtension` (`.transcript.log`: what replaces `.md`; a dot first,
no spaces or slashes, not `.md`). All three are user settings only. The command line writes one
with [`--transcript FILE`](cli.md#options).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.output.historySize` | `0` | Earlier outputs kept per cell when it is re-run. `0` = off. |
| `mdRunbook.output.mode` | `"inPlace"` | `"copy"` makes **Run All as Copy** the primary action and hints at it when cells are run in place. |
| `mdRunbook.output.copyFolder` | `""` | Folder for run copies, relative to the runbook's folder (or absolute). Empty = next to the runbook. |
| `mdRunbook.output.saveAfterRun` | `"copies"` | Save after each run: `"copies"` only run copies, `true` every runbook, `false` never. |
| `mdRunbook.output.transcript` | `true` | Append every run to `<runbook>.transcript.log` as it happens ([Transcript](#transcript)). |
| `mdRunbook.output.transcriptFolder` | `""` | Folder for transcripts, relative to the runbook's folder (or absolute). Empty = next to the runbook. |
| `mdRunbook.output.transcriptExtension` | `".transcript.log"` | What replaces `.md` in a transcript's name. |

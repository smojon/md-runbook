# Output history, run copies and diffs

md-runbook can keep earlier outputs of a cell, mark whether a re-run changed the output, show
a diff against the previous run, and run a runbook as a timestamped copy so the original stays
a clean template.

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
relative paths keep working even when `mdRunbook.output.copyFolder` puts the copy elsewhere:

```json
"mdRunbook.output.copyFolder": "runs"
```

With `"mdRunbook.output.mode": "copy"`, **Run All as Copy** moves to the front of the notebook
toolbar, and running cells in place in a runbook shows a one-time hint offering a copy instead.
Running in place still works.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.output.historySize` | `0` | Earlier outputs kept per cell when it is re-run. `0` = off. |
| `mdRunbook.output.mode` | `"inPlace"` | `"copy"` makes **Run All as Copy** the primary action and hints at it when cells are run in place. |
| `mdRunbook.output.copyFolder` | `""` | Folder for run copies, relative to the runbook's folder (or absolute). Empty = next to the runbook. |

# Run from the text editor and export a report

## Run from the plain Markdown editor (CodeLens)

You don't have to open a file as a runbook to run it. In the normal Markdown text editor, each
runnable code block (`sh`, `bash`, `pwsh`, `powershell`, `cmd`) gets a line of CodeLens above its
opening fence:

```text
▶ Run | ▶ Run below | ✓ exit 0 · 1.2s · 5m ago
```

- **▶ Run** runs this block.
- **▶ Run below** runs this block and every runnable block after it, in order. It stops at the
  first block that fails, times out or is cancelled (`mdRunbook.execution.stopOnFailure`).
- The last part summarizes the block's stored output: `✓`/`✗`, the exit code (or `timeout`,
  `cancelled`, …), the duration and how long ago it ended. Hover it for the exact times. It only
  appears when the block has an output block.

While a block runs, its CodeLens shows **Running…**, the output streams into the **md-runbook**
output channel, and a notification shows progress. **Cancel** in the notification kills the
whole process tree, just like stopping a cell in the notebook.

When a block finishes, its output block is written into the document right after the code block
(an existing one is replaced), in exactly the format described in
[Output format](../../README.md#output-format). The edit touches only the output block, so undo
and the cursor behave normally. **The file is not saved**: review the change and save it
yourself (or undo it).

The run uses the same settings as the notebook: shells (`mdRunbook.shell.*`), timeout,
environment (`mdRunbook.execution.env`), the folder of the `.md` file as working directory, and
output cleanup, truncation and [secret redaction](../../README.md#secret-redaction) before the
output goes into the document. Live output in the output channel is redacted only if
`mdRunbook.redaction.applyToLiveOutput` is on. Blocks of one file never run at the same time;
clicking Run again queues the next run.

The commands **md-runbook: Run Code Block in Text Editor** and **md-runbook: Run Code Block and
Below in Text Editor** do the same for the block at (or above) the cursor. From scripts or
keybindings they take `(uri, cellIndex)`, where `cellIndex` is the index of the block among the
document's cells, the same as its cell index in the notebook view.

Limits:

- Extensions that hook into notebook runs (per-cell options, injected secrets, persistent
  sessions) work in the notebook view only. Text-editor runs always run each block as its own
  process with the global settings.
- VS Code normalizes the line endings of a document open as text, so a file with mixed line
  endings is saved with one kind. Open it as a runbook to keep mixed line endings byte for byte.
- If `mdRunbook.output.persist` is off, output only goes to the output channel.

## Export Report (HTML)

**md-runbook: Export Report (HTML)** (Command Palette, notebook toolbar, Explorer context menu)
turns a runbook into a single HTML file, `<name>.report.html`, next to the `.md` file. It works on
an open runbook (including outputs that aren't saved yet), on a file open as text, and on a file
that isn't open. Afterwards, **Open** shows it in your browser.

The report contains:

- the title (the first heading, or the file name) and when it was generated, with a count of
  passed, failed and not-run steps,
- a summary table with one row per runnable block: step number, first line of code, shell,
  exit status (`✓ exit 0`, `✗ exit 1`, `not run`, …), start time and duration. Each row links to
  the step,
- the whole document: headings, paragraphs, lists and task lists, block quotes, tables, inline
  code, bold/italic, links and fenced code blocks with their language. Each runnable block is
  followed by its stored output and exit badge.

The file is self-contained: inline CSS with light and dark themes (following the system's
`prefers-color-scheme`), no scripts, no external resources (images are shown as links), and a
Content Security Policy that blocks anything else. Raw HTML in the Markdown is never passed
through: it is shown as text. HTML comments and md-runbook markers are dropped. Only `http`,
`https`, `mailto` and relative links are kept. Outputs are the redacted text stored in the file,
and are run through the current redaction settings once more.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.codeLens.enabled` | `true` | Show Run / Run below / last result above runnable blocks in the Markdown text editor. |
| `mdRunbook.report.folder` | `""` | Where reports are written. Empty = next to the `.md` file. A relative path is resolved against the file's workspace folder (or its folder outside a workspace); an absolute path is used as is. |

For example, to collect all reports in a `reports` folder of the workspace:

```json
"mdRunbook.report.folder": "reports"
```

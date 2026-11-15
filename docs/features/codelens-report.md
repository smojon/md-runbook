# Run from the text editor and export a report

## Run from the plain Markdown editor (CodeLens)

This is **off by default**: turn on `mdRunbook.codeLens.enabled` to use it.

Text-editor runs skip the notebook's approval, policy and secret injection. So for safety they:

- refuse proposed and assistant-written cells;
- refuse blocks that use `${secret:…}`, `${input:…}` or `${param:…}` references. They are
  resolved only in the runbook view; a shell would silently misread them.
- still ask before risky commands.

You don't have to open a file as a runbook to run it. The runnable code blocks are `sh`, `bash`,
`pwsh`, `powershell` and `cmd`. In the normal Markdown text editor, each gets a line of CodeLens
above its opening fence:

```text
▶ Run | ▶ Run below | ✓ exit 0 · 1.2s · 5m ago
```

- **▶ Run** runs this block.
- **▶ Run below** runs this block and every runnable block after it, in order. It stops at the
  first block that fails, times out or is cancelled (`mdRunbook.execution.stopOnFailure`).
- The last part summarizes the block's stored output: `✓`/`✗`, the exit code, the duration and
  how long ago it ended. Instead of the exit code, it can show `timeout`, `cancelled`, and so on.
  It only appears when the block has an output block; hover it for the exact times.

While a block runs:

- its CodeLens shows **Running…**;
- the output streams into the **md-runbook** output channel;
- a notification shows progress. **Cancel** in the notification kills the whole process tree,
  like stopping a cell in the notebook.

When a block finishes, its output block is written into the document right after the code block.
An existing one is replaced. The format is exactly the one described in
[Output format](../../README.md#output-format).

The edit touches only the output block, so undo and the cursor behave normally. **The file is not
saved**: review the change and save it yourself (or undo it).

The run uses the same settings as the notebook:

- shells (`mdRunbook.shell.*`);
- timeout;
- environment (`mdRunbook.execution.env`);
- the folder of the `.md` file as working directory;
- output cleanup, truncation and [secret redaction](../../README.md#secret-redaction) before the
  output goes into the document.

These per-block options apply as in the notebook (`mdRunbook.cellOptions.enabled`):

- `skip`: the block is reported as skipped and not run;
- `cwd=`, relative to the `.md` file's folder;
- `timeout=` and `env.NAME=`.

A block with an invalid option fails with the error instead of running.

Live output in the output channel always has known secret values redacted. VS Code also logs
output channels to disk. Redaction patterns are applied too when
`mdRunbook.redaction.applyToLiveOutput` is on.

Blocks of one file never run at the same time; clicking Run again queues the next run.

Two commands do the same for the block at (or above) the cursor:

- **md-runbook: Run Code Block in Text Editor**;
- **md-runbook: Run Code Block and Below in Text Editor**.

From scripts or keybindings, they take `(uri, cellIndex)`. `cellIndex` is the block's index
among the document's cells, the same as in the notebook view.

Limits:

- Extensions that hook into notebook runs (approval, policy, injected secrets, persistent
  sessions, `continue-on-error`, `name=`) work in the notebook view only. Text-editor runs always
  run each block as its own process with the global settings.
- VS Code normalizes the line endings of a document open as text. So a file with mixed line
  endings is saved with one kind. Open it as a runbook to keep mixed line endings byte for byte.
- If `mdRunbook.output.persist` is off, output only goes to the output channel.

## Export Report (HTML)

**md-runbook: Export Report (HTML)** turns a runbook into a single HTML file,
`<name>.report.html`, next to the `.md` file. It is in the Command Palette, the notebook toolbar
and the Explorer context menu.

It works on:

- an open runbook: exactly as a save would write it, plus unsaved outputs, even with
  `mdRunbook.output.persist` off;
- a file open as text;
- a file that isn't open.

Afterwards, **Open** shows it in your browser.

The report contains:

- the title (the first heading, or the file name) and when it was generated;
- a count of passed, failed and not-run steps;
- the **run record**, when the runbook has recorded times:
  - for an incident (`incident:` in the front matter, what **Start Incident** writes): its ID and
    severity;
  - start, end and duration;
  - when it was detected, mitigated and resolved (from **Add Note** milestones);
  - time to mitigate and to resolve;
  - the `rto:` target met or missed;
  - how many runs failed;
  - who ran steps on which machines;
  - then a **timeline** of every run, earlier attempt, step marked by hand and note, in time
    order. Each entry shows who ran it, where, the result and the duration.

  This is the page for audit evidence and postmortem meetings. Printed (PDF), every page shows
  the incident and its page number.
- a summary table with one row per runnable block, linking to the step. A row has the step
  number, first line of code, shell, exit status (`✓ exit 0`, `✗ exit 1`, `not run`, …), start
  time and duration.
- the whole document: headings, paragraphs, lists and task lists, block quotes and tables. Also
  inline code, bold/italic, links and fenced code blocks with their language. Each runnable block
  is followed by its stored output and exit badge.

The file is self-contained:

- inline CSS with light and dark themes, following the system's `prefers-color-scheme`;
- no scripts;
- no external resources: images are shown as links;
- a Content Security Policy that blocks anything else.

Raw HTML in the Markdown is never passed through: it is shown as text. HTML comments and
md-runbook markers are dropped. YAML front matter is shown as a small "front matter" block.

Only `http`, `https`, `mailto` and relative links are kept. Protocol-relative links (`//host/…`,
`\\host\…`) are dropped, since from a local report they would open network (SMB) paths.

Outputs are the redacted text stored in the file, run through the current redaction settings once
more. Code (the summary table, each step and other fenced blocks) and front matter go through the
same redaction.

## Export Report (PDF)

**md-runbook: Export Report (PDF)** (Command Palette, Explorer context menu) writes the same
report as `<name>.report.pdf`. A Chromium-based browser that is already installed prints it:
Google Chrome, Microsoft Edge (on every Windows machine) or Chromium. Nothing is bundled or
downloaded.

The browser runs headless with a throwaway profile, so a browser you have open is not touched.
The report has print styles: light colours, wrapped output. It asks the same leak check as the
HTML export.

Without a browser, it says so; the HTML export still works. The [command line](cli.md) has the
same as `--pdf`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.codeLens.enabled` | `false` | Show Run / Run below / last result above runnable blocks in the Markdown text editor. |
| `mdRunbook.report.folder` | `""` | Where reports are written. Empty = next to the `.md` file. A relative path is resolved against the file's workspace folder (or its folder outside a workspace); an absolute path is used as is. |
| `mdRunbook.report.browserPath` | `""` | The browser **Export Report (PDF)** prints with (the program file). Empty = the first Chrome, Edge or Chromium found. User settings only. |

For example, to collect all reports in a `reports` folder of the workspace:

```json
"mdRunbook.report.folder": "reports"
```

# Screenshots for the Marketplace and README

The README shows `docs/1-notebook.png` and `docs/2-saved-markdown.png`. The shots below add the
newer features. They all use [`examples/screenshots.runbook.md`](../examples/screenshots.runbook.md),
which only prints simulated `kubectl` output, so it runs anywhere and changes nothing.

## The demo GIF

`docs/demo.gif` (top of the README) is recorded, not drawn: `scripts/demo-gif/record.js` drives a
throwaway VS Code with the dev build through Run All, Save and Reopen as Text Editor, and
`scripts/demo-gif/make_gif.py` turns the frames into the GIF. Usage is at the top of each script.
Record it again when the notebook view changes visibly.

## Setup

- A development window with the current build:
  `code --extensionDevelopmentPath=<repo> examples/screenshots.runbook.md`
  (from a VS Code terminal: `env -u ELECTRON_RUN_AS_NODE code …`).
- Window about **1400 × 900**, default **Dark Modern** theme, zoom 0, minimap off, side bar
  closed, panel closed unless the shot needs it.
- Right-click the file → **Open as Runbook**. Clear outputs before each shot that starts fresh
  (**md-runbook: Clear All Outputs**). Don't save the demo file: outputs written into it would
  show up in the repository (or use **Revert File** afterwards).
- PNG, cropped to the editor area, under 1 MB.

## Shots

| File | Show | How |
|---|---|---|
| `docs/3-step-through.png` | Step Through paused on a line: the highlighted next line with its hint, the cell toolbar's Next / Run Rest / Stop buttons, the status bar `line 2 next (2/3)` | Section 3: cell dropdown next to ▶ → **Step Through Lines**; take the shot while it waits before line 2 |
| `docs/4-checks-retry.png` | A retried cell that passed its check: output with the last attempt, status line `exit code 0 · check passed · attempt 3/5` | Section 4: ▶ on the cell, wait ~3 s |
| `docs/5-capture-progress.png` | Captured value used by a later cell (`pod checkout-7c9d5b6f4-x2kqp terminated`) and the progress item in the status bar (`4/6`) | **Run All**, then scroll to sections 2–3 |
| `docs/6-os-blocks.png` | The two `os=` blocks of section 1: one with output, the other without (for the other OS) | After Run All, scroll to section 1 |
| `docs/7-report.png` | The HTML report in a browser: summary table with badges | **md-runbook: Export Report (HTML)** → Open; screenshot the browser |
| `docs/8-cli.png` | The command line in a terminal | `node out/dist/cli.js run examples/screenshots.runbook.md --check` |

## Then

Add them to `README.md` under the two existing images (the Marketplace page uses the README):

```markdown
![Step Through: run a cell line by line](docs/3-step-through.png)

![Checks and retries: wait until a rollout is done](docs/4-checks-retry.png)

![The same runbook from the command line, in CI](docs/8-cli.png)
```

Keep the README to about four images; the others fit the feature pages
(`docs/features/lines.md`, `checks.md`, `safety.md`, `codelens-report.md`, `cli.md`).

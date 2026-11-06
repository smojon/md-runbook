# Checking runbooks before they run

Some mistakes only show when a runbook runs: a misspelled option is ignored, a `${out:POD}`
has nothing to read. md-runbook checks for them while you edit, and `md-runbook lint` checks
files on the command line, for example on every pull request.

Section 17 of [`examples/sample.runbook.md`](../../examples/sample.runbook.md) has a misspelled
option on purpose, to show a marker.

| Problem | Severity |
|---|---|
| An invalid cell option value (`timeout=abc`, `os=dos`, `expect=/(/`) | error |
| `${out:NAME}` with no earlier block that has `capture=NAME` | error |
| A name used as two kinds of placeholder (`${input:X}` and `${param:X}`) | error |
| An unknown cell option (`retires=3`): it is ignored. A likely typo gets a suggestion (`did you mean "retry"?`): one or two letters off, or the plural of an option (`retries`) | warning |
| `every=` without `retry=` | warning |
| `${param:NAME}` not declared under `params:` in the front matter (no default; the command line needs `--param`) | warning |
| A front matter `mode:`, `timeout:` or `cwd:` value that is ignored (`mode: sometimes`) | warning |
| A front matter `shell:` name that is ignored: unknown (`fish`), a path (`/bin/zsh`), or a second one for the same cells | warning |

## In the editor

Problems are underlined in the runbook view (on the cell that has them; problems with a block's
fence options are marked on the cell's first line) and in the plain Markdown editor, and they are
listed in the **Problems** panel. Turn this off with `"mdRunbook.lint.enabled": false`.

A misspelled option with a suggestion has a **Quick Fix**: click the light bulb on the cell, or
press Ctrl+. (Cmd+. on macOS), then choose **Change "retires" to "retry"**. It renames the option
on the block's fence and keeps its value as written. This works in the runbook view and in the
Markdown editor.

## In the app

The md-runbook app (iPhone, Android, browser) runs the same checks when a runbook opens and after
each change. Each code cell lists its problems under it, with a mark beside the line concerned.
The top of the runbook counts them ("1 error, 2 warnings"): tap the count to list every problem,
front matter included, and tap one to go to its cell. **⋯ More → Go to Next Problem** goes
through them in turn. A misspelled option with a suggestion has a **Change "retires" to "retry"**
button under the problem, which renames the option as the Quick Fix does.

## On the command line

```sh
md-runbook lint runbooks/*.md            # exit 1 if a file has an error
md-runbook lint --strict runbooks/*.md   # also exit 1 on warnings
```

Each problem is printed as `file:line: severity: message`. On GitHub Actions they are also
annotations, so they show on the changed lines of a pull request:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npx md-runbook lint --strict runbooks/*.md
```

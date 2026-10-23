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
| An unknown cell option (`retires=3`): it is ignored | warning |
| `every=` without `retry=` | warning |
| `${param:NAME}` not declared under `params:` in the front matter (no default; the command line needs `--param`) | warning |
| A front matter `mode:`, `timeout:` or `cwd:` value that is ignored (`mode: sometimes`) | warning |
| A front matter `shell:` name that is ignored: unknown (`fish`), a path (`/bin/zsh`), or a second one for the same cells | warning |

## In the editor

Problems are underlined in the runbook view (on the cell that has them; problems with a block's
fence options are marked on the cell's first line) and in the plain Markdown editor, and they are
listed in the **Problems** panel. Turn this off with `"mdRunbook.lint.enabled": false`.

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

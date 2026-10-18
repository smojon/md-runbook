# Cell options, confirmations and context

## Cell options

Options go in the fence's info string, after the language word. The Markdown stays valid and
renders normally elsewhere:

````markdown
```bash timeout=300 cwd=../infra continue-on-error env.REGION=eu-west name="Rotate token"
./rotate.sh
```
````

| Option | Effect |
| --- | --- |
| `timeout=30` | Kill the cell after 30 seconds (overrides `mdRunbook.execution.timeoutSeconds`). `0` = no timeout. |
| `cwd=../infra` | Working directory, relative to the folder of the `.md` file (absolute paths work too, e.g. `cwd="C:\Program Files\x"`). |
| `continue-on-error` | **Run All** keeps going if this cell fails. |
| `skip` | Never run the cell; it is recorded as `exit=skipped`. |
| `confirm` | Always ask before running this cell. |
| `no-confirm` | Never ask before running this cell, even if it matches a risky pattern. |
| `env.NAME=value` | Set an environment variable for this cell. |
| `name="Rotate token"` | Recorded as `name="Rotate token"` in the output marker. |

- Values may be quoted with `"…"` or `'…'` to include spaces. Backslashes are taken literally,
  so Windows paths need no escaping.
- Unknown tokens and pandoc-style `{…}` attributes are ignored. An invalid value
  (`timeout=abc`) fails the cell with a message.
- Options are read from the file as it was opened. Cells added in the notebook have none.

## Confirming risky commands

Before a cell whose text matches one of `mdRunbook.execution.confirmPatterns` runs, a modal
dialog names the matching text and the current context (see below). Choosing anything other
than **Run** skips the cell and records it as `exit=skipped`. In **Run All**, declining also
stops the run, since later steps usually depend on the declined one. (A cell with the `skip`
option does not stop Run All.)

The default patterns cover `delete`, `drain`, `cordon`, `scale … --replicas=0`, `rm -rf`,
`--force`, `Remove-Item … -Recurse` and `drop table` / `drop database`. They are
case-insensitive JavaScript regular expressions matched against the whole cell text,
comments included.

```json
"mdRunbook.execution.confirmPatterns": [
  "\\b(delete|drain|cordon)\\b",
  "\\bhelm\\s+uninstall\\b"
]
```

## Recording the context

`mdRunbook.output.recordContext` maps attribute names to commands. Before a cell runs, each
command's first output line is added to the output marker, so the saved runbook shows where
it was run:

```json
"mdRunbook.output.recordContext": {
  "context": "kubectl config current-context",
  "server": "oc whoami --show-server"
}
```

```markdown
<!-- md-runbook:output start exit=0 ran=… ended=… duration=0.412s context=prod-eu server=https://api.prod-eu:6443 -->
```

- Commands run through the platform shell (`cmd.exe` on Windows, `/bin/sh` elsewhere) in the
  folder of the `.md` file, with `mdRunbook.execution.env` and the cell's `env.*` options set,
  and a 5 second timeout. A failing or silent command records `unknown`.
- Values are cached per runbook for `mdRunbook.output.recordContextCacheSeconds`.
- Values pass through secret redaction like output does. Don't record commands that print
  secrets.
- Skipped cells don't run the commands.

The attribute named by `mdRunbook.statusBar.contextAttr` (default `context`) is shown in the
status bar (`☁ prod-eu`) while a runbook is active. It is refreshed when you switch runbooks
and after every run.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.execution.confirm` | `"patterns"` | `patterns`: ask for cells matching a pattern. `always`: ask for every cell. `never`: never ask. Cell options `confirm` / `no-confirm` override it. |
| `mdRunbook.execution.confirmPatterns` | see above | Regular expressions for risky commands (case-insensitive). |
| `mdRunbook.output.recordContext` | `{}` | Attribute name → command whose first output line is recorded. |
| `mdRunbook.output.recordContextCacheSeconds` | `30` | How long recorded values are reused per runbook. `0` = run the commands before every cell. |
| `mdRunbook.statusBar.contextAttr` | `"context"` | Which recorded attribute the status bar shows. |

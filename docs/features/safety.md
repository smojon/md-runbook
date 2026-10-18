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
| `no-confirm` | Never ask before running this cell, even if it matches a risky pattern. **Ignored** unless `mdRunbook.execution.allowNoConfirmOption` is on in your user settings. |
| `env.NAME=value` | Set an environment variable for this cell. |
| `name="Rotate token"` | Recorded as `name="Rotate token"` in the output marker. |
| `expect="text"`, `expect=/regex/`, `expect-not=…`, `expect-exit=N` | Check the result; see [checks, retries and captured values](checks.md). |
| `retry=10 every=15s` | Run again until it passes, up to 10 attempts; see [checks.md](checks.md). |
| `capture=NAME`, `capture=NAME:/regex/`, `capture-secret=NAME` | Keep a value from the output for later cells (`${out:NAME}`); see [checks.md](checks.md). |

- Values may be quoted with `"…"` or `'…'` to include spaces. Backslashes are taken literally,
  so Windows paths need no escaping.
- Unknown tokens and pandoc-style `{…}` attributes are ignored. An invalid value
  (`timeout=abc`) fails the cell with a message.
- Options are read from the file as it was opened. Cells added in the notebook have none.

## Runbook defaults in the front matter

Besides `params:` ([parameters](secrets.md)) and `mode:` ([session mode](session.md)), the front
matter can set defaults for every cell of the runbook:

```markdown
---
cwd: ../infra
timeout: 300
---
```

| Key | Effect |
|---|---|
| `cwd: ../infra` | The folder cells run in (and session mode starts in), relative to the `.md` file's folder. A cell's own `cwd=` is still relative to the `.md` file's folder. |
| `timeout: 300` | Default timeout in seconds (`300s` works too) instead of `mdRunbook.execution.timeoutSeconds`. `0` = none. A cell's `timeout=` wins. |

These apply in the runbook view and to the text editor's ▶ Run CodeLens. Shell paths can't be
set in the front matter on purpose: a file from a repository must not choose which program runs
your cells (that would get around the command policy for approved assistant cells). Set them in
your user settings (`mdRunbook.shell.bashPath`, `mdRunbook.shell.pwshPath`).

## Confirming risky commands

Before a cell whose text matches one of `mdRunbook.execution.confirmPatterns` runs, a modal
dialog names the matching text and the context the cell will run in (see below). Choosing
anything other than **Run** does not run the cell and records it as `exit=declined`; progress
keeps such a step pending and **Resume Run** offers it again. In **Run All**, declining also
stops the run, since later steps usually depend on the declined one. (A cell with the `skip`
option is recorded as `exit=skipped`, counts as complete and does not stop Run All.)

When the confirmation is asked:

- Without `mdRunbook.output.recordContext`, right away, before any secret, input or parameter
  is asked for, so a declined cell never prompts for anything.
- With `mdRunbook.output.recordContext`, after the cell's environment is final (`.env` file,
  secrets, inputs, the read-only credentials of assistant cells), so the context shown, and
  recorded, is the cluster or server the cell will really use. Prompts for that cell's secrets,
  inputs or parameters therefore come before the confirmation.

The default patterns cover `delete`, `drain`, `cordon`, `scale … --replicas=0`, `rm -rf`,
`--force`, `Remove-Item … -Recurse`, `drop table` / `drop database`, `rollout restart|undo`,
`patch`, `apply`, `replace` (not PowerShell's `-replace` / `.Replace()`), `adm policy
add…|remove…`, `set env|image|resources`, `helm upgrade|rollback|uninstall`, `curl -X` /
`--request PUT|POST|PATCH|DELETE` and `Invoke-RestMethod|Invoke-WebRequest -Method
Put|Post|Patch|Delete`. They are case-insensitive JavaScript regular expressions matched
against the whole cell text, comments included.

```json
"mdRunbook.execution.confirmPatterns": [
  "\\b(delete|drain|cordon)\\b",
  "\\bhelm\\s+uninstall\\b"
]
```

## Recording the context

`mdRunbook.output.recordContext` maps attribute names to commands. Before a cell runs, each
command's first output line is added to the output marker, so the saved runbook shows where
it was run. The commands run with the cell's final environment (after the `.env` file,
secrets and read-only credentials), so a `KUBECONFIG` set by any of them is the one recorded:

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
  folder of the `.md` file, with the cell's environment (`mdRunbook.execution.env`, `env.*`
  options, `.env`, secrets, read-only credentials) set, and a 5 second timeout. A failing or silent command records `unknown`.
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
| `mdRunbook.cellOptions.enabled` | `true` | Apply the options above. Turn off to ignore options written in runbooks. |
| `mdRunbook.execution.allowNoConfirmOption` | `false` | Honour `no-confirm`. User settings only. |
| `mdRunbook.execution.confirm` | `"patterns"` | `patterns`: ask for cells matching a pattern. `always`: ask for every cell. `never`: never ask. Cell options `confirm` / `no-confirm` override it. |
| `mdRunbook.execution.confirmPatterns` | see above | Regular expressions for risky commands (case-insensitive). |
| `mdRunbook.output.recordContext` | `{}` | Attribute name → command whose first output line is recorded. |
| `mdRunbook.output.recordContextCacheSeconds` | `30` | How long recorded values are reused per runbook. `0` = run the commands before every cell. |
| `mdRunbook.statusBar.contextAttr` | `"context"` | Which recorded attribute the status bar shows. |

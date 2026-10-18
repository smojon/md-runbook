# Persistent sessions

By default every cell runs in a new shell process, so `cd`, variables and logins are gone by the
next cell. In **session mode** each runbook keeps one long-lived shell process per shell, and
cells run in it one after the other, like commands typed into the same terminal:

```json
"mdRunbook.execution.mode": "session"
```

````markdown
```bash
cd deploy
export NAMESPACE=staging
oc login --token="$OC_TOKEN" https://api.example.com:6443
```

```bash
oc get pods -n "$NAMESPACE"     # still in deploy/, still logged in
```
````

The same works for PowerShell:

````markdown
```pwsh
Set-Location deploy
$env:NAMESPACE = 'staging'
function Get-Ready { kubectl get pods -n $env:NAMESPACE }
```

```pwsh
Get-Ready
```
````

## What carries over

- **bash/sh:** the working directory, shell and exported variables, functions, aliases, `set`
  options (including `set -e`, see below) and anything a command stored in the environment.
- **PowerShell:** the location, variables, `$env:` variables, functions, modules and preference
  variables such as `$ErrorActionPreference`.
- **cmd** has no session mode: `cmd` cells always run in their own process.

Each runbook has its own sessions: one for `sh`/`bash` cells and one for `pwsh`/`powershell`
cells. A session starts in the folder of the `.md` file when its first cell runs. Later cells
do **not** go back to that folder: a `cd` stays in effect, just like in a terminal.

`mdRunbook.execution.env` and other per-cell variables are set before each cell and stay set.

## Status bar and commands

While a session is running for the active runbook, the status bar shows
`$(terminal) session: bash, pwsh`. Click it to restart.

| Command | Description |
| --- | --- |
| **md-runbook: Restart Session** | Kill this runbook's sessions and start fresh ones in the `.md` file's folder. |
| **md-runbook: Stop Session** | Kill this runbook's sessions. The next cell starts a new one. |

Sessions also end when the runbook is closed, when VS Code exits, and when
`mdRunbook.execution.mode` is switched back to `isolated`.

## Exit codes, exit, cancel and timeout

- Exit codes follow the same rules as isolated mode: **bash/sh** report the status of the cell's
  last command; **PowerShell** fails on a terminating error or a non-zero exit code of the last
  native command. The status line shows `bash session` / `pwsh session`.
- **bash/sh:** `exit N` ends the session. The cell reports exit code `N` and
  `[md-runbook] session ended (exit N); the next cell starts a new session`. The same happens
  when a command fails after `set -e`. Use `return N` to end a cell early without ending the
  session.
- **PowerShell:** `exit N` ends only the cell, with exit code `N`; the session keeps running.
- **Cancel** and `mdRunbook.execution.timeoutSeconds` kill the session's whole process tree,
  including background jobs. The next cell starts a new session and its output begins with
  `[md-runbook] new session started`.

## Caveats

- Standard input: bash cells read from an empty input, as in isolated mode. In PowerShell cells,
  a native command that waits for input (for example a login prompt) waits until you cancel the
  cell. Pass credentials as arguments or environment variables instead.
- Output that a background job prints between cells is discarded.
- Commands that replace the shell or its output (`exec`, `exec >file`) affect all later cells.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.execution.mode` | `"isolated"` | `isolated`: a new process for every cell. `session`: one long-lived bash and PowerShell process per runbook, so state carries over between cells. |

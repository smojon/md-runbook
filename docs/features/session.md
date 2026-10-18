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

## Turning it on and off

The mode is decided per runbook, in this order:

1. **Toggle Session Mode** (notebook toolbar `$(terminal)`, the status bar, or the Command
   Palette) switches only the current runbook. VS Code remembers the choice for this workspace.
   Toggling back to what the runbook would get anyway removes the override.
2. **`mode:` in the front matter** makes a runbook default to session (or isolated) mode for
   everyone who opens it:

   ```markdown
   ---
   mode: session
   ---
   ```
3. **`mdRunbook.execution.mode`** is the default for everything else.

Switching a runbook to isolated stops its sessions at once.

## Starting clean

After **Restart Session** (or **Stop Session**), the next cell runs in a new shell. It has only
VS Code's environment plus the configured variables, which are applied again before every cell:
`mdRunbook.execution.env`, the `.env` file, `mdRunbook.secrets.inject`, and whatever the cell
references (`${secret:…}`, `${input:…}`, `${param:…}`). Everything earlier cells set is gone.

To make every full run start clean, set `mdRunbook.session.resetOnRunAll` to `true`: **Run
All** then begins in a fresh session. Running single cells, a range or **Resume Run** keeps the
current session, since those usually rely on earlier steps.

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

For the active runbook the status bar shows the mode: `$(debug-disconnect) isolated`, or
`$(terminal) session: bash, pwsh` with the running shells. Its tooltip says whether the mode comes
from the toggle, the front matter or the setting. Click it to switch, restart or stop.

| Command | Description |
| --- | --- |
| **md-runbook: Toggle Session Mode** | Switch the current runbook between session and isolated mode. |
| **md-runbook: Restart Session** | Kill this runbook's sessions and start fresh ones in the `.md` file's folder. |
| **md-runbook: Stop Session** | Kill this runbook's sessions. The next cell starts a new one. |

Sessions also end when the runbook is closed, when VS Code exits, and when the runbook is
switched to isolated mode.

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
| `mdRunbook.execution.mode` | `"isolated"` | Default mode. `isolated`: a new process for every cell. `session`: one long-lived bash and PowerShell process per runbook, so state carries over between cells. Overridden by front matter `mode:` and by the toggle. |
| `mdRunbook.session.resetOnRunAll` | `false` | Start **Run All** in a fresh session. |

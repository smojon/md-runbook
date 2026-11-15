# Terminal mode (interactive prompts)

Normal runs have no input attached. A command that asks for a password or a `[y/N]` answer gets
end-of-input and fails at once.

**Terminal mode** runs a cell in a real VS Code terminal instead, so you can answer prompts there.
Examples: `sudo`, `ssh` passwords, `oc login` without a token, `Read-Host -AsSecureString`,
confirmations.

It is **off by default**. Turn it on in your user settings:

```json
"mdRunbook.terminal.mode": "perCell"
```

Then mark the cells that need it:

````markdown
```bash terminal
oc login https://api.example.com:6443     # asks for username and password
```
````

The cell runs in a terminal named `md-runbook: <file> (bash)`, which gets the focus so you can type.
When the command ends, its output and exit code are written to the cell. They are saved like any
other run: redacted, with `exit=`, `ran=`, `ended=`, `duration=`.

## What the terminal shows

Before the cell runs, the terminal shows its commands as if typed: in bold, after a dim prompt.
The prompt is `$ ` for bash, `PS> ` for PowerShell and `> ` for cmd; a continued line
gets `> ` or `>> `. Then the cell's output follows.

Showing commands makes terminal mode useful for teaching too: with
`"mdRunbook.terminal.mode": "always"`, a learner sees every command run, step by step.

- The commands show as written in the runbook: `${secret:TOKEN}` stays a reference, and no
  secret value is ever shown. A line run shows the line it runs, with references as environment
  variables.
- The commands shown are not part of the cell's output. Checks, captures and the saved file see
  only what the commands print.
- Above the commands is the line md-runbook typed to start the cell's script (see
  *Requirements and limits*, last item).

## Security

- **What you type never passes through md-runbook.** Keystrokes go straight to the program;
  password prompts don't echo, so passwords never appear in the captured output.
- The usual checks run first: proposed cells are skipped, the command policy and the
  risky-command confirmation apply.
- **Cells written by an assistant never run in a terminal**, even with the `terminal` option.
- The output shown on screen goes through redaction like normal runs.

## How it works

- One terminal per runbook and shell (bash, PowerShell). It is reused while the working directory
  and environment stay the same, and replaced when they change. It is closed with the runbook.
- The terminal is transient: VS Code does not restore it (or its environment and scrollback)
  after a reload.
- The cell's script runs in a child process of the configured shell. So `exit`,
  `cd`/`Set-Location` and variables in a cell end with the cell instead of changing the terminal.
  Use [session mode](session.md) to carry state over.
- The configured shell is `mdRunbook.shell.bashPath` / `pwshPath`, or the one md-runbook finds,
  or the runbook's `shell:`. PowerShell runs the script with `-NoProfile`, and on Windows with
  `-ExecutionPolicy Bypass`, as normal runs do.
- Output and exit code are captured through VS Code's terminal shell integration.
- The command also writes its exit code to a private temporary file. Shell integration
  occasionally loses its report of the command's end. If that report never comes, the cell ends
  3 seconds after that file appears instead of waiting forever.
- The exit code follows the same rules as normal runs (for PowerShell: the last native command,
  `exit N`, or an error).
- If the terminal reports the command's end but no exit code was recorded, the cell fails with
  "result is unknown". The next cell gets a new terminal. One cause: the output contained a
  fake shell-integration mark.
- Cancel sends Ctrl+C. If the command doesn't stop within 3 seconds, everything running in the
  terminal is killed and the terminal is closed. A command that stops in time leaves the terminal
  open for the next cell.
- `timeoutSeconds` and the `timeout=` option work the same way. Both also apply while waiting for
  shell integration to start.

## Line runs

[Run Line or Selection, Run Lines One by One and Step Through](lines.md) work on terminal cells
too. A line run opens a terminal of its own, `md-runbook: <file> (<shell>, lines)`. It runs each
line directly in that terminal's shell, so `cd` and variables carry over from line to line.

The terminal is closed when the run ends. A line that runs `exit` closes it early; the next line
gets a new one.

## Requirements and limits

- VS Code **1.93 or newer** with terminal shell integration enabled
  (`terminal.integrated.shellIntegration.enabled`, on by default).
- Supported shells: bash (including Git Bash), zsh and PowerShell.
- **cmd** cells run too: cmd.exe has no shell integration, so they run from a PowerShell terminal.
  Each runs in a `cmd.exe` of its own, as cmd cells always do. Prompts such as `set /p`, `pause`
  or `choice` are answered there.
- `shell: sh` has no shell integration either. In a runbook with it, cells run from a bash
  terminal, each in an `sh` of its own. So the lines of a line run don't share `cd` or variables
  there, as with cmd cells.
- `shell: zsh` gets a zsh terminal.
- If shell integration does not start within 10 seconds, the cell fails with an explanation
  instead of running blind.
- Prompts and anything else the program prints become part of the saved output (redacted).
- The typed command line in the terminal is a little longer than the cell. It also records the
  exit code in a temporary file, and pauses half a second to capture the last output.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.terminal.mode` | `"off"` | `off`: never use a terminal (a `terminal` cell runs normally, with a note in its output). `perCell`: cells with the `terminal` option. `always`: every bash, PowerShell and cmd cell (assistant-written cells still run normally). User settings only. |

# Terminal mode (interactive prompts)

Normal runs have no input attached: a command that asks for a password or a `[y/N]` answer gets
end-of-input and fails at once. **Terminal mode** runs a cell in a real VS Code terminal instead,
so you can answer prompts there: `sudo`, `ssh` passwords, `oc login` without a token,
`Read-Host -AsSecureString`, confirmations.

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
When the command ends, its output and exit code are written to the cell and saved like any other
run (redacted, with `exit=`, `ran=`, `ended=`, `duration=`).

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
  It is a transient terminal: VS Code does not restore it (or its environment and scrollback)
  after a reload.
- The cell's script runs in a child process of the configured shell (`mdRunbook.shell.bashPath`
  / `pwshPath`, or the one md-runbook finds, or the runbook's `shell:`), so `exit`, `cd`/`Set-Location` and variables in a
  cell end with the cell instead of changing the terminal (use [session mode](session.md) to
  carry state over). PowerShell runs it with `-NoProfile`, and on Windows with
  `-ExecutionPolicy Bypass`, as normal runs do.
- Output and exit code are captured through VS Code's terminal shell integration. The command
  also writes its exit code to a private temporary file; if shell integration never reports the
  end of the command (it occasionally loses that report), the cell ends 3 seconds after that file
  appears instead of waiting forever.
- The exit code
  follows the same rules as normal runs (for PowerShell: the last native command, `exit N`, or
  an error). If the terminal reports the end of the command but no exit code was recorded (for
  example because the output contained a fake shell-integration mark), the cell fails with
  "result is unknown" and the next cell gets a new terminal.
- Cancel sends Ctrl+C. If the command doesn't stop within 3 seconds, everything running in the
  terminal is killed and the terminal is closed; a command that stops in time leaves the
  terminal open for the next cell. `timeoutSeconds` and the `timeout=` option work the same
  way, and both also apply while waiting for shell integration to start.

## Line runs

[Run Line or Selection, Run Lines One by One and Step Through](lines.md) work on terminal cells
too. A line run opens a terminal of its own, `md-runbook: <file> (<shell>, lines)`, and runs
each line directly in that terminal's shell, so `cd` and variables carry over from one line to
the next. The terminal is closed when the run ends. A line that runs `exit` closes it early; the
next line gets a new one.

## Requirements and limits

- VS Code **1.93 or newer** with terminal shell integration enabled
  (`terminal.integrated.shellIntegration.enabled`, on by default). Supported shells: bash
  (including Git Bash), zsh and PowerShell. **cmd** cells run too: cmd.exe has no shell
  integration, so they run from a PowerShell terminal, each in a `cmd.exe` of its own (as cmd
  cells always do), and prompts such as `set /p`, `pause` or `choice` are answered there. In a
  runbook with `shell: sh` (no shell integration either), cells run from a bash terminal, each in
  an `sh` of its own, so the lines of a line run don't share `cd` or variables there (as with cmd
  cells); `shell: zsh` gets a zsh terminal.
- If shell integration does not start within 10 seconds, the cell fails with an explanation
  instead of running blind.
- Prompts and anything else the program prints become part of the saved output (redacted).
- The typed command line in the terminal is a little longer than the cell: it also records the
  exit code in a temporary file and pauses half a second so the last output is captured.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.terminal.mode` | `"off"` | `off`: never use a terminal (a `terminal` cell runs normally, with a note in its output). `perCell`: cells with the `terminal` option. `always`: every bash, PowerShell and cmd cell (assistant-written cells still run normally). User settings only. |

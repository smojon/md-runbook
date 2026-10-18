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
- The cell's script runs as a child of the terminal shell, so `exit` in a cell ends the cell, not
  the terminal, and variables don't carry over between cells (use [session mode](session.md)
  for that).
- Output and exit code are captured through VS Code's terminal shell integration. The exit code
  follows the same rules as normal runs (for PowerShell: the last native command, `exit N`, or
  an error).
- Cancel sends Ctrl+C; if the command doesn't stop within 3 seconds the terminal is closed.
  `timeoutSeconds` and the `timeout=` option work the same way.

## Requirements and limits

- VS Code **1.93 or newer** with terminal shell integration enabled
  (`terminal.integrated.shellIntegration.enabled`, on by default). Supported shells: bash
  (including Git Bash), zsh and PowerShell. **cmd is not supported.**
- If shell integration does not start within 10 seconds, the cell fails with an explanation
  instead of running blind.
- Prompts and anything else the program prints become part of the saved output (redacted).
- The typed command line in the terminal is a little longer than the cell: it also records the
  exit code in a temporary file and pauses half a second so the last output is captured.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `mdRunbook.terminal.mode` | `"off"` | `off`: never use a terminal (the `terminal` option is ignored). `perCell`: cells with the `terminal` option. `always`: every bash/PowerShell cell (cmd and assistant-written cells still run normally). User settings only. |

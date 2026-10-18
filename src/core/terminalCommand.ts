/** Command lines for running a cell's script file in an interactive terminal. */

import type { ShellKind } from './shell';

/** Quote for POSIX shells: single quotes, with embedded single quotes closed and escaped. */
export function quoteSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote for PowerShell: single quotes, embedded single quotes doubled. */
export function quotePwsh(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * What to type into a terminal of `kind` to run the script at `scriptArg` (paths already in the
 * form the shell expects, e.g. forward slashes for Git Bash). The script runs as a child of the
 * terminal shell, so a cell's `exit` ends the script, not the terminal.
 *
 * The exit code is written to `statusArg` (the terminal's own exit-code report is coarse for
 * PowerShell), using the same rules as normal runs. The short pause at the end lets the last
 * output reach VS Code's output stream before the command is reported as finished.
 */
export function terminalCommandLine(kind: Exclude<ShellKind, 'cmd'>, scriptArg: string, statusArg: string): string {
  if (kind === 'bash') return `bash ${quoteSh(scriptArg)}; printf '%s' $? > ${quoteSh(statusArg)}; sleep 0.5`;
  return (
    `$global:LASTEXITCODE = 0; & ${quotePwsh(scriptArg)}; $mdrbOk = $?; ` +
    `Set-Content -NoNewline -Path ${quotePwsh(statusArg)} -Value $(if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $mdrbOk) { 1 } else { 0 }); ` +
    'Start-Sleep -Milliseconds 500'
  );
}

/** The exit code a terminal command wrote with terminalCommandLine, if any. */
export function parseStatus(text: string | undefined): number | undefined {
  const n = Number((text ?? '').trim());
  return (text ?? '').trim() !== '' && Number.isInteger(n) ? n : undefined;
}

/** Stable key for terminal reuse: a terminal is recreated when its cwd or environment changes. */
export function terminalSignature(kind: string, command: string, cwd: string, env: Record<string, string>): string {
  const keys = Object.keys(env).sort();
  return JSON.stringify([kind, command, cwd, keys.map((k) => [k, env[k]])]);
}

const OSC_SHELL_INTEGRATION = /\x1b\](?:633|133);[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const COMMAND_STARTED = /\x1b\](?:633|133);C(?:\x07|\x1b\\)/;

/**
 * Cleans the raw stream of a terminal command for the cell output: everything before the
 * "command started" mark (prompt, echoed command line) is dropped, and the remaining shell
 * integration marks are removed. Feed chunks in order; keeps state across chunk boundaries.
 */
export class TerminalOutputFilter {
  private started = false;
  private pending = '';

  push(chunk: string): string {
    let text = this.pending + chunk;
    this.pending = '';
    if (!this.started) {
      const m = COMMAND_STARTED.exec(text);
      if (!m) {
        // Keep a tail in case the mark is split across chunks.
        this.pending = text.slice(-32);
        return '';
      }
      this.started = true;
      text = text.slice(m.index + m[0].length);
    }
    // Hold back an unfinished escape sequence at the end.
    const cut = text.lastIndexOf('\x1b');
    if (cut >= 0 && !/(?:\x07|\x1b\\)/.test(text.slice(cut + 1)) && text.length - cut < 512 && (text[cut + 1] === undefined || text[cut + 1] === ']')) {
      this.pending = text.slice(cut);
      text = text.slice(0, cut);
    }
    return text.replace(OSC_SHELL_INTEGRATION, '');
  }

  /** Whatever is left at the end (only after the command started). */
  flush(): string {
    const rest = this.started ? this.pending.replace(OSC_SHELL_INTEGRATION, '') : '';
    this.pending = '';
    return rest;
  }
}

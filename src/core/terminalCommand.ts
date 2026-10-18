/** Command lines for running a cell's script file in an interactive terminal. */

import type { ShellKind } from './shell';

/** Quote for POSIX shells: single quotes, with embedded single quotes closed and escaped. */
export function quoteSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote for PowerShell: single quotes, embedded single quotes doubled. PowerShell also treats the
 * typographic quotes ‘ ’ ‚ ‛ as single quotes, so those are doubled too.
 */
export function quotePwsh(s: string): string {
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
}

/**
 * What to type into a terminal of `kind` to run the script at `scriptArg` (paths already in the
 * form the shell expects, e.g. forward slashes for Git Bash). The script runs in a child process
 * of the resolved shell (`shellCommand`), so a cell's `exit`, `cd`/`Set-Location` and variables
 * end with the cell instead of changing the terminal.
 *
 * The exit code is written to `statusArg` (the terminal's own exit-code report is coarse for
 * PowerShell), using the same rules as normal runs. The short pause at the end lets the last
 * output reach VS Code's output stream before the command is reported as finished.
 */
export function terminalCommandLine(
  kind: Exclude<ShellKind, 'cmd'>,
  shellCommand: string,
  scriptArg: string,
  statusArg: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const win = platform === 'win32';
  if (kind === 'bash') {
    // Git Bash runs C:/x/y paths; backslashes would be escapes.
    const bash = quoteSh(win ? shellCommand.replace(/\\/g, '/') : shellCommand);
    return `${bash} ${quoteSh(scriptArg)}; printf '%s' $? > ${quoteSh(statusArg)}; sleep 0.5`;
  }
  // The same exit-code rules as normal runs (pwshWrapper in shell.ts), minus the UTF-8 setup a
  // terminal doesn't need; the child's exit code is in $LASTEXITCODE. No -NonInteractive: the point of terminal mode is answering prompts.
  // Bypass on Windows, where Windows PowerShell's default policy refuses to run script files.
  const wrapper = [
    '$global:LASTEXITCODE = 0',
    `& ${quotePwsh(scriptArg)}`,
    '$mdRunbookOk = $?',
    'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $mdRunbookOk) { exit 1 } else { exit 0 }',
  ].join('; ');
  const args = ['-NoLogo', '-NoProfile', ...(win ? ['-ExecutionPolicy', 'Bypass'] : []), '-Command', quotePwsh(wrapper)];
  return (
    `$global:LASTEXITCODE = 0; & ${quotePwsh(shellCommand)} ${args.join(' ')}; $mdrbOk = $?; ` +
    `Set-Content -NoNewline -Path ${quotePwsh(statusArg)} -Value $(if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $mdrbOk) { 1 } else { 0 }); ` +
    'Start-Sleep -Milliseconds 500'
  );
}

/** The exit code a terminal command wrote with terminalCommandLine, if any. */
export function parseStatus(text: string | undefined): number | undefined {
  const n = Number((text ?? '').trim());
  return (text ?? '').trim() !== '' && Number.isInteger(n) ? n : undefined;
}

/**
 * Process ids below `root` (children first, then grandchildren, ...) in the output of
 * `ps -A -o pid=,ppid=`. A terminal shell runs each job in its own process group, so killing the
 * shell's group alone misses them.
 */
export function descendants(psOutput: string, root: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const seen = new Set([root]);
  const queue = [root];
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    for (const c of children.get(p) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
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

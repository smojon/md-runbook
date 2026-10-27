/** Command lines for running a cell's script file in an interactive terminal. */

import type { ShellKind } from './shellKind';

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

/**
 * Like terminalCommandLine, but the script runs in the terminal's own shell, so `cd` and
 * variables stay for the next command. Used for the lines of one line run, in a terminal opened
 * for that run only. PowerShell dot-sources the file's text as a script block, which the
 * execution policy doesn't apply to (the terminal shell wasn't started with `-ExecutionPolicy`).
 */
export function terminalInlineCommandLine(kind: Exclude<ShellKind, 'cmd'>, scriptArg: string, statusArg: string): string {
  if (kind === 'bash') return `. ${quoteSh(scriptArg)}; printf '%s' $? > ${quoteSh(statusArg)}; sleep 0.5`;
  return (
    `$global:LASTEXITCODE = 0; . ([scriptblock]::Create([System.IO.File]::ReadAllText(${quotePwsh(scriptArg)}))); $mdrbOk = $?; ` +
    `Set-Content -NoNewline -Path ${quotePwsh(statusArg)} -Value $(if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $mdrbOk) { 1 } else { 0 }); ` +
    'Start-Sleep -Milliseconds 500'
  );
}

/**
 * A `cmd` cell in a terminal: cmd.exe has no shell integration, so the terminal is PowerShell
 * (which has) and the cell's batch file runs from it in a cmd.exe of its own, as cmd cells always
 * do. Prompts (`set /p`, `pause`, `choice`) are answered in the terminal; PowerShell reports the
 * end, and the batch file's exit code goes to `statusArg`. Typed into a PowerShell terminal.
 */
export function terminalCmdCommandLine(comspec: string, scriptArg: string, statusArg: string): string {
  return (
    `$global:LASTEXITCODE = 0; & ${quotePwsh(comspec)} /d /c ${quotePwsh(scriptArg)}; ` +
    `Set-Content -NoNewline -Path ${quotePwsh(statusArg)} -Value $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 0 }); ` +
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

/**
 * Marks around the cell's text shown in the terminal. Shell integration's own property sequence
 * (OSC 633 ; P): ConPTY passes it through on Windows, VS Code ignores a property it doesn't know,
 * and the terminal displays nothing for it.
 */
const shownMark = (edge: 'Start' | 'End', nonce: string): string => `\x1b]633;P;MdRunbookShown${edge}=${nonce}\x07`;
/** Output held back while looking for the shown text before giving up on it. */
const SHOWN_WINDOW = 4096;

/**
 * What the terminal shows before a cell runs: its commands as typed at a prompt (`$ `, `PS> `,
 * `> ` for cmd; `> `/`>> ` for continued lines), so whoever watches the terminal sees what runs
 * rather than only the command line that starts the cell's script. `source` is the cell as
 * written, with `${secret:…}` references, never their values. Control characters are removed, so
 * a cell can't hide lines or fake the marks. Between the marks TerminalOutputFilter drops it, so
 * it is never part of the cell's output or its checks.
 */
export function terminalShownText(source: string, kind: ShellKind, nonce: string): string {
  const prompt = kind === 'bash' ? '$ ' : kind === 'pwsh' ? 'PS> ' : '> ';
  const more = kind === 'pwsh' ? '>> ' : '> ';
  const continues = kind === 'bash' ? '\\' : kind === 'pwsh' ? '`' : '^';
  const lines = source.split(/\r?\n/).map((l) => l.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, ''));
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  let continued = false;
  const shown = lines.map((line) => {
    const p = continued ? more : prompt;
    continued = line.trimEnd().endsWith(continues);
    return `\x1b[2m${p}\x1b[0m\x1b[1m${line}\x1b[0m\r\n`;
  });
  return shownMark('Start', nonce) + shown.join('') + shownMark('End', nonce);
}

/** Typed before a cell's command line: prints the file written from terminalShownText. */
export function terminalShowCommand(kind: Exclude<ShellKind, 'cmd'>, shownArg: string): string {
  return kind === 'bash' ? `cat ${quoteSh(shownArg)}; ` : `[Console]::Out.Write([System.IO.File]::ReadAllText(${quotePwsh(shownArg)})); `;
}

/** Any OSC sequence: shell integration marks, but also window titles (`ESC ]0;C:\...\pwsh.exe BEL`). */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const COMMAND_STARTED = /\x1b\](?:633|133);C(?:\x07|\x1b\\)/;

/**
 * Cleans the raw stream of a terminal command for the cell output: everything before the
 * "command started" mark (prompt, echoed command line) is dropped, and the remaining OSC
 * sequences (shell integration marks, window titles) are removed. Feed chunks in order; keeps state across chunk boundaries.
 * With `shownNonce`, the cell's text shown first (terminalShownText) is dropped too; should it
 * not arrive within the first few KB, the output is kept as it is.
 */
export class TerminalOutputFilter {
  private started = false;
  private pending = '';
  private shown: 'looking' | 'inside' | 'done';

  constructor(private readonly shownNonce?: string) {
    this.shown = shownNonce === undefined ? 'done' : 'looking';
  }

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
    if (this.shown !== 'done' && this.shownNonce !== undefined) {
      if (this.shown === 'looking') {
        const start = text.indexOf(shownMark('Start', this.shownNonce));
        if (start < 0) {
          if (text.length < SHOWN_WINDOW) {
            this.pending = text;
            return '';
          }
          this.shown = 'done';
        } else {
          this.shown = 'inside';
          text = text.slice(start);
        }
      }
      if (this.shown === 'inside') {
        const end = shownMark('End', this.shownNonce);
        const at = text.indexOf(end);
        if (at < 0) {
          // Keep a tail in case the end mark is split across chunks.
          this.pending = text.slice(-end.length);
          return '';
        }
        this.shown = 'done';
        text = text.slice(at + end.length);
      }
    }
    // Hold back an unfinished escape sequence at the end.
    const cut = text.lastIndexOf('\x1b');
    if (cut >= 0 && !/(?:\x07|\x1b\\)/.test(text.slice(cut + 1)) && text.length - cut < 512 && (text[cut + 1] === undefined || text[cut + 1] === ']')) {
      this.pending = text.slice(cut);
      text = text.slice(0, cut);
    }
    return text.replace(OSC, '');
  }

  /** Whatever is left at the end (only after the command started, never shown text). */
  flush(): string {
    const rest = this.started && this.shown !== 'inside' ? this.pending.replace(OSC, '') : '';
    this.pending = '';
    return rest;
  }
}

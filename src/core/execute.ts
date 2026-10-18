/** Run one code cell's source: pick the shell, write a temp script, run it, clean up. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunResult, runProcess } from './runner';
import { ResolvedShell, ShellEnv, ShellSettings, resolveShell, shellKindForLanguage } from './shell';

export interface ExecuteOptions {
  /** Fence language or VS Code language id. */
  language: string;
  source: string;
  cwd: string;
  settings: ShellSettings;
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onStdout(text: string): void;
  onStderr(text: string): void;
}

export interface ExecuteResult extends RunResult {
  shell?: ResolvedShell;
}

function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command.toLowerCase().endsWith(ext.toLowerCase()) ? command : command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

export function nodeShellEnv(): ShellEnv {
  return {
    platform: process.platform,
    env: process.env,
    exists: (f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    },
    which: (c) => findOnPath(c),
  };
}

export async function executeCell(opts: ExecuteOptions, shellEnv: ShellEnv = nodeShellEnv()): Promise<ExecuteResult> {
  const fail = (error: string): ExecuteResult => ({
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: false,
    error,
    durationMs: 0,
  });
  const kind = shellKindForLanguage(opts.language);
  if (!kind) return fail(`No shell for language '${opts.language}'.`);
  const resolved = resolveShell(kind, opts.settings, shellEnv);
  if (!resolved.ok) return fail(resolved.error);
  const shell = resolved.shell;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-'));
  const scriptPath = path.join(dir, 'cell' + shell.extension);
  try {
    fs.writeFileSync(scriptPath, shell.script(opts.source), 'utf8');
    const result = await runProcess({
      command: shell.command,
      args: shell.args(scriptPath),
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      windowsVerbatimArguments: shell.windowsVerbatimArguments,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    });
    return { ...result, shell };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A killed process may still hold the file briefly on Windows; it's in the temp dir anyway.
    }
  }
}

/** Exit attribute for the output marker: the exit code, or why there is none. */
export function exitLabel(r: RunResult): string {
  if (r.timedOut) return 'timeout';
  if (r.cancelled) return 'cancelled';
  if (r.error !== undefined) return 'error';
  if (r.exitCode !== null) return String(r.exitCode);
  return r.signal ?? 'unknown';
}

export function isSuccess(r: RunResult): boolean {
  return !r.timedOut && !r.cancelled && r.error === undefined && r.exitCode === 0;
}

/** Run one code cell's source: pick the shell, write a temp script, run it, clean up. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { freshenPath } from './freshPath';
import { runProcess } from './runner';
import { ShellEnv, resolveShell, shellKindForLanguage } from './shell';
import type { ExecuteOptions, ExecuteResult } from '../result';
import type { ShellSettings } from '../shellKind';

export type { ExecuteOptions, ExecuteResult } from '../result';
export { exitLabel, isSuccess } from '../result';

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

/** This process's platform and file system, looking programs up on `env`'s PATH (VS Code's by default). */
export function nodeShellEnv(env: NodeJS.ProcessEnv = process.env): ShellEnv {
  return {
    platform: process.platform,
    env,
    exists: (f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    },
    which: (c) => findOnPath(c, env),
  };
}

/**
 * The environment a cell (or a session) starts with: VS Code's plus `extra`, with the PATH
 * directories installed since VS Code started unless `settings.refreshPath` is off.
 */
export async function cellEnv(settings: ShellSettings, extra: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  if (settings.refreshPath !== false) await freshenPath(env, platform);
  return env;
}

/**
 * `shellEnv` looking programs up on `env`'s PATH, so a PowerShell 7 installed by an earlier cell
 * is found. A `shellEnv` with its own lookup (tests) is kept as it is.
 */
export function shellEnvOn(shellEnv: ShellEnv, env: NodeJS.ProcessEnv): ShellEnv {
  return shellEnv.env === process.env ? { ...shellEnv, env, which: (c) => findOnPath(c, env) } : shellEnv;
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
  const env = await cellEnv(opts.settings, opts.env, shellEnv.platform);
  const resolved = resolveShell(kind, opts.settings, shellEnvOn(shellEnv, env));
  if (!resolved.ok) return fail(resolved.error);
  const shell = resolved.shell;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-'));
  const scriptPath = path.join(dir, 'cell' + shell.extension);
  let source = opts.source;
  let cwd = opts.cwd;
  let args = shell.args(scriptPath);
  if (shell.kind === 'cmd' && /^[\\/]{2}/.test(cwd)) {
    // cmd.exe can't start in a UNC folder (it silently falls back to C:\Windows); pushd maps a drive.
    source = `pushd "${cwd}" >nul 2>&1 || (echo md-runbook: cannot open ${cwd} 1>&2 & exit /b 1)\r\n${source}\r\npopd`;
    cwd = os.tmpdir();
  }
  if (shell.kind === 'bash' && shellEnv.platform === 'win32' && /['"\[\]*?{}$`]/.test(scriptPath)) {
    // MSYS re-parses its command line with its own quoting rules; pass awkward paths via the environment.
    env.MDRB_SCRIPT = (args[0] ?? scriptPath);
    args = ['-c', '. "$MDRB_SCRIPT"'];
  }
  try {
    fs.writeFileSync(scriptPath, shell.script(source), 'utf8');
    const result = await runProcess({
      command: shell.command,
      args,
      cwd,
      env,
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

/** Spawn a process, stream its output, and kill its whole process tree on cancel or timeout. */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { RunResult } from '../result';

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** 0 = no timeout. */
  timeoutMs: number;
  signal?: AbortSignal;
  windowsVerbatimArguments?: boolean;
  onStdout(text: string): void;
  onStderr(text: string): void;
}

/** Kill a process and all its descendants. */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    // taskkill /T walks the tree; /F because console apps ignore WM_CLOSE.
    const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => undefined);
    return;
  }
  // The child was spawned detached, so it leads its own process group: signal the group.
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  };
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), 2000).unref();
}

/** How long to wait for output pipes to close after the process exits. */
const EXIT_GRACE_MS = 1000;

export function runProcess(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: Omit<RunResult, 'timedOut' | 'cancelled' | 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, timedOut, cancelled, durationMs: Date.now() - started });
    };

    if (opts.signal?.aborted) {
      cancelled = true;
      finish({ exitCode: null, signal: null });
      return;
    }

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: opts.windowsVerbatimArguments,
    });

    const kill = (): void => {
      if (child.pid !== undefined && child.exitCode === null) killTree(child.pid);
    };
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort);
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
    }

    const out = new StringDecoder('utf8');
    const err = new StringDecoder('utf8');
    child.stdout?.on('data', (b: Buffer) => opts.onStdout(out.write(b)));
    child.stderr?.on('data', (b: Buffer) => opts.onStderr(err.write(b)));

    const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      const restOut = out.end();
      const restErr = err.end();
      if (restOut) opts.onStdout(restOut);
      if (restErr) opts.onStderr(restErr);
      finish({ exitCode: code, signal });
    };
    child.on('error', (e) => finish({ exitCode: null, signal: null, error: e.message }));
    // 'close' fires once the stdio streams end, so normally all output has been delivered.
    child.on('close', complete);
    // A background process started by the script (e.g. `server &`) can hold the pipes open
    // after the shell exits. Don't wait for it forever.
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        complete(code, signal);
      }, EXIT_GRACE_MS);
    });
  });
}

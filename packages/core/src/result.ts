/** What running a cell's script gives back, and how the output marker labels it. Platform-neutral. */

import type { ResolvedShell, ShellSettings } from './shellKind';

export interface RunResult {
  exitCode: number | null;
  /** Signal that ended the process (Unix), if any. */
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the process could not be started. */
  error?: string;
  durationMs: number;
}

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

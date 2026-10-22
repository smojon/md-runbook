/** A Connection whose session runs cells in a scripted way, for tests without a server. */
import type { RemoteRunOptions, RemoteSession, SessionRunResult, SignedRun } from '@md-runbook/ssh';
import type { Connection } from '../ssh/connections';

export interface FakeRun {
  /** Text per stream, delivered through onStdout/onStderr before the result. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  newShell?: boolean;
  /** Fail the run: the server's key is `hostKey` (not trusted). */
  unknownHostKey?: string;
  /** Fail the run with this error. */
  error?: string;
  /** Resolve only when the signal aborts (a long cell). */
  waitForAbort?: boolean;
}

export function fakeConnection(
  script: FakeRun[] = [{ stdout: 'hello\n', exitCode: 0 }],
): Connection & { calls: { source: string; opts: RemoteRunOptions; signed?: SignedRun }[] } {
  const calls: { source: string; opts: RemoteRunOptions; signed?: SignedRun }[] = [];
  let i = 0;
  const conn = {
    calls,
    unknownHostKey: undefined as string | undefined,
    changed: undefined as boolean | undefined,
    session: {
      isConnected: true,
      async run(source: string, opts: RemoteRunOptions = {}, signed?: SignedRun): Promise<SessionRunResult> {
        calls.push({ source, opts, ...(signed ? { signed } : {}) });
        const step = script[Math.min(i++, script.length - 1)] ?? {};
        if (step.unknownHostKey) {
          conn.unknownHostKey = step.unknownHostKey;
          throw new Error('authentication failed (host key refused, or the key was not accepted)');
        }
        if (step.error) throw new Error(step.error);
        if (step.waitForAbort) {
          await new Promise<void>((r) => opts.signal?.addEventListener('abort', () => r()));
          return { exitCode: null, signal: null, timedOut: false, cancelled: true, durationMs: 5 };
        }
        if (step.stdout) opts.onStdout?.(step.stdout);
        if (step.stderr) opts.onStderr?.(step.stderr);
        return { exitCode: step.exitCode ?? 0, signal: null, timedOut: false, cancelled: false, durationMs: 5, newShell: step.newShell };
      },
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
    } as unknown as RemoteSession,
  };
  return conn;
}

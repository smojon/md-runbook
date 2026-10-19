/**
 * Runs runbook cells in one persistent shell on a remote host over SSH, with the pure-TypeScript
 * client @microsoft/dev-tunnels-ssh: the same code runs in Node, in browsers (through the relay)
 * and in React Native. The caller brings the transport (a `Stream`: a TCP socket, a WebSocket to
 * the relay), so this file has no platform code.
 */

import { RunResult, SentinelFilter } from '@md-runbook/core';
import {
  CommandRequestMessage,
  KeyPair,
  SshAuthenticatingEventArgs,
  SshAuthenticationType,
  SshChannel,
  SshClientSession,
  SshDisconnectReason,
  SshExtendedDataType,
  SshSessionConfiguration,
  Stream,
} from '@microsoft/dev-tunnels-ssh';
import { exportPublicKey } from '@microsoft/dev-tunnels-ssh-keys';
// The library's own Buffer, so this file also works where there is no global Buffer (browsers).
import { Buffer } from 'buffer';
import { CellCommandOptions, SHELL_COMMAND, cellCommand, helloCommand, markerFor, randomId, stopCommand } from './command';

export interface ConnectOptions {
  username: string;
  key: KeyPair;
  /**
   * Accept or refuse the server's host key, given as an OpenSSH public key line
   * (`ecdsa-sha2-nistp256 AAAA…`). Refusing closes the connection before any credential is sent.
   */
  verifyHostKey(publicKey: string): boolean | Promise<boolean>;
  /** Until the shell is ready. Default 20 s. */
  connectTimeoutMs?: number;
  /** Keep-alive interval, so a dead connection (phone asleep, network changed) is noticed. Default 15 s; 0 = off. */
  keepAliveSeconds?: number;
}

export interface RemoteRunOptions extends CellCommandOptions {
  /** 0 or absent: no limit. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?(text: string): void;
  onStderr?(text: string): void;
  /** How long a stopped cell gets after SIGTERM, then after SIGKILL, before the shell is closed. Default 2 s. */
  stopGraceMs?: number;
}

export interface RemoteRunResult extends RunResult {
  /**
   * The shell ended during the cell (connection lost, `exit` in the cell, or a cell that didn't
   * stop): its folder and variables are gone, and the next cell needs a new shell.
   */
  shellEnded?: boolean;
}

/** The shell ended while something waited for it. */
export class ShellEndedError extends Error {}

interface Exchange {
  out: SentinelFilter;
  err: SentinelFilter;
  check(): void;
  fail(e: Error): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(p: Promise<T>, ms: number, what: string, onTimeout: () => Promise<unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout().catch(() => undefined);
      reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class RemoteShell {
  private current: Exchange | undefined;
  /** Id of the cell that runs now. */
  private runningId: string | undefined;
  private ended = false;
  private pid = 0;
  private readonly decoderOut = new TextDecoder();
  private readonly decoderErr = new TextDecoder();

  private constructor(
    private readonly session: SshClientSession,
    private readonly channel: SshChannel,
  ) {
    channel.onDataReceived((data) => {
      this.deliver('out', this.decoderOut.decode(data, { stream: true }));
      channel.adjustWindow(data.length);
    });
    channel.onExtendedDataReceived((e) => {
      if (e.dataTypeCode === SshExtendedDataType.STDERR) this.deliver('err', this.decoderErr.decode(e.data, { stream: true }));
      channel.adjustWindow(e.data.length);
    });
    channel.onClosed(() => this.end('the remote shell ended'));
    session.onClosed((e) => this.end(e.message ? `the connection closed: ${e.message}` : 'the connection closed'));
  }

  /** Connect over `stream`, check the host key, authenticate with `key`, start the shell. */
  static async connect(stream: Stream, opts: ConnectOptions): Promise<RemoteShell> {
    const config = new SshSessionConfiguration();
    config.keepAliveTimeoutInSeconds = opts.keepAliveSeconds ?? 15;
    const session = new SshClientSession(config);
    session.onAuthenticating((e: SshAuthenticatingEventArgs) => {
      if (e.authenticationType !== SshAuthenticationType.serverPublicKey || !e.publicKey) return;
      const key = e.publicKey;
      e.authenticationPromise = (async () => ((await opts.verifyHostKey(await exportPublicKey(key))) ? {} : null))();
    });
    const start = async (): Promise<RemoteShell> => {
      await session.connect(stream);
      const ok = await session.authenticate({ username: opts.username, publicKeys: [opts.key] });
      if (!ok) throw new Error('authentication failed (host key refused, or the key was not accepted)');
      const channel = await session.openChannel();
      const shell = new RemoteShell(session, channel);
      if (!(await channel.request(execRequest(SHELL_COMMAND)))) throw new Error('the server refused to start a shell');
      shell.pid = (await shell.exchange(randomId(), helloCommand)) ?? 0;
      return shell;
    };
    const closeAll = async (): Promise<void> => {
      await session.close(SshDisconnectReason.byApplication).catch(() => undefined);
      await stream.close().catch(() => undefined);
    };
    try {
      return await withTimeout(start(), opts.connectTimeoutMs ?? 20_000, 'connecting', closeAll);
    } catch (e) {
      await closeAll();
      throw e;
    }
  }

  /** False once the shell or the connection has ended. */
  get isOpen(): boolean {
    return !this.ended;
  }

  /** Run one bash cell in the remote shell; output streams to `onStdout`/`onStderr` as it arrives. */
  async run(source: string, opts: RemoteRunOptions = {}): Promise<RemoteRunResult> {
    if (this.runningId !== undefined) throw new Error('the shell is busy');
    const started = Date.now();
    const result = (r: Partial<RemoteRunResult>): RemoteRunResult => ({
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: Date.now() - started,
      ...r,
    });
    if (this.ended) return result({ error: 'the remote shell has ended', shellEnded: true });
    if (opts.signal?.aborted) return result({ cancelled: true });

    let timedOut = false;
    let cancelled = false;
    const id = randomId();
    this.runningId = id;
    const stop = (why: 'timeout' | 'cancel'): void => {
      if (timedOut || cancelled) return;
      if (why === 'timeout') timedOut = true;
      else cancelled = true;
      void this.stopCell(id, opts.stopGraceMs ?? 2000);
    };
    const timer = opts.timeoutMs ? setTimeout(() => stop('timeout'), opts.timeoutMs) : undefined;
    const onAbort = (): void => stop('cancel');
    opts.signal?.addEventListener('abort', onAbort);
    try {
      const code = await this.exchange(id, (i) => cellCommand(source, i, opts), opts.onStdout, opts.onStderr);
      return result({ exitCode: timedOut || cancelled ? null : code, timedOut, cancelled });
    } catch (e) {
      if (!(e instanceof ShellEndedError)) throw e;
      return result({ timedOut, cancelled, shellEnded: true, ...(timedOut || cancelled ? {} : { error: e.message }) });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      this.runningId = undefined;
    }
  }

  async close(): Promise<void> {
    this.end('closed');
    await this.channel.close().catch(() => undefined);
    await this.session.close(SshDisconnectReason.byApplication).catch(() => undefined);
  }

  /** Send `text(id)` and wait for the marker on both streams; resolves with the marker's value. */
  private exchange(id: string, text: (id: string) => string, onOut?: (t: string) => void, onErr?: (t: string) => void): Promise<number | undefined> {
    if (this.ended) return Promise.reject(new ShellEndedError('the remote shell has ended'));
    return new Promise<number | undefined>((resolve, reject) => {
      const out = new SentinelFilter(markerFor(id), (t) => onOut?.(t));
      const err = new SentinelFilter(markerFor(id), (t) => onErr?.(t));
      this.current = {
        out,
        err,
        check: () => {
          if (!out.done || !err.done) return;
          this.current = undefined;
          resolve(out.code);
        },
        fail: (e) => {
          out.flush();
          err.flush();
          this.current = undefined;
          reject(e);
        },
      };
      this.channel.send(Buffer.from(text(id), 'utf8')).catch((e: unknown) => this.current?.fail(e instanceof Error ? e : new Error(String(e))));
    });
  }

  private deliver(stream: 'out' | 'err', text: string): void {
    const c = this.current;
    if (!c || text === '') return; // output between cells belongs to no cell
    c[stream].write(text);
    c.check();
  }

  /** The shell is gone: fail the running cell and close the connection (and its keep-alive timer). */
  private end(why: string): void {
    if (this.ended) return;
    this.ended = true;
    this.current?.fail(new ShellEndedError(why));
    void this.session.close(SshDisconnectReason.byApplication).catch(() => undefined);
  }

  /**
   * Stop the running cell `id` but keep the shell: SIGTERM to the shell's children, then SIGKILL,
   * then, if the cell still runs (a busy loop in the shell itself), close the shell.
   */
  private async stopCell(id: string, graceMs: number): Promise<void> {
    const running = (): boolean => !this.ended && this.runningId === id;
    for (const signal of ['TERM', 'KILL'] as const) {
      if (!running()) return;
      if (this.pid > 0) await this.exec(stopCommand(this.pid, signal));
      await sleep(graceMs);
    }
    if (running()) {
      this.end('the cell did not stop, so its shell was closed');
      await this.channel.close().catch(() => undefined);
    }
  }

  /** Run `command` on its own channel and wait for it (at most 5 s). Errors are ignored. */
  private async exec(command: string): Promise<void> {
    try {
      const ch = await this.session.openChannel();
      const closed = new Promise<void>((r) => ch.onClosed(() => r()));
      if (await ch.request(execRequest(command))) await Promise.race([closed, sleep(5000)]);
      await ch.close().catch(() => undefined);
    } catch {
      // The connection may be gone; the caller falls back to closing the shell.
    }
  }
}

function execRequest(command: string): CommandRequestMessage {
  const m = new CommandRequestMessage();
  m.requestType = 'exec';
  m.wantReply = true;
  m.command = command;
  return m;
}

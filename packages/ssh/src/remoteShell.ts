/**
 * Runs runbook cells in one persistent shell on a remote host over SSH, with the pure-TypeScript
 * client @microsoft/dev-tunnels-ssh: the same code runs in Node, in browsers (through the relay)
 * and in React Native. The caller brings the transport (a `Stream`: a TCP socket, a WebSocket to
 * the relay), so this file has no platform code.
 */

import { RunResult, RunbookShells, SentinelFilter, ShellKind, UnixShell } from '@md-runbook/core';
import {
  CommandRequestMessage,
  KeyPair,
  SshAuthenticatingEventArgs,
  SshAuthenticationType,
  SshChannel,
  SshClientSession,
  SshDisconnectReason,
  SshExtendedDataType,
  SshAlgorithms,
  SshSessionConfiguration,
  Stream,
} from '@microsoft/dev-tunnels-ssh';
import { KUBE_CONTEXT_COMMAND } from '@md-runbook/core/kubeContext';
import { exportPublicKey } from '@microsoft/dev-tunnels-ssh-keys';
// The library's own Buffer, so this file also works where there is no global Buffer (browsers).
import { Buffer } from 'buffer';
import {
  CellCommandOptions,
  GateInfo,
  PROBED_SHELLS,
  PWSH_SHELL_COMMAND,
  RemotePlatform,
  WINDOWS_SHELL_COMMAND,
  cellCommand,
  gateBanner,
  gateContextCommand,
  gateLoadCommand,
  gateParamCommand,
  gateRawCommand,
  gateRunCommand,
  helloCommand,
  markerFor,
  posixShellCommand,
  randomId,
  shellProbeCommand,
  signedReply,
  stopCommand,
  windowsCellCommand,
  windowsHelloCommand,
  windowsStopCommand,
} from './command';
import { ExternalAwareEcdsaP256 } from './externalKey';
import { PasskeySkEcdsaP256 } from './passkey';

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
  /** The runbook's `shell:`: zsh, sh or bash on Linux and macOS servers; pwsh (7) or Windows PowerShell on Windows ones. */
  shells?: RunbookShells;
}

export interface RemoteRunOptions extends CellCommandOptions {
  /** The cell's shell: bash (the default) on Linux and macOS servers, pwsh or cmd on Windows ones. */
  shell?: ShellKind;
  /**
   * An approved proposal: the shell its approval read it as (the command policy's rules). Checked
   * as bash, it doesn't run where the login shell turned out to be zsh, which reads some text
   * differently (a profile that ends in `exec zsh`).
   */
  checkedAs?: 'bash' | 'zsh';
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

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string, onTimeout: () => Promise<unknown>): Promise<T> {
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
  private gateInfo: GateInfo | undefined;
  /** Why the runbook's `shell:` can't be had here, per kind of cell: those cells don't run. */
  private readonly unavailable: Partial<Record<ShellKind, string>> = {};
  /** On Linux and macOS servers (not through the gate): the shell that answered, by its own variables. */
  private answered: UnixShell | undefined;
  /** While the shell starts, its channel closing (cmd.exe refusing the sh command) is not the connection's end. */
  private starting = true;
  private readonly decoderOut = new TextDecoder();
  private readonly decoderErr = new TextDecoder();

  private constructor(
    private readonly session: SshClientSession,
    private readonly channel: SshChannel,
    /** sh/bash (Linux, macOS) or Windows PowerShell. */
    readonly platform: RemotePlatform,
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
    // Keys held by the device's keystore (ExternalKeyPair) sign through it; other keys as before.
    if (SshAlgorithms.publicKey.ecdsaSha2Nistp256) config.publicKeyAlgorithms.unshift(new ExternalAwareEcdsaP256());
    // Passkeys (the web app): last, as the library offers these as host key types too.
    config.publicKeyAlgorithms.push(new PasskeySkEcdsaP256());
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
      // sh/bash first. On a Windows server cmd.exe (or PowerShell) runs the request and fails at
      // once, closing the channel: then Windows PowerShell.
      const want = opts.shells ?? {};
      const shell =
        (await RemoteShell.start(session, 'posix', want)) ??
        (await RemoteShell.start(session, 'windows', want)) ??
        // No PowerShell 7 on this Windows server: Windows PowerShell, for its cmd cells.
        (want.powershell === 'pwsh' ? await RemoteShell.start(session, 'windows', {}, "This server has no PowerShell 7 (pwsh): the runbook's shell: pwsh needs it.") : undefined);
      if (!shell) throw new Error('the server did not start a shell (sh, bash or Windows PowerShell)');
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

  /**
   * Start a shell on a channel of its own: sh/bash, or Windows PowerShell. Undefined when the
   * channel closed before the shell answered its hello (not that kind of server); the connection
   * stays open for the next try.
   */
  private static async start(session: SshClientSession, platform: RemotePlatform, want: RunbookShells, noPwsh?: string): Promise<RemoteShell | undefined> {
    const channel = await session.openChannel();
    const shell = new RemoteShell(session, channel, platform);
    const command = platform === 'posix' ? posixShellCommand(want.unix) : want.powershell === 'pwsh' ? PWSH_SHELL_COMMAND : WINDOWS_SHELL_COMMAND;
    if (!(await channel.request(execRequest(command)))) {
      await channel.close().catch(() => undefined);
      return undefined;
    }
    try {
      // md-runbook-gate (a restricted key's forced command) announces itself before the marker.
      let greeting = '';
      shell.pid = (await shell.exchange(randomId(), platform === 'windows' ? windowsHelloCommand : helloCommand, (t) => (greeting += t))) ?? 0;
      shell.gateInfo = platform === 'posix' ? gateBanner(greeting) : undefined;
      if (noPwsh) shell.unavailable.pwsh = noPwsh;
      if (platform === 'posix' && want.unix && want.unix !== 'bash' && shell.gateInfo) {
        shell.unavailable.bash = `md-runbook-gate runs cells in bash: the runbook's shell: ${want.unix} can't be used through it.`;
      } else if (platform === 'posix' && !shell.gateInfo) {
        // Which shell answered: zsh may have fallen back to sh, bash may be missing, and a login
        // profile can start another shell (`exec zsh`). Say so instead of running the cells elsewhere.
        const got = PROBED_SHELLS[(await shell.exchange(randomId(), shellProbeCommand)) ?? -1];
        shell.answered = got;
        if ((want.unix === 'zsh' || want.unix === 'bash') && got !== want.unix) {
          shell.unavailable.bash = `This server has no ${want.unix} (the runbook's shell: ${want.unix}).`;
        }
      }
      shell.starting = false;
      return shell;
    } catch (e) {
      if (e instanceof ShellEndedError) return undefined;
      throw e;
    }
  }

  /** False once the shell or the connection has ended. */
  get isOpen(): boolean {
    return !this.ended;
  }

  /** md-runbook-gate's banner when this account runs through it; undefined for a plain shell. */
  get gate(): GateInfo | undefined {
    return this.gateInfo;
  }

  /**
   * Run one cell in the remote shell; output streams to `onStdout`/`onStderr` as it arrives. bash
   * cells run on Linux and macOS servers, pwsh and cmd cells on Windows ones. Through
   * md-runbook-gate the cell goes as an unsigned request, which the gate refuses (exit 126, its
   * reason on stderr) unless it allows unsigned cells.
   */
  async run(source: string, opts: RemoteRunOptions = {}): Promise<RemoteRunResult> {
    const kind = opts.shell ?? 'bash';
    const zshUnchecked =
      kind === 'bash' && opts.checkedAs === 'bash' && this.answered === 'zsh'
        ? "This server's login shell is zsh (its profile starts it), and this proposal was approved as bash: add shell: zsh to the runbook and approve it again."
        : undefined;
    const wrong = wrongPlatform(this.platform, kind) ?? this.unavailable[kind] ?? zshUnchecked;
    if (wrong) return { exitCode: null, signal: null, timedOut: false, cancelled: false, durationMs: 0, error: wrong };
    if (kind !== 'bash') return this.runText((id) => windowsCellCommand(source, id, kind, opts), opts);
    const text = (id: string): string => (this.gateInfo ? gateRawCommand(id, cellCommand(source, id, opts)) : cellCommand(source, id, opts));
    return this.runText(text, opts);
  }

  /**
   * md-runbook-gate: check and keep a signed manifest for the cells that follow. Resolves with
   * the principal whose signature the gate accepted; rejects with the gate's reason.
   */
  async loadSigned(manifest: string, signatures: string | readonly string[]): Promise<{ principal: string; hash: string }> {
    let out = '';
    const err = await this.request((id) => gateLoadCommand(id, manifest, signatures), (t) => (out += t));
    const reply = signedReply(out);
    if (err !== undefined || !reply) throw new Error(err ?? 'the gate did not confirm the signature');
    return reply;
  }

  /** md-runbook-gate: a parameter's value for the loaded manifest; rejects with the gate's reason. */
  async setParam(name: string, value: string): Promise<void> {
    const err = await this.request((id) => gateParamCommand(id, name, value));
    if (err !== undefined) throw new Error(err);
  }

  /** md-runbook-gate: run signed cell `cell` of the loaded manifest, or its command `step` (0-based). */
  async runSigned(cell: number, step: number | undefined, opts: RemoteRunOptions = {}): Promise<RemoteRunResult> {
    if (!this.gateInfo) throw new Error('not an md-runbook-gate session');
    return this.runText((id) => gateRunCommand(id, cell, step), opts);
  }

  /**
   * `kubectl config current-context` in this shell, for the kube-context guard. Through
   * md-runbook-gate it is the gate's own `context` request, answered also where only signed
   * cells run (the command only reads the kubeconfig).
   */
  async kubeContext(opts: RemoteRunOptions = {}): Promise<RemoteRunResult> {
    if (this.gateInfo) return this.runText((id) => gateContextCommand(id), opts);
    return this.run(KUBE_CONTEXT_COMMAND, opts);
  }

  /** A short gate request: undefined when it succeeded, else the gate's reason. */
  private async request(text: (id: string) => string, onOut?: (t: string) => void): Promise<string | undefined> {
    if (this.runningId !== undefined) throw new Error('the shell is busy');
    if (!this.gateInfo) throw new Error('not an md-runbook-gate session');
    let err = '';
    const id = randomId();
    this.runningId = id;
    try {
      const code = await this.exchange(id, text, onOut, (t) => (err += t));
      return code === 0 ? undefined : err.trim().replace(/^md-runbook-gate: /, '') || `refused (exit ${code})`;
    } finally {
      this.runningId = undefined;
    }
  }

  private async runText(text: (id: string) => string, opts: RemoteRunOptions): Promise<RemoteRunResult> {
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
      const code = await this.exchange(id, text, opts.onStdout, opts.onStderr);
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
    if (!this.starting) void this.session.close(SshDisconnectReason.byApplication).catch(() => undefined);
  }

  /**
   * Stop the running cell `id` but keep the shell: SIGTERM to the shell's children, then SIGKILL,
   * then, if the cell still runs (a busy loop in the shell itself), close the shell.
   */
  private async stopCell(id: string, graceMs: number): Promise<void> {
    const running = (): boolean => !this.ended && this.runningId === id;
    for (const signal of ['TERM', 'KILL'] as const) {
      if (!running()) return;
      if (this.pid > 0) await this.exec(this.platform === 'windows' ? windowsStopCommand(this.pid) : stopCommand(this.pid, signal));
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

/** Why a cell of this shell can't run on this server, or undefined. */
export function wrongPlatform(platform: RemotePlatform, kind: ShellKind): string | undefined {
  if (platform === 'posix' && kind !== 'bash') {
    return `This server runs sh or bash: ${kind === 'cmd' ? 'cmd' : 'PowerShell'} cells need a Windows server.`;
  }
  if (platform === 'windows' && kind === 'bash') return 'This is a Windows server: bash and sh cells need a Linux or macOS server.';
  return undefined;
}

export function execRequest(command: string): CommandRequestMessage {
  const m = new CommandRequestMessage();
  m.requestType = 'exec';
  m.wantReply = true;
  m.command = command;
  return m;
}

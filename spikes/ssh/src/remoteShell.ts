/**
 * Spike: run runbook cells in a persistent shell on a remote host over SSH, with the
 * pure-TypeScript client @microsoft/dev-tunnels-ssh. The same code is meant to run in Node, in a
 * browser (over a WebSocket relay) and in React Native.
 *
 * A cell is sent as a quoted here-doc with a random terminator (so the cell's text can't end it),
 * written to a temp file, sourced in the shell (so `cd` and variables carry over, like session
 * mode), and followed by a sentinel `<RS>__MDRB_<id>__ <exit>` on stdout and stderr, as in
 * src/core/session.ts.
 */

import {
  ChannelRequestMessage,
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

const RS = '\x1e';

export interface ConnectOptions {
  username: string;
  key: KeyPair;
  /**
   * Accept or refuse the server's host key, given as an OpenSSH public key line
   * (`ecdsa-sha2-nistp256 AAAA…`). Refusing closes the connection before any credential is sent.
   */
  verifyHostKey(publicKey: string): boolean | Promise<boolean>;
}

export interface CellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Passes a stream through until the sentinel, which it strips (a copy of core/session.ts's SentinelFilter). */
class SentinelFilter {
  private pending = '';
  private readonly needle: string;
  code: number | undefined;
  constructor(marker: string, private readonly emit: (text: string) => void) {
    this.needle = RS + marker + ' ';
  }
  get done(): boolean {
    return this.code !== undefined;
  }
  write(chunk: string): void {
    if (this.done) return;
    let p = this.pending + chunk;
    const at = p.indexOf(this.needle);
    if (at >= 0) {
      if (at > 0) this.emit(p.slice(0, at));
      p = p.slice(at);
      const end = p.indexOf('\n');
      if (end >= 0) {
        const code = Number.parseInt(p.slice(this.needle.length, end), 10);
        this.code = Number.isNaN(code) ? 1 : code;
        p = '';
      }
      this.pending = p;
      return;
    }
    const rs = p.lastIndexOf(RS);
    const hold = rs >= 0 && this.needle.startsWith(p.slice(rs)) ? rs : p.length;
    if (hold > 0) this.emit(p.slice(0, hold));
    this.pending = p.slice(hold);
  }
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The text sent to the shell for one cell (bash/sh). */
export function bashCellCommand(source: string, id: string): string {
  const marker = `__MDRB_${id}__`;
  const eof = `__MDRB_EOF_${id}`;
  const body = source.endsWith('\n') ? source : source + '\n';
  return (
    `__mdrb_f=$(mktemp) && cat > "$__mdrb_f" <<'${eof}'\n${body}${eof}\n` +
    `. "$__mdrb_f" </dev/null; __mdrb_rc=$?; rm -f "$__mdrb_f"; ` +
    `printf '\\036%s %s\\n' ${marker} "$__mdrb_rc"; printf '\\036%s %s\\n' ${marker} "$__mdrb_rc" >&2\n`
  );
}

export class RemoteShell {
  private constructor(
    private readonly session: SshClientSession,
    private readonly channel: SshChannel,
  ) {}

  private current: { out: SentinelFilter; err: SentinelFilter; check(): void } | undefined;
  private readonly decoderOut = new TextDecoder();
  private readonly decoderErr = new TextDecoder();

  /** Connect over `stream`, check the host key, authenticate with `key`, open a shell. */
  static async connect(stream: Stream, opts: ConnectOptions): Promise<RemoteShell> {
    const session = new SshClientSession(new SshSessionConfiguration());
    session.onAuthenticating((e: SshAuthenticatingEventArgs) => {
      if (e.authenticationType !== SshAuthenticationType.serverPublicKey || !e.publicKey) return;
      const key = e.publicKey;
      e.authenticationPromise = (async () => ((await opts.verifyHostKey(await exportPublicKey(key))) ? {} : null))();
    });
    await session.connect(stream);
    const ok = await session.authenticate({ username: opts.username, publicKeys: [opts.key] });
    if (!ok) {
      await session.close(SshDisconnectReason.noMoreAuthMethodsAvailable);
      throw new Error('authentication failed (host key refused, or the key was not accepted)');
    }
    const channel = await session.openChannel();
    const shell = new RemoteShell(session, channel);
    channel.onDataReceived((data) => {
      shell.deliver('out', shell.decoderOut.decode(data, { stream: true }));
      channel.adjustWindow(data.length);
    });
    channel.onExtendedDataReceived((e) => {
      if (e.dataTypeCode === SshExtendedDataType.STDERR) shell.deliver('err', shell.decoderErr.decode(e.data, { stream: true }));
      channel.adjustWindow(e.data.length);
    });
    const started = await channel.request(new ChannelRequestMessage('shell', true));
    if (!started) throw new Error('the server refused to start a shell');
    return shell;
  }

  private deliver(stream: 'out' | 'err', text: string): void {
    const c = this.current;
    if (!c || text === '') return; // output between cells belongs to no cell
    c[stream].write(text);
    c.check();
  }

  /** Run one bash cell in the remote shell; output streams to `onOutput` as it arrives. */
  run(source: string, onOutput?: (stream: 'stdout' | 'stderr', text: string) => void): Promise<CellResult> {
    if (this.current) return Promise.reject(new Error('the shell is busy'));
    const id = randomId();
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    return new Promise<CellResult>((resolve, reject) => {
      const out = new SentinelFilter(`__MDRB_${id}__`, (t) => {
        stdout += t;
        onOutput?.('stdout', t);
      });
      const err = new SentinelFilter(`__MDRB_${id}__`, (t) => {
        stderr += t;
        onOutput?.('stderr', t);
      });
      this.current = {
        out,
        err,
        check: () => {
          if (!out.done || !err.done) return;
          this.current = undefined;
          resolve({ exitCode: out.code ?? null, stdout, stderr, durationMs: Date.now() - started });
        },
      };
      this.channel.send(Buffer.from(bashCellCommand(source, id), 'utf8')).catch((e: unknown) => {
        this.current = undefined;
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  async close(): Promise<void> {
    await this.channel.close().catch(() => undefined);
    await this.session.close(SshDisconnectReason.byApplication).catch(() => undefined);
  }
}

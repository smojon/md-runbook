/**
 * A remote session that reconnects: when the connection or the shell has ended (phone asleep,
 * network changed, `exit` in a cell), the next cell opens a new one, after the same host-key
 * check. Cells are never re-run on their own; the result says the shell is new, so the app can
 * warn that the folder and variables of earlier cells are gone.
 */

import type { Stream } from '@microsoft/dev-tunnels-ssh';
import { ConnectOptions, RemoteRunOptions, RemoteRunResult, RemoteShell } from './remoteShell';

export interface SessionRunResult extends RemoteRunResult {
  /** This cell ran in a new shell although an earlier one had ended: earlier state is lost. */
  newShell?: boolean;
}

export class RemoteSession {
  private shell: RemoteShell | undefined;
  private connecting: Promise<RemoteShell> | undefined;
  private hadShell = false;

  /** `open` makes a new transport for each connection (a TCP socket, a WebSocket to the relay). */
  constructor(
    private readonly open: () => Promise<Stream>,
    private readonly opts: ConnectOptions,
  ) {}

  get isConnected(): boolean {
    return this.shell?.isOpen ?? false;
  }

  /** Connect now (otherwise the first cell does). */
  async connect(): Promise<void> {
    await this.ensure();
  }

  async run(source: string, opts: RemoteRunOptions = {}): Promise<SessionRunResult> {
    const lost = this.hadShell && !this.isConnected;
    const shell = await this.ensure();
    const r = await shell.run(source, opts);
    return lost ? { ...r, newShell: true } : r;
  }

  async close(): Promise<void> {
    const s = this.shell;
    this.shell = undefined;
    this.hadShell = false;
    await s?.close();
  }

  private async ensure(): Promise<RemoteShell> {
    if (this.shell?.isOpen) return this.shell;
    this.connecting ??= (async () => RemoteShell.connect(await this.open(), this.opts))().finally(() => (this.connecting = undefined));
    const shell = await this.connecting;
    this.shell = shell;
    this.hadShell = true;
    return shell;
  }
}

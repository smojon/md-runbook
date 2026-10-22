/**
 * A remote session that reconnects: when the connection or the shell has ended (phone asleep,
 * network changed, `exit` in a cell), the next cell opens a new one, after the same host-key
 * check. Cells are never re-run on their own; the result says the shell is new, so the app can
 * warn that the folder and variables of earlier cells are gone.
 *
 * Signed runbooks: where the account runs md-runbook-gate, a signed cell goes as "run cell N" of
 * the runbook's manifest, which the session hands to the gate first (again after a reconnect),
 * with the parameters the cell needs. Elsewhere the same cell runs as plain source.
 */

import type { Stream } from '@microsoft/dev-tunnels-ssh';
import type { GateInfo } from './command';
import { ConnectOptions, RemoteRunOptions, RemoteRunResult, RemoteShell } from './remoteShell';

export interface SessionRunResult extends RemoteRunResult {
  /** This cell ran in a new shell although an earlier one had ended: earlier state is lost. */
  newShell?: boolean;
  /** Through md-runbook-gate: the signer the gate accepted for this run's runbook. */
  signedBy?: string;
}

/** A cell of a signed runbook, for `RemoteSession.run`. */
export interface SignedRun {
  /** The manifest text exactly as signed, and its SSHSIG blob (base64). */
  manifest: string;
  signature: string;
  /** The cell's number in the manifest, and (for a line run) the command's index among its signed commands. */
  cell: number;
  step?: number;
  /** Values of the parameters the cell needs. */
  params?: Record<string, string>;
}

/** The gate refused: exit 126 with its reason, as the gate reports refused cells itself. */
const REFUSED = 126;

export class RemoteSession {
  private shell: RemoteShell | undefined;
  private connecting: Promise<RemoteShell> | undefined;
  private hadShell = false;
  /** The manifest loaded into the current shell's gate, and the parameters set there. */
  private loaded: { shell: RemoteShell; manifest: string; signature: string; principal: string; params: Map<string, string> } | undefined;

  /** `open` makes a new transport for each connection (a TCP socket, a WebSocket to the relay). */
  constructor(
    private readonly open: () => Promise<Stream>,
    private readonly opts: ConnectOptions,
  ) {}

  get isConnected(): boolean {
    return this.shell?.isOpen ?? false;
  }

  /** md-runbook-gate's banner while connected through it. */
  get gate(): GateInfo | undefined {
    return this.shell?.isOpen ? this.shell.gate : undefined;
  }

  /** Connect now (otherwise the first cell does). */
  async connect(): Promise<void> {
    await this.ensure();
  }

  /**
   * Run `source` (a cell, or one command of it). With `signed`, a server that runs md-runbook-gate
   * is asked for that signed cell or command instead, so it runs only what was signed.
   */
  async run(source: string, opts: RemoteRunOptions = {}, signed?: SignedRun): Promise<SessionRunResult> {
    const lost = this.hadShell && !this.isConnected;
    const shell = await this.ensure();
    let r: SessionRunResult;
    if (signed && shell.gate) {
      const refused = await this.prepare(shell, signed);
      if (refused !== undefined) {
        opts.onStderr?.(`md-runbook-gate: ${refused}\n`);
        r = { exitCode: REFUSED, signal: null, timedOut: false, cancelled: false, durationMs: 0 };
      } else r = { ...(await shell.runSigned(signed.cell, signed.step, opts)), signedBy: this.loaded!.principal };
    } else r = await shell.run(source, opts);
    return lost ? { ...r, newShell: true } : r;
  }

  async close(): Promise<void> {
    const s = this.shell;
    this.shell = undefined;
    this.hadShell = false;
    this.loaded = undefined;
    await s?.close();
  }

  /** Load the manifest into this shell's gate and set the cell's parameters; the gate's reason if it refused. */
  private async prepare(shell: RemoteShell, s: SignedRun): Promise<string | undefined> {
    try {
      if (this.loaded?.shell !== shell || this.loaded.manifest !== s.manifest || this.loaded.signature !== s.signature) {
        this.loaded = undefined;
        const { principal } = await shell.loadSigned(s.manifest, s.signature);
        this.loaded = { shell, manifest: s.manifest, signature: s.signature, principal, params: new Map() };
      }
      for (const [name, value] of Object.entries(s.params ?? {})) {
        if (this.loaded.params.get(name) === value) continue;
        await shell.setParam(name, value);
        this.loaded.params.set(name, value);
      }
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
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

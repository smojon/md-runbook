/**
 * One SSH session per host and runbook, kept between cells (the folder and variables carry over,
 * as in the extension's session mode) and reopened by the session itself after the phone slept or
 * the network changed. Each runbook has its own shell: a runbook from a link or a colleague can't
 * read another runbook's secrets or redefine the commands its cells run with. The host key is
 * checked before any credential is sent: unknown or changed keys end the connection and are
 * reported here, so the screen can ask the user.
 */
import type { RunbookShells } from '@md-runbook/core';
import { RemoteSession, hostKeyId } from '@md-runbook/ssh';
import type { Host } from '../hosts/store';
import { appKey } from './appKey';
import { openTransport } from './transport';

export interface Connection {
  session: RemoteSession;
  /** Set during a connection attempt when the server's key is not the trusted one (or none is trusted yet). */
  unknownHostKey?: string;
  /** True when a key was trusted and the server showed another: not a first contact. */
  changed?: boolean;
  /**
   * Secret values this shell was given: an exported secret stays readable by later cells of the
   * runbook, so their output is redacted with all of these (as the extension does per session).
   */
  secrets?: Set<string>;
}

interface Entry extends Connection {
  hostId: string;
  runbookId: string;
  signature: string;
}

const signatureOf = (h: Host, shells: RunbookShells | undefined): string =>
  `${h.hostname}:${h.port}:${h.username}:${h.hostKey ?? ''}:${shells?.unix ?? ''}:${shells?.powershell ?? ''}`;
const keyOf = (hostId: string, runbookId: string): string => `${hostId}\n${runbookId}`;
const entries = new Map<string, Entry>();

/**
 * The connection of a runbook to a host, made on first use; replaced when the host's address, user
 * or trusted key changed, or the runbook's `shell:` (the shells the server starts for it).
 */
export async function connectionFor(host: Host, runbookId: string, shells?: RunbookShells): Promise<Connection> {
  const signature = signatureOf(host, shells);
  const id = keyOf(host.id, runbookId);
  const existing = entries.get(id);
  if (existing?.signature === signature) return existing;
  if (existing) void existing.session.close().catch(() => undefined);
  const key = await appKey();
  const entry: Entry = {
    hostId: host.id,
    runbookId,
    signature,
    secrets: new Set(),
    session: new RemoteSession(() => openTransport(host), {
      username: host.username,
      key,
      shells,
      verifyHostKey: (line) => {
        if (host.hostKey !== undefined && hostKeyId(line) === host.hostKey) return true;
        entry.unknownHostKey = line;
        entry.changed = host.hostKey !== undefined;
        return false;
      },
    }),
  };
  entries.set(id, entry);
  return entry;
}

const matching = (hostId: string, runbookId?: string): Entry[] =>
  [...entries.values()].filter((e) => e.hostId === hostId && (runbookId === undefined || e.runbookId === runbookId));

/** Whether the host has an open shell (for this runbook, or for any). */
export function isConnected(hostId: string, runbookId?: string): boolean {
  return matching(hostId, runbookId).some((e) => e.session.isConnected);
}

/** Close the host's shell for this runbook, or all its shells (the host was edited or removed). */
export async function disconnect(hostId: string, runbookId?: string): Promise<void> {
  const gone = matching(hostId, runbookId);
  for (const e of gone) entries.delete(keyOf(e.hostId, e.runbookId));
  await Promise.all(gone.map((e) => e.session.close().catch(() => undefined)));
}

export async function disconnectAll(): Promise<void> {
  const all = [...entries.values()];
  entries.clear();
  await Promise.all(all.map((e) => e.session.close().catch(() => undefined)));
}

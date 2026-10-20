/**
 * One SSH session per host, kept between cells (the folder and variables carry over, as in the
 * extension's session mode) and reopened by the session itself after the phone slept or the
 * network changed. The host key is checked before any credential is sent: unknown or changed keys
 * end the connection and are reported here, so the screen can ask the user.
 */
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
}

interface Entry extends Connection {
  signature: string;
}

const signatureOf = (h: Host): string => `${h.hostname}:${h.port}:${h.username}:${h.hostKey ?? ''}`;
const entries = new Map<string, Entry>();

/** The host's connection, made on first use; replaced when its address, user or trusted key changed. */
export async function connectionFor(host: Host): Promise<Connection> {
  const signature = signatureOf(host);
  const existing = entries.get(host.id);
  if (existing?.signature === signature) return existing;
  if (existing) void existing.session.close().catch(() => undefined);
  const key = await appKey();
  const entry: Entry = {
    signature,
    session: new RemoteSession(() => openTransport(host), {
      username: host.username,
      key,
      verifyHostKey: (line) => {
        if (host.hostKey !== undefined && hostKeyId(line) === host.hostKey) return true;
        entry.unknownHostKey = line;
        entry.changed = host.hostKey !== undefined;
        return false;
      },
    }),
  };
  entries.set(host.id, entry);
  return entry;
}

export function isConnected(hostId: string): boolean {
  return entries.get(hostId)?.session.isConnected ?? false;
}

export async function disconnect(hostId: string): Promise<void> {
  const e = entries.get(hostId);
  entries.delete(hostId);
  await e?.session.close().catch(() => undefined);
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...entries.keys()].map(disconnect));
}

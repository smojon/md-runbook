/**
 * Install My Key: add this app's public key to a host's authorized_keys with one password login
 * (@md-runbook/ssh installPublicKey). The host key is checked as for every connection: an unknown
 * or changed one comes back as `trust`, with the key to show, and nothing is sent. The password is
 * passed through and not kept.
 */
import { hostKeyId, installPublicKey } from '@md-runbook/ssh';
import type { Host } from '../hosts/store';
import { appPublicKeyLine } from './appKey';
import { openTransport } from './transport';

export type InstallOutcome =
  | { kind: 'added' | 'already' }
  | { kind: 'trust'; hostKey: string; changed: boolean }
  | { kind: 'error'; message: string };

export async function installAppKey(host: Host, password: string): Promise<InstallOutcome> {
  let unknown: string | undefined;
  try {
    const result = await installPublicKey(await openTransport(host), {
      username: host.username,
      password,
      keyLine: await appPublicKeyLine(),
      verifyHostKey: (line) => {
        if (host.hostKey !== undefined && hostKeyId(line) === host.hostKey) return true;
        unknown = line;
        return false;
      },
    });
    return { kind: result };
  } catch (e) {
    if (unknown) return { kind: 'trust', hostKey: unknown, changed: host.hostKey !== undefined };
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

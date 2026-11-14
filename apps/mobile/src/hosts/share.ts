/**
 * Host lists to hand on (a team's servers, a customer's): names, addresses, users, groups and,
 * when asked, the trusted host keys. Never a private key: the app's key stays on this phone; each
 * phone adds its own public key to the hosts. On the web, the relay's address may go with them,
 * never its token. As a file (hosts.json) or as a link
 * (`mdrunbook://hosts?h=…`, the list packed as in runbook links), which a QR code can carry.
 */
import { packText, unpackText } from '@md-runbook/core/runbookLink';
import { Host, HostInput, addHost, getHosts, pinHostKey, validateHost } from './store';
import { t } from '../i18n';
import { relayUrlProblem } from '../ssh/relaySettings';

export interface SharedHost extends HostInput {
  /** The host key the sender trusted; only used when the receiver chooses to trust it too. */
  hostKey?: string;
}

const FORMAT = 'md-runbook hosts v1';

/** The hosts as they are handed on: never the app's key, host keys only when asked. */
export function sharedHosts(hosts: readonly Host[], withKeys: boolean): SharedHost[] {
  return hosts.map((h) => ({
    name: h.name,
    hostname: h.hostname,
    port: h.port,
    username: h.username,
    ...(h.group ? { group: h.group } : {}),
    ...(withKeys && h.hostKey ? { hostKey: h.hostKey } : {}),
  }));
}

/**
 * The hosts as the JSON file's text. `relay`: the web relay's address, for web apps that import
 * the list (never its token: the receiver enters that, or pairs: pairing/payload.ts).
 */
export function hostsJson(hosts: readonly Host[], withKeys: boolean, relay?: string): string {
  return JSON.stringify({ format: FORMAT, hosts: sharedHosts(hosts, withKeys), ...(relay ? { relay } : {}) }, null, 2) + '\n';
}

/** The hosts as a link, for a QR code or a message. */
export function hostsLink(hosts: readonly Host[], withKeys: boolean, relay?: string): string {
  return `mdrunbook://hosts/import?h=${packText(JSON.stringify(JSON.parse(hostsJson(hosts, withKeys, relay))))}`;
}

/** A shared list's hosts, each checked as the form checks a typed host; the reason when one isn't. */
export function readHostList(list: readonly unknown[]): { hosts: SharedHost[] } | { error: string } {
  const hosts: SharedHost[] = [];
  for (const e of list) {
    const x = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    const host: SharedHost = {
      name: String(x.name ?? ''),
      hostname: String(x.hostname ?? ''),
      port: typeof x.port === 'number' ? x.port : NaN,
      username: String(x.username ?? ''),
      ...(typeof x.group === 'string' && x.group ? { group: x.group } : {}),
      ...(typeof x.hostKey === 'string' && /^[\w-]+ [A-Za-z0-9+/=]+$/.test(x.hostKey) ? { hostKey: x.hostKey } : {}),
    };
    if (validateHost(host, t.hostErrors).length > 0) return { error: t.hostsBadEntry(host.name || '?') };
    hosts.push(host);
  }
  return { hosts };
}

/**
 * The hosts in a pasted file text, a hosts link (`…?h=`) or the packed `h` alone; each checked as
 * the form checks a typed host. Undefined with the reason when it is none of these.
 */
export function readHosts(input: string): { hosts: SharedHost[]; relay?: string } | { error: string } {
  let text = input.trim();
  const h = /[?&]h=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? (/^[A-Za-z0-9_-]{8,}$/.test(text) ? text : undefined);
  if (h) {
    const unpacked = unpackText(h);
    if (typeof unpacked !== 'string') return { error: t.hostsDamaged };
    text = unpacked;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: t.hostsNotList };
  }
  const list = (data as { format?: unknown; hosts?: unknown }).hosts;
  if ((data as { format?: unknown }).format !== FORMAT || !Array.isArray(list)) return { error: t.hostsNotList };
  const read = readHostList(list);
  if ('error' in read) return read;
  // The relay's address, when the sender's web app named one (an address only: never a token).
  const relay = (data as { relay?: unknown }).relay;
  return typeof relay === 'string' && relayUrlProblem(relay) === undefined ? { ...read, relay: relay.trim() } : read;
}

/**
 * Add the hosts the app doesn't have yet (by name); those it has are left alone. Their host keys
 * are trusted only when `trustKeys` (the sender is trusted): otherwise the first connection asks.
 */
export function importHosts(hosts: readonly SharedHost[], trustKeys: boolean): { added: string[]; skipped: string[] } {
  const have = new Set(getHosts().map((h) => h.name.toLowerCase()));
  const added: string[] = [];
  const skipped: string[] = [];
  for (const s of hosts) {
    if (have.has(s.name.toLowerCase())) {
      skipped.push(s.name);
      continue;
    }
    const { hostKey, ...input } = s;
    const h = addHost(input);
    if (trustKeys && hostKey) pinHostKey(h.id, hostKey);
    have.add(s.name.toLowerCase());
    added.push(s.name);
  }
  return { added, skipped };
}

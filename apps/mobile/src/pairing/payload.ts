/**
 * Pairing: one web app hands another (a laptop to a phone's browser) what it needs to run cells
 * through the relay: the relay's address and token, and optionally the hosts with their host
 * keys. Shown as a QR code (Hosts & settings → Relay → Pair a device) or as a link whose payload
 * is in the fragment (`https://<web app>/pair#mdrb-pair.v1.…`): browsers never send a fragment to
 * the server, and the app removes it from the address bar as soon as it has read it.
 *
 * The payload: the type marker `mdrb-pair.`, the version `v1.`, then the JSON below deflated and
 * in base64url (as rb= runbook links: core/runbookLink.ts packText):
 *
 *   {"format":"md-runbook pair v1","relay":"wss://ops.example.net","token":"…","hosts":[…]}
 *
 * `hosts` is the hosts list's format (hosts/share.ts), optional. `signers` (optional): for each team
 * library the sending device trusts signers from, `{"library": "https://…/runbooks/", "fingerprints":
 * ["SHA256:…"]}`, to compare with what the library publishes, never trusted by itself
 * (signerHints.ts); an older app ignores it. The marker tells a pairing code
 * from a runbook link, a hosts link or a library link when a code is scanned. The token is a
 * secret: it goes in a QR code or a fragment, never in a URL's query.
 */
import { packText, unpackText } from '@md-runbook/core/runbookLink';
import { readHostList, SharedHost } from '../hosts/share';
import { readSignerHints, SignerHint } from './signerHints';
import { badTokenCharacter, relayUrlProblem } from '../ssh/relaySettings';

export const PAIR_MARKER = 'mdrb-pair.';
export const PAIR_PREFIX = `${PAIR_MARKER}v1.`;
const FORMAT = 'md-runbook pair v1';
/** The web app's route that reads a pairing link's fragment (src/app/pair.tsx). */
export const PAIR_PATH = '/pair';

export interface Pairing {
  /** The relay's address, as the receiving device reaches it (wss://…). */
  relay: string;
  token: string;
  hosts?: SharedHost[];
  /** What the sending device trusts per library, to compare with (signerHints.ts). */
  signers?: SignerHint[];
}

/** The pairing as a code's text (QR code) or a link's fragment. */
export function encodePairing(p: Pairing): string {
  const json = {
    format: FORMAT,
    relay: p.relay,
    token: p.token,
    ...(p.hosts && p.hosts.length > 0 ? { hosts: p.hosts } : {}),
    ...(p.signers && p.signers.length > 0 ? { signers: p.signers } : {}),
  };
  return PAIR_PREFIX + packText(JSON.stringify(json));
}

/** The pairing link: the web app's /pair with the payload in the fragment (never the query). */
export function pairingLink(appBase: string, payload: string): string {
  return `${appBase.replace(/\/+$/, '')}${PAIR_PATH}#${payload}`;
}

/** Whether a scanned code or pasted text is a pairing (a payload, or a pairing link). */
export function looksLikePairing(text: string): boolean {
  return payloadOf(text) !== undefined;
}

/** The payload in a code's text: the payload itself, or a pairing link's fragment. */
function payloadOf(text: string): string | undefined {
  const s = text.trim();
  if (s.startsWith(PAIR_MARKER)) return s;
  const hash = s.indexOf('#');
  if (hash < 0) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  const fragment = s.slice(hash + 1);
  return /^https?:$/.test(u.protocol) && u.pathname.replace(/\/+$/, '').endsWith(PAIR_PATH) && fragment.startsWith(PAIR_MARKER)
    ? fragment
    : undefined;
}

export type PairingProblem = 'not-pairing' | 'newer' | 'damaged';

/**
 * Read a pairing code or link. Its relay address and token are checked as the settings check them
 * (a token a browser can't send is refused here, not at the first run); its hosts as a hosts list.
 */
export function decodePairing(text: string): { pairing: Pairing } | { problem: PairingProblem } | { error: string } {
  const payload = payloadOf(text);
  if (payload === undefined) return { problem: 'not-pairing' };
  if (!payload.startsWith(PAIR_PREFIX)) return { problem: 'newer' };
  const unpacked = unpackText(payload.slice(PAIR_PREFIX.length));
  if (typeof unpacked !== 'string') return { problem: 'damaged' };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(unpacked) as Record<string, unknown>;
  } catch {
    return { problem: 'damaged' };
  }
  if (typeof data !== 'object' || data === null || data.format !== FORMAT) return { problem: 'damaged' };
  const { relay, token, hosts, signers } = data;
  if (typeof relay !== 'string' || relayUrlProblem(relay) !== undefined) return { problem: 'damaged' };
  if (typeof token !== 'string' || token === '' || badTokenCharacter(token) !== undefined) return { problem: 'damaged' };
  const pairing: Pairing = { relay: relay.trim(), token };
  if (hosts !== undefined) {
    if (!Array.isArray(hosts)) return { problem: 'damaged' };
    const read = readHostList(hosts);
    if ('error' in read) return { error: read.error };
    pairing.hosts = read.hosts;
  }
  if (signers !== undefined) {
    const hints = readSignerHints(signers);
    if (!hints) return { problem: 'damaged' };
    pairing.signers = hints;
  }
  return { pairing };
}

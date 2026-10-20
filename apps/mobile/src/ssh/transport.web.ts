/**
 * Web: browsers can't open TCP connections, so the page opens a WebSocket to the user's relay
 * (apps/relay), which copies bytes to the host's SSH port. SSH runs in the browser; the relay
 * sees only ciphertext (and which host is reached, when). The relay's address and token are
 * settings. Before connecting, the app asks the relay which protocol it speaks (v1 here).
 */
import { Stream, WebSocketStream } from '@microsoft/dev-tunnels-ssh';
import type { Host } from '../hosts/store';
import { t } from '../i18n';
import { getRelaySettings } from './relaySettings';

export const RELAY_PROTOCOL = 1;
const SUBPROTOCOL = 'mdrb-relay.v1';

/** `wss://relay.example.net` or `https://…` (either works): the WebSocket and HTTP bases. */
export function relayBases(url: string): { ws: string; http: string } {
  const base = url.trim().replace(/\/+$/, '');
  const ws = base.replace(/^http(s?):\/\//i, 'ws$1://');
  return { ws, http: ws.replace(/^ws(s?):\/\//i, 'http$1://') };
}

/** Undefined when the relay speaks our protocol, else why not (unreachable, too old, too new). */
export async function checkRelay(url: string, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  let info: unknown;
  try {
    const r = await fetchFn(`${relayBases(url).http}/v1/server-info`, { cache: 'no-store' });
    if (!r.ok) return r.status === 404 ? t.relayTooOld(url) : t.relayUnreachable(url);
    info = await r.json();
  } catch {
    return t.relayUnreachable(url);
  }
  const protocol = (info as { protocol?: unknown } | null)?.protocol;
  if (typeof protocol !== 'number') return t.relayUnreachable(url);
  if (protocol < RELAY_PROTOCOL) return t.relayTooOld(url);
  if (protocol > RELAY_PROTOCOL) return t.relayTooNew(url);
  return undefined;
}

export async function openTransport(host: Host): Promise<Stream> {
  const relay = await getRelaySettings();
  if (!relay) throw new Error(t.relayNotConfigured);
  const problem = await checkRelay(relay.url);
  if (problem) throw new Error(problem);
  const url = `${relayBases(relay.url).ws}/v1/ssh?target=${encodeURIComponent(`${host.hostname}:${host.port}`)}`;
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, [SUBPROTOCOL, `token.${relay.token}`]);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error(t.relayRefused(relay.url)));
  });
  return new WebSocketStream(ws);
}

/** A message when runs can't work yet (no relay configured), else undefined. */
export async function transportReady(): Promise<string | undefined> {
  return (await getRelaySettings()) ? undefined : t.relayNotConfigured;
}

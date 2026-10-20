/**
 * Web: browsers can't open TCP connections, so the page opens a WebSocket to the user's relay,
 * which copies bytes to the host's SSH port. SSH runs in the browser; the relay sees only
 * ciphertext (and which host is reached, when). The relay's address and token are settings.
 */
import { Stream, WebSocketStream } from '@microsoft/dev-tunnels-ssh';
import type { Host } from '../hosts/store';
import { t } from '../i18n';
import { getRelaySettings } from './relaySettings';

export async function openTransport(host: Host): Promise<Stream> {
  const relay = await getRelaySettings();
  if (!relay) throw new Error(t.relayNotConfigured);
  const url = `${relay.url.replace(/\/+$/, '')}/ssh?target=${encodeURIComponent(`${host.hostname}:${host.port}`)}`;
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, ['mdrb-relay', `token.${relay.token}`]);
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

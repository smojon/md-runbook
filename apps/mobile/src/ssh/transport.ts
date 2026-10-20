/** iOS and Android: a TCP connection straight to the host's SSH port. The web has transport.web.ts. */
import type { Stream } from '@microsoft/dev-tunnels-ssh';
import type { Host } from '../hosts/store';
import { TcpSocketStream } from './tcpStream';

export function openTransport(host: Host): Promise<Stream> {
  return TcpSocketStream.connect(host.hostname, host.port);
}

/** Whether runs are possible as things are set up (always, with a direct connection). */
export async function transportReady(): Promise<string | undefined> {
  return undefined;
}

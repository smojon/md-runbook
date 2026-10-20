/** The SSH library's Stream over a React Native TCP socket (react-native-tcp-socket), iOS and Android. */
import { BaseStream } from '@microsoft/dev-tunnels-ssh';
import { Buffer } from 'buffer';
import TcpSocket from 'react-native-tcp-socket';

export class TcpSocketStream extends BaseStream {
  private constructor(private readonly socket: ReturnType<typeof TcpSocket.createConnection>) {
    super();
    socket.on('data', (d) => this.onData(Buffer.from(d as unknown as Uint8Array)));
    socket.on('error', (e) => this.onError(e instanceof Error ? e : new Error(String(e))));
    socket.on('close', () => this.onEnd());
  }

  /**
   * No Nagle delay: cells and end-of-cell markers are small writes (the spike measured ~170 ms per
   * cell on the iOS simulator against ~10 ms on Android). A connection that neither succeeds nor
   * fails within `timeoutMs` (a firewall that drops packets) is given up.
   */
  static connect(host: string, port: number, timeoutMs = 20_000): Promise<TcpSocketStream> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = TcpSocket.createConnection({ host, port }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(new TcpSocketStream(socket));
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`connecting to ${host}:${port} timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      socket.once('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data as unknown as Uint8Array, undefined, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(error?: Error): Promise<void> {
    this.socket.destroy();
    this.fireOnClose(error);
  }
}

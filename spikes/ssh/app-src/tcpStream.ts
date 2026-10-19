/** The SSH library's Stream over a React Native TCP socket (react-native-tcp-socket). */

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

  static connect(host: string, port: number): Promise<TcpSocketStream> {
    return new Promise((resolve, reject) => {
      const socket = TcpSocket.createConnection({ host, port }, () => resolve(new TcpSocketStream(socket)));
      socket.once('error', reject);
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

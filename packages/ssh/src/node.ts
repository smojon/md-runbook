/** @md-runbook/ssh/node: a TCP transport for Node (tests, a future CLI `--host`). */

import * as net from 'node:net';
import { NodeStream } from '@microsoft/dev-tunnels-ssh';

/**
 * Open a TCP connection for the SSH session. No Nagle delay: cells and markers are small writes,
 * which Nagle and delayed ACKs would hold back.
 */
export function connectTcp(host: string, port: number, timeoutMs = 20_000): Promise<NodeStream> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connecting to ${host}:${port} timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(new NodeStream(socket));
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

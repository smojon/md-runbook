/**
 * Spike: the web app's relay. Browsers can't open TCP connections, so the page opens a WebSocket
 * here and the relay copies bytes to and from an SSH server. SSH itself runs in the browser: the
 * relay only ever sees encrypted SSH traffic.
 *
 * It must not become an open proxy:
 * - only targets listed in RELAY_TARGETS (`host:port,host:port`) can be reached;
 * - a token is required (RELAY_TOKEN), sent as a WebSocket subprotocol `token.<value>` so it
 *   doesn't end up in URLs and access logs;
 * - at most RELAY_MAX_CONNECTIONS at a time (default 20);
 * - optionally only pages from RELAY_ORIGINS (comma-separated) may connect;
 * - it logs who connected to which target, never the data.
 *
 * It also serves the spike's browser page and bundle from dist/ (spike only).
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const port = Number(process.env.RELAY_PORT ?? 8022);
const token = process.env.RELAY_TOKEN ?? '';
const targets = new Set((process.env.RELAY_TARGETS ?? '').split(',').map((t) => t.trim()).filter(Boolean));
const origins = new Set((process.env.RELAY_ORIGINS ?? '').split(',').map((t) => t.trim()).filter(Boolean));
const maxConnections = Number(process.env.RELAY_MAX_CONNECTIONS ?? 20);
if (token.length < 16) throw new Error('RELAY_TOKEN must be at least 16 characters');
if (targets.size === 0) throw new Error('RELAY_TARGETS must list at least one host:port');

const sameToken = (given: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

let open = 0;
const log = (msg: string): void => console.log(`[relay] ${new Date().toISOString()} ${msg}`);

const server = http.createServer((req, res) => {
  // Spike only: serve the browser test page and bundle.
  const file = req.url === '/' ? 'spikeB.html' : req.url === '/spikeB.js' ? 'spikeB.js' : undefined;
  if (!file) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'text/javascript' });
  res.end(fs.readFileSync(path.join(__dirname, file)));
});

const wss = new WebSocketServer({
  server,
  path: '/ssh',
  maxPayload: 1 << 20,
  handleProtocols: (protocols) => (protocols.has('mdrb-relay') ? 'mdrb-relay' : false),
  verifyClient: ({ req, origin }, done) => {
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    const given = offered.find((p) => p.startsWith('token.'))?.slice('token.'.length) ?? '';
    const target = new URL(req.url ?? '', 'http://relay').searchParams.get('target') ?? '';
    const who = req.socket.remoteAddress ?? '?';
    if (origins.size > 0 && !origins.has(origin)) return log(`refused ${who}: origin ${origin}`), done(false, 403);
    if (!sameToken(given)) return log(`refused ${who}: bad token`), done(false, 401);
    if (!targets.has(target)) return log(`refused ${who}: target ${target} not allowed`), done(false, 403);
    if (open >= maxConnections) return log(`refused ${who}: too many connections`), done(false, 503);
    done(true);
  },
});

wss.on('connection', (ws, req) => {
  const target = new URL(req.url ?? '', 'http://relay').searchParams.get('target')!;
  const [host, portText] = [target.slice(0, target.lastIndexOf(':')), target.slice(target.lastIndexOf(':') + 1)];
  const who = req.socket.remoteAddress ?? '?';
  open++;
  log(`${who} -> ${target} (open: ${open})`);
  const tcp = net.connect(Number(portText), host);
  const closeBoth = (): void => {
    tcp.destroy();
    ws.close();
  };
  tcp.on('data', (b) => ws.readyState === ws.OPEN && ws.send(b));
  tcp.on('error', closeBoth);
  tcp.on('close', () => ws.close());
  ws.on('message', (data: Buffer) => tcp.write(data));
  ws.on('close', () => {
    open--;
    tcp.destroy();
    log(`${who} -> ${target} closed (open: ${open})`);
  });
  ws.on('error', closeBoth);
});

server.listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port}, targets ${[...targets].join(', ')}`));

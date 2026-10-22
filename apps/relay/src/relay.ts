/**
 * The md-runbook relay: lets the web app reach SSH servers. Browsers can't open TCP connections,
 * so the page opens a WebSocket here and the relay copies bytes to and from one allowed SSH
 * server. SSH runs in the browser: the relay sees only encrypted SSH traffic, plus who connects
 * to which host and when (that is what it logs, never the data).
 *
 * Protocol v1:
 *   GET /v1/server-info   {"name":"md-runbook-relay","protocol":1,"version":…,"capabilities":["ssh"]}
 *   GET /healthz          200 "ok"
 *   WS  /v1/ssh?target=host:port   subprotocols "mdrb-relay.v1" and "token.<token>"
 * The token travels as a subprotocol so it never lands in URLs or access logs.
 *
 * Not an open proxy: allowlisted targets only, a token, an origin list, caps on connections
 * (overall and per client), and clients that fail the token check too often are refused for a while.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { IncomingMessage, Server, createServer } from 'node:http';
import { LookupFunction, Socket, connect, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { WebSocket, WebSocketServer } from 'ws';
import type { RelayConfig } from './config';

export const PROTOCOL = 1;
export const SUBPROTOCOL = 'mdrb-relay.v1';
/** Bytes queued towards the browser above which reading from the SSH server pauses. */
const HIGH_WATER = 1 << 20;
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
};

export interface RelayInfo {
  name: 'md-runbook-relay';
  protocol: number;
  version: string;
  capabilities: string[];
}

export type LogEvent = Record<string, string | number | boolean | undefined> & { event: string };

export interface Relay {
  server: Server;
  /** Connections open now. */
  open(): number;
  /** Stop accepting, close every connection. */
  close(): Promise<void>;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export function createRelay(config: RelayConfig, version: string, log: (e: LogEvent) => void = defaultLog): Relay {
  const tokenDigests = config.tokens.map(digest);
  const tokenOk = (given: string): boolean => {
    const d = digest(given);
    // Compare with every token, always, so timing says nothing about which one matched.
    let ok = false;
    for (const t of tokenDigests) ok = timingSafeEqual(d, t) || ok;
    return ok;
  };
  /** 'listed': the host is named in the targets; 'any': only `*:port` allows it (public addresses only). */
  const targetOk = (target: string): 'listed' | 'any' | undefined => {
    const at = target.lastIndexOf(':');
    if (at <= 0) return undefined;
    const host = target.slice(0, at).toLowerCase();
    const port = target.slice(at + 1);
    const rules = config.targets.map((t) => [t.slice(0, t.lastIndexOf(':')).toLowerCase(), t.slice(t.lastIndexOf(':') + 1)] as const);
    if (rules.some(([th, tp]) => tp === port && th === host)) return 'listed';
    return rules.some(([th, tp]) => tp === port && th === '*') ? 'any' : undefined;
  };

  const failures = new Map<string, number[]>();
  const recordFailure = (client: string, now: number): void => {
    // Many clients (rotating addresses): drop the expired entries before the map grows further.
    if (failures.size >= 10_000) for (const c of [...failures.keys()]) failedRecently(c, now);
    failures.set(client, [...(failures.get(client) ?? []), now]);
  };
  const failedRecently = (client: string, now: number): number => {
    const list = (failures.get(client) ?? []).filter((t) => now - t < config.failWindowMs);
    if (list.length > 0) failures.set(client, list);
    else failures.delete(client);
    return list.length;
  };
  const perClient = new Map<string, number>();
  const sockets = new Set<{ ws: WebSocket; tcp: Socket }>();

  const clientOf = (req: IncomingMessage): string => {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (fwd.length > 0) return fwd[fwd.length - 1]!;
    }
    return req.socket.remoteAddress ?? '?';
  };

  const info: RelayInfo = { name: 'md-runbook-relay', protocol: PROTOCOL, version, capabilities: ['ssh'] };
  const corsOrigin = (origin: string | undefined): string | undefined =>
    config.origins.length === 0 ? '*' : origin && config.origins.includes(origin) ? origin : undefined;

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const allow = corsOrigin(req.headers.origin);
    if (allow) headers['access-control-allow-origin'] = allow;
    if (req.method === 'GET' && path === '/v1/server-info') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(info));
    } else if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { ...headers, 'content-type': 'text/plain' }).end('ok');
    } else res.writeHead(404, headers).end();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1 << 20,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  server.on('upgrade', (req, socket, head) => {
    const refuse = (status: number, why: string, client: string): void => {
      log({ event: 'refused', client, why, status });
      socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    };
    const client = clientOf(req);
    const now = Date.now();
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname !== '/v1/ssh') return refuse(404, 'path', client);
    if (failedRecently(client, now) >= config.maxFailures) return refuse(429, 'too many failed tokens', client);
    const origin = req.headers.origin;
    if (config.origins.length > 0 && !(origin && config.origins.includes(origin))) return refuse(403, `origin ${origin ?? '-'}`, client);
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim());
    if (!offered.includes(SUBPROTOCOL)) return refuse(400, 'protocol version', client);
    const given = offered.find((p) => p.startsWith('token.'))?.slice('token.'.length) ?? '';
    if (!tokenOk(given)) {
      recordFailure(client, now);
      return refuse(401, 'token', client);
    }
    const target = url.searchParams.get('target') ?? '';
    const allowed = targetOk(target);
    if (!allowed) return refuse(403, `target ${target}`, client);
    const literal = target.slice(0, target.lastIndexOf(':')).replace(/^\[(.*)\]$/, '$1');
    if (allowed === 'any' && isIP(literal) && isInternal(literal)) return refuse(403, `target ${target} (internal address)`, client);
    if (sockets.size >= config.maxConnections) return refuse(429, 'relay full', client);
    if ((perClient.get(client) ?? 0) >= config.maxPerClient) return refuse(429, 'client limit', client);
    wss.handleUpgrade(req, socket, head, (ws) => pipe(ws, client, target, allowed === 'any'));
  });

  function pipe(ws: WebSocket, client: string, target: string, publicOnly: boolean): void {
    const at = target.lastIndexOf(':');
    const host = target.slice(0, at).replace(/^\[(.*)\]$/, '$1');
    const started = Date.now();
    let up = 0;
    let down = 0;
    // Allowed only by `*:port`: a name that resolves to the relay's own or a private network is refused.
    const lookup: LookupFunction = (hostname, options, callback) =>
      dnsLookup(hostname, options, (err, address, family) => {
        const all = Array.isArray(address) ? address.map((a) => a.address) : [address];
        if (!err && all.some((a) => isInternal(a))) return callback(Object.assign(new Error('internal address'), { code: 'EINTERNAL' }), address, family);
        callback(err, address, family);
      });
    const tcp = connect({ host, port: Number(target.slice(at + 1)), timeout: config.connectTimeoutMs, ...(publicOnly ? { lookup } : {}) });
    const pair = { ws, tcp };
    sockets.add(pair);
    perClient.set(client, (perClient.get(client) ?? 0) + 1);
    log({ event: 'open', client, target, open: sockets.size });

    let closed = false;
    const done = (why: string): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      sockets.delete(pair);
      const n = (perClient.get(client) ?? 1) - 1;
      if (n > 0) perClient.set(client, n);
      else perClient.delete(client);
      tcp.destroy();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(why === 'target closed' ? 1000 : 1011);
      log({ event: 'close', client, target, why, up, down, ms: Date.now() - started, open: sockets.size });
    };

    tcp.on('connect', () => tcp.setTimeout(0));
    tcp.on('timeout', () => done('connect timeout'));
    tcp.on('error', (e: NodeJS.ErrnoException) => done(`target error ${e.code ?? e.message}`));
    tcp.on('close', () => done('target closed'));
    tcp.on('data', (b: Buffer) => {
      down += b.length;
      ws.send(b, () => {
        if (ws.bufferedAmount < HIGH_WATER && tcp.isPaused()) tcp.resume();
      });
      if (ws.bufferedAmount >= HIGH_WATER) tcp.pause();
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return done('text frame');
      up += data.length;
      if (!tcp.write(data)) {
        ws.pause();
        tcp.once('drain', () => ws.resume());
      }
    });
    ws.on('close', () => done('client closed'));
    ws.on('error', () => done('client error'));

    // Dead browsers (sleeping laptop, lost network) are noticed and their connection freed.
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return done('no pong');
      alive = false;
      ws.ping();
    }, config.pingIntervalMs);
    ping.unref();
  }

  return {
    server,
    open: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const { ws, tcp } of sockets) {
          ws.close(1001);
          tcp.destroy();
        }
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Loopback, private, link-local, carrier-grade NAT and unspecified addresses (IPv4, IPv6, mapped). */
export function isInternal(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127);
  }
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

function defaultLog(e: LogEvent): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...e }));
}

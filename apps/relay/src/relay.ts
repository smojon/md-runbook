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
import { BlockList, LookupFunction, Socket, connect, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RelayConfig } from './config';

export const PROTOCOL = 1;
export const SUBPROTOCOL = 'mdrb-relay.v1';
/** Bytes queued towards the browser above which reading from the SSH server pauses. */
const HIGH_WATER = 1 << 20;
/** How long a refused client may take to read the refusal before its socket is closed anyway. */
const REFUSAL_LINGER_MS = 5000;
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
function destroySocket(this: Duplex): void {
  this.destroy();
}

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
    // Node removes its own 'error' listener on upgrade: without this one, a client that resets the
    // connection while being refused crashes the relay (threat-model review, 2026-11-27). As in the
    // ws README's "Client authentication" example.
    socket.on('error', destroySocket);
    const refuse = (status: number, why: string, client: string): void => {
      log({ event: 'refused', client, why, status });
      // Closed once the answer is out, as ws does: a client that keeps its side open can't hold
      // the socket. One that never reads is cut off after a while.
      socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`, () => socket.destroy());
      setTimeout(() => socket.destroy(), REFUSAL_LINGER_MS).unref();
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
    // ws puts its own 'error' listener on the socket from here on.
    socket.removeListener('error', destroySocket);
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

// Parsed, not compared as text: `0:0:0:0:0:0:0:1`, `::ffff:7f00:1` and NAT64 `64:ff9b::a00:1` are
// loopback or private too (security review, 2026-11-16). An IPv4 rule also matches its IPv4-mapped
// IPv6 address (::ffff:a.b.c.d).
const INTERNAL = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  INTERNAL.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['::ffff:0:0:0', 96], // IPv4-translated
  // NAT64 (64:ff9b::/32): judged by the IPv4 address in its two known forms (nat64Ipv4).
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated, still routed on some networks)
  ['ff00::', 8], // multicast
] as const)
  INTERNAL.addSubnet(net, bits, 'ipv6');

/** The 16 bytes of an IPv6 address (`::`, a trailing dotted IPv4 and a `%zone` allowed), or undefined. */
function ipv6Bytes(address: string): number[] | undefined {
  let a = address.replace(/%.*$/, '');
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [x, y, z, w] = v4.slice(1).map(Number) as [number, number, number, number];
    a = `${a.slice(0, v4.index)}${((x << 8) | y).toString(16)}:${((z << 8) | w).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return undefined;
  const words = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const head = words(halves[0]!);
  const tail = halves.length === 2 ? words(halves[1]!) : [];
  const all = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head;
  if (all.length !== 8 || all.some((w) => !/^[0-9a-f]{1,4}$/i.test(w))) return undefined;
  return all.flatMap((w) => [parseInt(w, 16) >> 8, parseInt(w, 16) & 0xff]);
}

/**
 * The IPv4 address a NAT64 address stands for, or `'unknown'` when it can't be told: in the
 * well-known prefix 64:ff9b::/96 it is the last 32 bits (RFC 6052). In the local-use 64:ff9b:1::/48
 * only the /96 form (64:ff9b:1::a.b.c.d) is read; another layout of the /48 could put the address
 * elsewhere, so it is refused. So is the rest of 64:ff9b::/32 (64:ff9b::ffff:a00:1,
 * 64:ff9b:a00:1::): a translator may map it too. Undefined: not in 64:ff9b::/32.
 */
function nat64Ipv4(address: string): string | 'unknown' | undefined {
  const b = ipv6Bytes(address);
  if (!b) return undefined;
  const v4 = (): string => b.slice(12).join('.');
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  if (b[0] !== 0x00 || b[1] !== 0x64 || b[2] !== 0xff || b[3] !== 0x9b) return undefined;
  if (zero(4, 12)) return v4(); // 64:ff9b::/96
  if (b[4] === 0x00 && b[5] === 0x01 && zero(6, 12)) return v4(); // 64:ff9b:1::/96
  return 'unknown';
}

/**
 * Loopback, private, link-local, multicast, reserved, and IPv6 forms that embed an IPv4 address.
 * A NAT64 address counts as the IPv4 address it embeds: a DNS64-only relay reaches public IPv4
 * hosts through 64:ff9b::/96, never internal ones.
 */
export function isInternal(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return INTERNAL.check(address, 'ipv4');
  if (family !== 6) return false;
  const nat64 = nat64Ipv4(address);
  if (nat64 !== undefined) return nat64 === 'unknown' || INTERNAL.check(nat64, 'ipv4');
  return INTERNAL.check(address, 'ipv6');
}

function defaultLog(e: LogEvent): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...e }));
}

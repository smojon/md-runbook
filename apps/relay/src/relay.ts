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
 * Pairing mode (docs/design/relay-pairing.md), with connectors configured; capability "pair.v1":
 *   WS  /v1/connector?name=NAME        a connector's control socket ("mdrb-connector.v1")
 *   WS  /v1/connector/accept?id=ID     its data socket for one session ("mdrb-connector.v1")
 *   WS  /v1/connect?name=NAME          a client ("mdrb-relay.v1"), spliced with that data socket
 *
 * Not an open proxy: allowlisted targets only, a token, an origin list, caps on connections
 * (overall and per client), and clients that fail the token check too often are refused for a while.
 * A session ends after a maximum lifetime. Logs name the token a session used by a short hash.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { IncomingMessage, Server, createServer } from 'node:http';
import { BlockList, LookupFunction, connect, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { NAME, RelayConfig } from './config';
import { Splice, WsLabels, closeSoon, splice, tcpEnd, wsEnd } from './splice';

export const PROTOCOL = 1;
export const SUBPROTOCOL = 'mdrb-relay.v1';
export const CONNECTOR_SUBPROTOCOL = 'mdrb-connector.v1';
/**
 * The largest frame a browser may send. The web app's SSH library sends one SSH packet per
 * frame: its length (4 bytes), the packet, and its MAC. OpenSSH refuses a packet over 256 KiB
 * (PACKET_MAX_SIZE in its packet.c), so a larger frame is never good SSH. 1 KiB to spare.
 */
export const MAX_FRAME = (256 << 10) + 1024;
/** The largest message on a connector's control socket: small JSON only. */
export const MAX_CONTROL_FRAME = 4096;
/** How long a client waits for the connector's data socket. */
export const ACCEPT_TIMEOUT_MS = 10_000;
/** Client addresses whose failed token checks are remembered at most (the oldest go first). */
const MAX_FAILURE_CLIENTS = 10_000;
/** How long a refused client may take to read the refusal before its socket is closed anyway. */
const REFUSAL_LINGER_MS = 5000;
/** Bytes a waiting client may send before its upgrade (a WebSocket client sends none). */
const MAX_EARLY_BYTES = 64 << 10;
/** Ended session ids remembered, to answer a late connector 410 rather than 404. */
const MAX_ENDED = 10_000;
const ENDED_MS = 60_000;
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  410: 'Gone',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export interface RelayInfo {
  name: 'md-runbook-relay';
  protocol: number;
  version: string;
  capabilities: string[];
}

export type LogEvent = Record<string, string | number | boolean | undefined> & { event: string };
type LogFields = Record<string, string | number | boolean | undefined>;

export interface Relay {
  server: Server;
  /** Sessions open now (both modes). */
  open(): number;
  /** Clients waiting for their connector now. */
  waiting(): number;
  /** Connectors' control sockets open now. */
  connectors(): number;
  /** Bytes queued towards peers in all open sessions. */
  buffered(): number;
  /** Bytes read from peers in all open sessions. */
  moved(): number;
  /** Client addresses (or IPv6 /64s) with failed token checks remembered now. */
  failureClients(): number;
  /** Stop accepting, close every connection. */
  close(): Promise<void>;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
/** The browser's end of a session, in the log. */
const CLIENT_LABELS: WsLabels = { closed: 'client closed', error: 'client error', text: 'text frame', pong: 'no pong' };
/** The connector's data socket, in the log. */
const CONNECTOR_LABELS: WsLabels = { closed: 'connector closed', error: 'connector error', text: 'connector text frame', pong: 'connector no pong' };
function destroySocket(this: Duplex): void {
  this.destroy();
}

/**
 * What a token is called in the log: `token-` and the first 8 hex digits of its SHA-256, as the
 * library server names a token without a label. Says which token a session used, not the token.
 */
export function tokenName(token: string): string {
  return `token-${digest(token).toString('hex').slice(0, 8)}`;
}

/**
 * What the per-client limits count against. An IPv6 address that embeds an IPv4 address counts
 * as that IPv4 address: IPv4-mapped (::ffff:0:0/96), IPv4-translated (SIIT, ::ffff:0:0:0/96),
 * IPv4-compatible (::/96, not :: or ::1) and NAT64's well-known prefix (64:ff9b::/96). Any other
 * IPv6 address counts by its /64: one host or one network usually holds a whole /64, so a client
 * can't pass the limits by changing its address in it.
 */
export function clientKey(address: string): string {
  const a = address.replace(/^\[(.*)\]$/, '$1');
  if (isIP(a.replace(/%.*$/, '')) !== 6) return a;
  const b = ipv6Bytes(a);
  if (!b) return a;
  const zero = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  const v4 = b.slice(12).join('.');
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4; // ::ffff:a.b.c.d
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return v4; // ::ffff:0:a.b.c.d
  if (zero(0, 12) && v4 !== '0.0.0.0' && v4 !== '0.0.0.1') return v4; // ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4; // 64:ff9b::a.b.c.d
  return `${[0, 2, 4, 6].map((i) => ((b[i]! << 8) | b[i + 1]!).toString(16)).join(':')}::/64`;
}

/**
 * What a token opens. v1 (RELAY_TOKEN…): /v1/ssh, and /v1/connect for every name. client
 * (RELAY_CLIENTS_FILE): /v1/connect for its names. connector (RELAY_CONNECTORS_FILE):
 * /v1/connector and /v1/connector/accept for its one name, from its source ranges.
 */
interface TokenEntry {
  digest: Buffer;
  /** Its name in the log (tokenName). */
  name: string;
  kind: 'v1' | 'client' | 'connector';
  /** The names a client may reach; `*`: all. */
  names: readonly string[];
  /** The name a connector registers. */
  connector?: string;
  /** A connector's source ranges; undefined: any. */
  sources?: BlockList;
}

/** A connector's control socket. */
interface Connector {
  ws: WebSocket;
  name: string;
  entry: TokenEntry;
  address: string;
  /** Sessions sent to it that wait for its data socket. */
  waiting: Set<Pending>;
  /** Closes it at relay shutdown. */
  shutdown(): void;
}

/** A client whose upgrade the relay holds until the connector's data socket arrives. */
interface Pending {
  id: string;
  name: string;
  client: string;
  key: string;
  token: string;
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  early: Buffer[];
  connector: Connector;
  created: number;
  timer?: NodeJS.Timeout;
  /** Takes the relay's listeners off the held socket. */
  detach(): void;
}

/** ws's own checks of a handshake, made before the relay holds an upgrade (ws's keyRegex). */
function handshakeOk(req: IncomingMessage): boolean {
  return (
    req.method === 'GET' &&
    String(req.headers.upgrade ?? '').toLowerCase() === 'websocket' &&
    /^[+/0-9A-Za-z]{22}==$/.test(String(req.headers['sec-websocket-key'] ?? '')) &&
    ['8', '13'].includes(String(req.headers['sec-websocket-version'] ?? ''))
  );
}

/**
 * Upgrades now, or undefined. ws calls back synchronously (no verifyClient), or not at all: it
 * destroys a socket that already ended, and answers a bad handshake itself.
 */
function upgradeNow(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): WebSocket | undefined {
  let got: WebSocket | undefined;
  wss.handleUpgrade(req, socket, head, (ws) => (got = ws));
  return got;
}

/** Answers an upgrade with an HTTP status, and closes the socket once that is out. */
function refuseSocket(socket: Duplex, status: number, headers: Record<string, string> = {}): void {
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  // Closed once the answer is out, as ws does: a client that keeps its side open can't hold
  // the socket. One that never reads is cut off after a while.
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nconnection: close\r\ncontent-length: 0\r\n${extra}\r\n`, () => socket.destroy());
  const linger = setTimeout(() => socket.destroy(), REFUSAL_LINGER_MS).unref();
  socket.once('close', () => clearTimeout(linger));
}

export function createRelay(config: RelayConfig, version: string, log: (e: LogEvent) => void = defaultLog): Relay {
  const pairing = (config.connectors ?? []).length > 0;
  const maxPerName = config.maxPerName ?? 32;
  const maxConnectorsPerName = config.maxConnectorsPerName ?? 2;
  const acceptTimeoutMs = config.acceptTimeoutMs ?? ACCEPT_TIMEOUT_MS;
  const pingSeconds = Math.max(1, Math.round(config.pingIntervalMs / 1000));

  const entries: TokenEntry[] = [
    ...config.tokens.map((t) => ({ digest: digest(t), name: tokenName(t), kind: 'v1' as const, names: ['*'] })),
    ...(config.clients ?? []).map((c) => ({ digest: digest(c.token), name: tokenName(c.token), kind: 'client' as const, names: c.names })),
    ...(config.connectors ?? []).map((c) => {
      let sources: BlockList | undefined;
      if (c.sources.length > 0) {
        sources = new BlockList();
        for (const r of c.sources) sources.addSubnet(r.address, r.prefix, r.family);
      }
      return { digest: digest(c.token), name: tokenName(c.token), kind: 'connector' as const, names: [], connector: c.name, sources };
    }),
  ];
  // loadConfig refuses this already; a config built elsewhere must not get round it.
  const kindOf = new Map<string, string>();
  for (const e of entries) {
    const hex = e.digest.toString('hex');
    if (kindOf.has(hex) && (e.kind !== 'v1' || kindOf.get(hex) !== 'v1')) throw new Error('A relay token appears twice: give each its own');
    kindOf.set(hex, e.kind);
  }
  /** The entry of the token that matches, or undefined. */
  const tokenOk = (given: string): TokenEntry | undefined => {
    const d = digest(given);
    // Compare with every token, always, so timing says nothing about which one matched.
    let match: TokenEntry | undefined;
    for (const e of entries) if (timingSafeEqual(d, e.digest)) match = e;
    return match;
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
  /** Whether a connector token may be used from this address. */
  const sourceOk = (entry: TokenEntry, address: string): boolean => {
    if (!entry.sources) return true;
    const a = address.replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
    const family = isIP(a);
    // An IPv4 range also matches the IPv4-mapped IPv6 form (::ffff:a.b.c.d), as for INTERNAL.
    return family !== 0 && entry.sources.check(a, family === 4 ? 'ipv4' : 'ipv6');
  };

  // Failed token checks per client key, at most maxFailureClients keys and maxFailures times each
  // (a client at the limit is refused before its token is checked). Expired entries are swept
  // every window. When the map is full, expired entries go first; still full (many addresses
  // at once), the oldest key goes. One map for every endpoint.
  const failures = new Map<string, number[]>();
  const maxFailureClients = config.maxFailureClients ?? MAX_FAILURE_CLIENTS;
  const sweepExpired = (now: number): void => {
    for (const key of [...failures.keys()]) failedRecently(key, now);
  };
  const recordFailure = (key: string, now: number): void => {
    if (!failures.has(key) && failures.size >= maxFailureClients) {
      sweepExpired(now);
      for (const oldest of failures.keys()) {
        if (failures.size < maxFailureClients) break;
        failures.delete(oldest);
      }
    }
    failures.set(key, [...(failures.get(key) ?? []), now]);
  };
  const failedRecently = (key: string, now: number): number => {
    const list = (failures.get(key) ?? []).filter((t) => now - t < config.failWindowMs);
    if (list.length > 0) failures.set(key, list);
    else failures.delete(key);
    return list.length;
  };
  // Node's timers take at most 2^31-1 ms; a window of 0 (no lockout) still sweeps once a second.
  const sweep = setInterval(() => sweepExpired(Date.now()), Math.min(Math.max(config.failWindowMs, 1000), 2 ** 31 - 1));
  sweep.unref();

  // Client sessions: open ones (both modes) and, in pairing mode, held upgrades. The caps count both.
  const sessions = new Set<Splice>();
  const pending = new Map<string, Pending>();
  const perClient = new Map<string, number>();
  const perName = new Map<string, number>();
  const inUse = (): number => sessions.size + pending.size;
  const add = (map: Map<string, number>, key: string, by: number): void => {
    const n = (map.get(key) ?? 0) + by;
    if (n > 0) map.set(key, n);
    else map.delete(key);
  };
  // Live control sockets per name, oldest first (new sessions go to the oldest).
  const connectors = new Map<string, Connector[]>();
  // Session ids that ended unpaired, by the token that may still ask for them (answered 410).
  const ended = new Map<string, { entry: TokenEntry; at: number }>();
  const remember = (id: string, entry: TokenEntry): void => {
    const now = Date.now();
    for (const [old, e] of ended) {
      if (ended.size < MAX_ENDED && now - e.at < ENDED_MS) break;
      ended.delete(old);
    }
    ended.set(id, { entry, at: now });
  };
  const short = (id: string): string => id.slice(0, 8);

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

  const info: RelayInfo = { name: 'md-runbook-relay', protocol: PROTOCOL, version, capabilities: pairing ? ['ssh', 'pair.v1'] : ['ssh'] };
  const corsOrigin = (origin: string | undefined): string | undefined =>
    config.origins.length === 0 ? '*' : origin && config.origins.includes(origin) ? origin : undefined;
  /**
   * The pairing endpoints' Origin rule: none (not a browser), the relay's own, or a listed one.
   * The relay's own is `https://` and the Host, and `http://` too for a local Host.
   */
  const pairOriginOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (config.origins.includes(origin)) return true;
    try {
      const own = new URL(`https://${req.headers.host ?? ''}`);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(own.hostname);
      const given = new URL(origin);
      return given.host === own.host && (given.protocol === 'https:' || (local && given.protocol === 'http:'));
    } catch {
      return false;
    }
  };

  // A request's URL, or undefined when it can't be read: `new URL` throws on such as `//[` or
  // `http://%/`, and a throw in a server handler would end the relay (review of the 2026-11-27 fixes).
  const urlOf = (raw: string | undefined): URL | undefined => {
    try {
      return new URL(raw ?? '/', 'http://relay');
    } catch {
      return undefined;
    }
  };

  const server = createServer((req, res) => {
    const path = urlOf(req.url)?.pathname;
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const allow = corsOrigin(req.headers.origin);
    if (allow) headers['access-control-allow-origin'] = allow;
    if (path === undefined) {
      res.writeHead(400, headers).end();
    } else if (req.method === 'GET' && path === '/v1/server-info') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(info));
    } else if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { ...headers, 'content-type': 'text/plain' }).end('ok');
    } else res.writeHead(404, headers).end();
  });

  const options = { noServer: true, perMessageDeflate: false, autoPong: true } as const;
  // Browsers and clients, both modes.
  const wss = new WebSocketServer({ ...options, maxPayload: MAX_FRAME, handleProtocols: (p) => (p.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });
  // Connectors: control sockets take small JSON only, data sockets SSH packets.
  const connectorProtocol = (p: Set<string>): string | false => (p.has(CONNECTOR_SUBPROTOCOL) ? CONNECTOR_SUBPROTOCOL : false);
  const controlWss = new WebSocketServer({ ...options, maxPayload: MAX_CONTROL_FRAME, handleProtocols: connectorProtocol });
  const dataWss = new WebSocketServer({ ...options, maxPayload: MAX_FRAME, handleProtocols: connectorProtocol });

  const endpoints: Record<string, 'ssh' | 'connect' | 'control' | 'accept'> = pairing
    ? { '/v1/ssh': 'ssh', '/v1/connect': 'connect', '/v1/connector': 'control', '/v1/connector/accept': 'accept' }
    : { '/v1/ssh': 'ssh' };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node removes its own 'error' listener on upgrade: without this one, a client that resets the
    // connection while being refused crashes the relay (threat-model review, 2026-11-27). As in the
    // ws README's "Client authentication" example.
    socket.on('error', destroySocket);
    const client = clientOf(req);
    const key = clientKey(client);
    const now = Date.now();
    const refuse = (status: number, why: string, more: LogFields = {}, headers?: Record<string, string>): void => {
      log({ event: 'refused', client, why, status, ...more });
      refuseSocket(socket, status, headers);
    };
    const url = urlOf(req.url);
    if (!url) return refuse(400, 'url');
    const endpoint = Object.hasOwn(endpoints, url.pathname) ? endpoints[url.pathname] : undefined;
    if (!endpoint) return refuse(404, 'path');
    if (failedRecently(key, now) >= config.maxFailures) return refuse(429, 'too many failed tokens');
    const origin = req.headers.origin;
    // /v1/ssh keeps its rule (any origin while RELAY_ORIGINS is empty); pairing's are stricter.
    if (endpoint === 'ssh' ? config.origins.length > 0 && !(origin && config.origins.includes(origin)) : !pairOriginOk(req))
      return refuse(403, `origin ${origin ?? '-'}`);
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim());
    const wanted = endpoint === 'ssh' || endpoint === 'connect' ? SUBPROTOCOL : CONNECTOR_SUBPROTOCOL;
    if (!offered.includes(wanted)) return refuse(400, 'protocol version');
    const given = offered.find((p) => p.startsWith('token.'))?.slice('token.'.length) ?? '';
    const entry = tokenOk(given);
    if (entry === undefined) {
      recordFailure(key, now);
      return refuse(401, 'token');
    }
    const kinds = endpoint === 'ssh' ? ['v1'] : endpoint === 'connect' ? ['v1', 'client'] : ['connector'];
    if (!kinds.includes(entry.kind)) {
      // A connector token where clients go, or the other way: a token in the wrong place counts as wrong.
      recordFailure(key, now);
      return refuse(401, `${entry.kind} token`, { token: entry.name });
    }
    const token = entry.name;
    if (endpoint === 'connect') return connectClient(req, socket, head, url, entry, client, key, refuse);
    if (endpoint === 'control' || endpoint === 'accept') {
      if (!sourceOk(entry, client)) return refuse(403, 'connector source', { token });
      if (!handshakeOk(req)) return refuse(400, 'handshake', { token });
      return endpoint === 'control' ? registerConnector(req, socket, head, url, entry, client, refuse) : acceptData(req, socket, head, url, entry, client, refuse);
    }

    const target = url.searchParams.get('target') ?? '';
    const allowed = targetOk(target);
    if (!allowed) return refuse(403, `target ${target}`, { token });
    const literal = target.slice(0, target.lastIndexOf(':')).replace(/^\[(.*)\]$/, '$1');
    if (allowed === 'any' && isIP(literal) && isInternal(literal)) return refuse(403, `target ${target} (internal address)`, { token });
    if (inUse() >= config.maxConnections) return refuse(429, 'relay full', { token });
    if ((perClient.get(key) ?? 0) >= config.maxPerClient) return refuse(429, 'client limit', { token });
    // ws puts its own 'error' listener on the socket from here on.
    socket.removeListener('error', destroySocket);
    wss.handleUpgrade(req, socket, head, (ws) => pipe(ws, client, key, token, target, allowed === 'any'));
  });

  function pipe(ws: WebSocket, client: string, key: string, token: string, target: string, publicOnly: boolean): void {
    const at = target.lastIndexOf(':');
    const host = target.slice(0, at).replace(/^\[(.*)\]$/, '$1');
    const started = Date.now();
    // Allowed only by `*:port`: a name that resolves to the relay's own or a private network is refused.
    const lookup: LookupFunction = (hostname, options, callback) =>
      dnsLookup(hostname, options, (err, address, family) => {
        const all = Array.isArray(address) ? address.map((a) => a.address) : [address];
        if (!err && all.some((a) => isInternal(a))) return callback(Object.assign(new Error('internal address'), { code: 'EINTERNAL' }), address, family);
        callback(err, address, family);
      });
    const tcp = connect({ host, port: Number(target.slice(at + 1)), timeout: config.connectTimeoutMs, ...(publicOnly ? { lookup } : {}) });
    add(perClient, key, 1);
    const session = splice(wsEnd(ws, CLIENT_LABELS, config.pingIntervalMs), tcpEnd(tcp), {
      maxSessionMs: config.maxSessionMs,
      onEnd: (why, up, down) => {
        sessions.delete(session);
        add(perClient, key, -1);
        log({ event: 'close', client, token, target, why, up, down, ms: Date.now() - started, open: sessions.size });
      },
    });
    sessions.add(session);
    log({ event: 'open', client, token, target, open: sessions.size });
  }

  type Refuse = (status: number, why: string, more?: LogFields, headers?: Record<string, string>) => void;

  /** /v1/connect: holds the client's upgrade and asks the name's oldest connector for a data socket. */
  function connectClient(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, entry: TokenEntry, client: string, key: string, refuse: Refuse): void {
    const token = entry.name;
    const name = url.searchParams.get('name') ?? '';
    const shown = name.slice(0, 64);
    if (!entry.names.includes('*') && !entry.names.includes(name)) return refuse(403, `name ${shown}`, { token });
    if (!NAME.test(name)) return refuse(400, 'name', { token });
    if (!handshakeOk(req)) return refuse(400, 'handshake', { token });
    if (inUse() >= config.maxConnections) return refuse(429, 'relay full', { token, name });
    if ((perClient.get(key) ?? 0) >= config.maxPerClient) return refuse(429, 'client limit', { token, name });
    if ((perName.get(name) ?? 0) >= maxPerName) return refuse(429, 'name limit', { token, name });
    const connector = connectors.get(name)?.find((c) => c.ws.readyState === WebSocket.OPEN);
    if (!connector) return refuse(503, 'no connector', { token, name });

    const id = randomBytes(16).toString('base64url');
    let early = 0;
    const onData = (b: Buffer): void => {
      early += b.length;
      p.early.push(b);
      if (early > MAX_EARLY_BYTES) socket.destroy();
    };
    const onGone = (): void => left(p);
    const p: Pending = {
      id,
      name,
      client,
      key,
      token,
      req,
      socket,
      head,
      early: [],
      connector,
      created: Date.now(),
      detach: () => {
        socket.off('data', onData);
        socket.off('end', onGone);
        socket.off('close', onGone);
      },
    };
    // Read while held, so a client that leaves is seen at once ('end', 'close').
    socket.on('data', onData);
    socket.on('end', onGone);
    socket.on('close', onGone);
    socket.resume();
    pending.set(id, p);
    connector.waiting.add(p);
    add(perClient, key, 1);
    add(perName, name, 1);
    p.timer = setTimeout(() => fail(p, 504, 'accept timeout'), acceptTimeoutMs);
    p.timer.unref();
    connector.ws.send(JSON.stringify({ t: 'session', id, client }));
  }

  /** Takes a held client off the waiting list; `release`: its place in the caps goes too. */
  const unhold = (p: Pending, release: boolean): void => {
    clearTimeout(p.timer);
    pending.delete(p.id);
    p.connector.waiting.delete(p);
    p.detach();
    if (release) {
      add(perClient, p.key, -1);
      add(perName, p.name, -1);
      remember(p.id, p.connector.entry);
    }
  };
  /** A held client gets an HTTP refusal (503, 504). */
  const fail = (p: Pending, status: number, why: string): void => {
    if (!pending.has(p.id)) return;
    unhold(p, true);
    log({ event: 'refused', mode: 'pair', client: p.client, why, status, token: p.token, name: p.name, session: short(p.id) });
    refuseSocket(p.socket, status);
  };
  /** A held client went before its connector answered. */
  const left = (p: Pending): void => {
    if (!pending.has(p.id)) return;
    unhold(p, true);
    p.socket.destroy();
    log({ event: 'left', mode: 'pair', client: p.client, token: p.token, name: p.name, session: short(p.id), ms: Date.now() - p.created });
  };

  /** /v1/connector: a connector's control socket. */
  function registerConnector(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, entry: TokenEntry, address: string, refuse: Refuse): void {
    const token = entry.name;
    const name = url.searchParams.get('name') ?? '';
    if (name !== entry.connector) return refuse(403, `name ${name.slice(0, 64)}`, { token });
    const list = connectors.get(name) ?? [];
    // Per name, not per address: a cluster's connectors may share one. A stale socket goes after
    // a missed pong, so try again after two pings.
    if (list.length >= maxConnectorsPerName) return refuse(429, 'connector limit', { token, name }, { 'retry-after': String(2 * pingSeconds) });
    socket.removeListener('error', destroySocket);
    const ws = upgradeNow(controlWss, req, socket, head);
    if (!ws) return;

    const since = Date.now();
    let down = false;
    let alive = true;
    const c: Connector = { ws, name, entry, address, waiting: new Set(), shutdown: () => gone('relay stopping', () => closeSoon(ws, 1001)) };
    const gone = (why: string, end: () => void): void => {
      if (down) return;
      down = true;
      clearInterval(ping);
      end();
      const now = connectors.get(name) ?? [];
      const rest = now.filter((x) => x !== c);
      if (rest.length > 0) connectors.set(name, rest);
      else connectors.delete(name);
      for (const p of [...c.waiting]) fail(p, 503, 'connector gone');
      log({ event: 'connector-down', name, token, connector: address, why, ms: Date.now() - since, connectors: rest.length });
    };
    if (list.length > 0) log({ event: 'connector-duplicate', name, token, connector: address, other: list.map((x) => x.address).join(',') });
    connectors.set(name, [...list, c]);
    log({ event: 'connector-up', name, token, connector: address, connectors: list.length + 1 });

    // 1008 (policy violation, RFC 6455 section 7.4.1): not what the protocol allows.
    const violation = (why: string): void => gone(why, () => closeSoon(ws, 1008, why));
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return violation('binary frame');
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return violation('bad message');
      }
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || typeof (msg as { t?: unknown }).t !== 'string') return violation('bad message');
      const m = msg as { t: string; id?: unknown; why?: unknown };
      // Unknown types are ignored: new messages need no new protocol version.
      if (m.t !== 'refuse') return;
      const p = pending.get(String(m.id));
      // Only the connector the session went to may refuse it.
      if (p && p.connector === c) fail(p, 503, `connector refused ${m.why === 'busy' || m.why === 'sshd' ? m.why : 'other'}`);
    });
    ws.on('close', () => gone('closed', () => undefined));
    ws.on('error', (e: Error & { code?: string }) => gone(`error ${e.code ?? e.message}`, () => undefined));
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return gone('no pong', () => ws.terminate());
      alive = false;
      ws.ping();
    }, config.pingIntervalMs);
    ping.unref();
    ws.send(JSON.stringify({ t: 'hello', relay: config.relayId ?? 'relay', ping: pingSeconds }));
  }

  /** /v1/connector/accept: a connector's data socket for one held client. */
  function acceptData(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL, entry: TokenEntry, address: string, refuse: Refuse): void {
    const token = entry.name;
    const id = url.searchParams.get('id') ?? '';
    const p = pending.get(id);
    // Bound to the token of the control socket the session went to: another token, even of the
    // same name, gets 404 and the id stays usable.
    if (!p || p.connector.entry !== entry) {
      if (!p && ended.get(id)?.entry === entry) return refuse(410, 'client left', { token, session: short(id) });
      return refuse(404, 'session', { token });
    }
    unhold(p, false);
    const release = (): void => {
      add(perClient, p.key, -1);
      add(perName, p.name, -1);
    };
    const client = p.socket;
    if (client.destroyed || !client.readable || !client.writable) {
      release();
      client.destroy();
      log({ event: 'left', mode: 'pair', client: p.client, token: p.token, name: p.name, session: short(p.id), ms: Date.now() - p.created });
      return refuse(410, 'client left', { token, session: short(id) });
    }
    client.removeListener('error', destroySocket);
    const cws = upgradeNow(wss, p.req, client, Buffer.concat([p.head, ...p.early]));
    if (!cws) {
      release();
      return refuse(410, 'client left', { token, session: short(id) });
    }
    socket.removeListener('error', destroySocket);
    const dws = upgradeNow(dataWss, req, socket, head);
    if (!dws) {
      release();
      closeSoon(cws, 1011);
      log({ event: 'refused', mode: 'pair', client: p.client, why: 'data socket', token: p.token, name: p.name, session: short(p.id) });
      return;
    }
    pair(cws, dws, p, address);
  }

  function pair(cws: WebSocket, dws: WebSocket, p: Pending, connector: string): void {
    const started = Date.now();
    const at = { client: p.client, token: p.token, name: p.name, session: short(p.id), connector };
    const session = splice(wsEnd(cws, CLIENT_LABELS, config.pingIntervalMs), wsEnd(dws, CONNECTOR_LABELS, config.pingIntervalMs), {
      maxSessionMs: config.maxSessionMs,
      onEnd: (why, up, down) => {
        sessions.delete(session);
        add(perClient, p.key, -1);
        add(perName, p.name, -1);
        log({ event: 'close', mode: 'pair', ...at, why, up, down, ms: Date.now() - started, open: sessions.size });
      },
    });
    sessions.add(session);
    log({ event: 'open', mode: 'pair', ...at, wait: started - p.created, open: sessions.size });
  }

  return {
    server,
    open: () => sessions.size,
    waiting: () => pending.size,
    connectors: () => [...connectors.values()].reduce((n, l) => n + l.length, 0),
    buffered: () => [...sessions].reduce((n, s) => n + s.buffered(), 0),
    moved: () => [...sessions].reduce((n, s) => n + s.moved(), 0),
    failureClients: () => failures.size,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        for (const session of sessions) session.stop('shutdown');
        for (const p of [...pending.values()]) fail(p, 503, 'relay stopping');
        for (const list of [...connectors.values()]) for (const c of list) c.shutdown();
        wss.close();
        controlWss.close();
        dataWss.close();
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

/**
 * The relay's settings, from environment variables (see README.md). Invalid settings stop the
 * relay at start: a relay with no token or no allowlist must never run.
 */
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { hostname } from 'node:os';

/** A source range a connector may register from. */
export interface SourceRange {
  address: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

/** A line of RELAY_CONNECTORS_FILE: the token registers this name only, from these ranges. */
export interface ConnectorEntry {
  name: string;
  token: string;
  /** Empty: any source address. */
  sources: readonly SourceRange[];
}

/** A line of RELAY_CLIENTS_FILE: the token reaches these names; `['*']`: every name. */
export interface ClientEntry {
  token: string;
  names: readonly string[];
}

export interface RelayConfig {
  host: string;
  port: number;
  /**
   * v1 tokens (one per client or team; any of them opens a connection). In pairing mode they
   * are client tokens for every name too.
   */
  tokens: readonly string[];
  /** `host:port` pairs the relay may connect to; `*` as host allows any host on that port. */
  targets: readonly string[];
  /** Page origins allowed to connect; empty: any origin (the token still applies). */
  origins: readonly string[];
  maxConnections: number;
  maxPerClient: number;
  /** Failed token checks one client address may make per `failWindowMs` before it is refused. */
  maxFailures: number;
  failWindowMs: number;
  /** Use the last X-Forwarded-For address as the client (behind your own reverse proxy only). */
  trustProxy: boolean;
  connectTimeoutMs: number;
  pingIntervalMs: number;
  /** A session is closed after this long, however busy (threat-model review, 2026-11-27). */
  maxSessionMs: number;
  /** Client addresses whose failed token checks are remembered; the oldest go first. */
  maxFailureClients?: number;
  /** Pairing mode (docs/design/relay-pairing.md): on when there is a connector. */
  connectors?: readonly ConnectorEntry[];
  clients?: readonly ClientEntry[];
  /** Client sessions per connector name, waiting ones included. */
  maxPerName?: number;
  /** Live control connections per connector name. */
  maxConnectorsPerName?: number;
  /** The relay's name in its hello to connectors. */
  relayId?: string;
  /** How long a client waits for the connector's data socket (tests shorten it). */
  acceptTimeoutMs?: number;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * A whole number from `min` to `max`. Refused only where the value broke the relay: a ping every
 * 0 s closes every session at once, a cap of 0 refuses everyone, and a timer over 2^31-1 ms
 * fires after 1 ms. Values that worked before still do.
 */
function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  const range = max === Number.MAX_SAFE_INTEGER ? `of at least ${min}` : `from ${min} to ${max}`;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number ${range}, got ${JSON.stringify(v)}`);
  return n;
}

/** Node's timers take at most 2^31-1 ms (24.8 days); a longer one fires after 1 ms. */
const MAX_TIMER_SECONDS = Math.floor((2 ** 31 - 1) / 1000); // 2147483

/** `host:port` with a port from 1 to 65535; IPv6 hosts in brackets (`[::1]:22`). */
export function isTargetSpec(t: string): boolean {
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.*-]+):(\d{1,5})$/.exec(t);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 65535 && (m[1] === '*' || !m[1]!.includes('*'));
}

/** RFC 7230 token characters: what a WebSocket subprotocol, and so a relay token, may hold. */
const TOKEN_CHARS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** A connector's name: what `/v1/connect?name=` and `/v1/connector?name=` take. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Connector tokens start with this, and no other token may: a token in the wrong place shows. */
export const CONNECTOR_PREFIX = 'mdrbc-';

/** Why a token can't be used, or undefined. Never says the token itself. */
function tokenProblem(t: string): string | undefined {
  if (t.length < 24) return 'must be at least 24 characters (e.g. `openssl rand -hex 32`)';
  // A browser sends the token as a WebSocket subprotocol (`token.<token>`), which allows only
  // RFC 7230 token characters: `new WebSocket` throws on base64's `/` and `=`, so refuse them here.
  if (!TOKEN_CHARS.test(t))
    return "may hold only letters, digits and !#$%&'*+-.^_`|~ (a browser sends it in a header): make one with `openssl rand -hex 32`";
  return undefined;
}

/** `address/prefix` or a bare address (one host). */
export function parseRange(s: string): SourceRange | undefined {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(s);
  if (!m) return undefined;
  const fam = isIP(m[1]!);
  if (fam === 0) return undefined;
  const max = fam === 4 ? 32 : 128;
  const prefix = m[2] === undefined ? max : Number(m[2]);
  if (prefix > max) return undefined;
  return { address: m[1]!, prefix, family: fam === 4 ? 'ipv4' : 'ipv6' };
}

/** The lines of a file that count: not empty, not a `#` comment. With their line numbers. */
function lines(path: string): { n: number; fields: string[] }[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l, i) => ({ n: i + 1, fields: l.trim().split(/\s+/).filter(Boolean) }))
    .filter((l) => l.fields.length > 0 && !l.fields[0]!.startsWith('#'));
}

function readConnectors(path: string): ConnectorEntry[] {
  return lines(path).map(({ n, fields }) => {
    const at = `RELAY_CONNECTORS_FILE line ${n}`;
    if (fields.length < 2 || fields.length > 3) throw new Error(`${at}: expected \`name token [ranges]\``);
    const [name, token, ranges] = fields as [string, string, string | undefined];
    if (!NAME.test(name)) throw new Error(`${at}: ${JSON.stringify(name)} is not a name (a-z, 0-9 and -, up to 63, not starting with -)`);
    const problem = tokenProblem(token);
    if (problem) throw new Error(`${at}: the token ${problem}`);
    if (!token.startsWith(CONNECTOR_PREFIX)) throw new Error(`${at}: a connector token must start with ${CONNECTOR_PREFIX}`);
    const sources = list(ranges).map((r) => {
      const range = parseRange(r);
      if (!range) throw new Error(`${at}: ${JSON.stringify(r)} is not an address or a range such as 203.0.113.0/24`);
      return range;
    });
    return { name, token, sources };
  });
}

function readClients(path: string): ClientEntry[] {
  return lines(path).map(({ n, fields }) => {
    const at = `RELAY_CLIENTS_FILE line ${n}`;
    if (fields.length !== 2) throw new Error(`${at}: expected \`token names\` (names comma-separated, or *)`);
    const [token, names] = fields as [string, string];
    const problem = tokenProblem(token);
    if (problem) throw new Error(`${at}: the token ${problem}`);
    if (token.startsWith(CONNECTOR_PREFIX)) throw new Error(`${at}: a client token must not start with ${CONNECTOR_PREFIX} (that is a connector's)`);
    const all = list(names);
    if (!(all.length === 1 && all[0] === '*')) {
      const bad = all.find((x) => !NAME.test(x));
      if (bad !== undefined || all.length === 0) throw new Error(`${at}: ${JSON.stringify(bad ?? names)} is not a name, nor *`);
    }
    return { token, names: all };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const tokens = [...list(env.RELAY_TOKENS), ...(env.RELAY_TOKEN ? [env.RELAY_TOKEN] : [])];
  if (env.RELAY_TOKEN_FILE) tokens.push(...list(readFileSync(env.RELAY_TOKEN_FILE, 'utf8').replace(/\s+/g, ',')));
  const connectors = env.RELAY_CONNECTORS_FILE ? readConnectors(env.RELAY_CONNECTORS_FILE) : [];
  const clients = env.RELAY_CLIENTS_FILE ? readClients(env.RELAY_CLIENTS_FILE) : [];
  if (env.RELAY_CONNECTORS_FILE && connectors.length === 0) throw new Error('RELAY_CONNECTORS_FILE names no connector');
  if (env.RELAY_CLIENTS_FILE && connectors.length === 0) throw new Error('RELAY_CLIENTS_FILE needs RELAY_CONNECTORS_FILE: client tokens open /v1/connect only');

  if (tokens.length === 0 && clients.length === 0)
    throw new Error('Set RELAY_TOKEN (or RELAY_TOKENS / RELAY_TOKEN_FILE, or RELAY_CLIENTS_FILE): the relay never runs without a token');
  for (const t of tokens) {
    const problem = tokenProblem(t);
    if (problem) throw new Error(`Each relay token ${problem}`);
    if (t.startsWith(CONNECTOR_PREFIX)) throw new Error(`RELAY_TOKEN, RELAY_TOKENS, RELAY_TOKEN_FILE: a token starting with ${CONNECTOR_PREFIX} is a connector's (RELAY_CONNECTORS_FILE)`);
  }
  // One token, one meaning: a token in two places would open more than either says. Repeats
  // among the v1 variables mean the same and worked before, so they still do.
  const seen = new Map<string, string>();
  const place = (t: string, where: string): void => {
    const before = seen.get(t);
    if (before !== undefined) throw new Error(`The same token is in ${before} and ${where}: give each its own (\`openssl rand -hex 32\`)`);
    seen.set(t, where);
  };
  for (const t of new Set(tokens)) place(t, 'RELAY_TOKEN/RELAY_TOKENS/RELAY_TOKEN_FILE');
  clients.forEach((c, i) => place(c.token, `RELAY_CLIENTS_FILE (entry ${i + 1})`));
  connectors.forEach((c, i) => place(c.token, `RELAY_CONNECTORS_FILE (entry ${i + 1})`));

  const targets = list(env.RELAY_TARGETS);
  if (targets.length === 0 && connectors.length === 0)
    throw new Error('Set RELAY_TARGETS to the host:port pairs the relay may reach (e.g. web1.example.net:22), or RELAY_CONNECTORS_FILE for pairing mode');
  const bad = targets.find((t) => !isTargetSpec(t));
  if (bad !== undefined) throw new Error(`RELAY_TARGETS: ${JSON.stringify(bad)} is not host:port`);
  if (targets.length > 0 && tokens.length === 0) throw new Error('RELAY_TARGETS needs RELAY_TOKEN (or RELAY_TOKENS / RELAY_TOKEN_FILE): client tokens open /v1/connect only');

  return {
    host: env.RELAY_HOST ?? '127.0.0.1',
    // 0: a port the system picks.
    port: num(env, 'RELAY_PORT', 8022, 0, 65535),
    tokens,
    targets,
    origins: list(env.RELAY_ORIGINS),
    maxConnections: num(env, 'RELAY_MAX_CONNECTIONS', 50),
    maxPerClient: num(env, 'RELAY_MAX_PER_CLIENT', 8),
    maxFailures: num(env, 'RELAY_MAX_FAILURES', 10),
    // 0: failed checks are never counted. No upper bound: the sweep timer is clamped (relay.ts).
    failWindowMs: num(env, 'RELAY_FAIL_WINDOW_SECONDS', 600, 0) * 1000,
    trustProxy: env.RELAY_TRUST_PROXY === '1' || env.RELAY_TRUST_PROXY === 'true',
    // 0: no timeout of the relay's own (the system's connect timeout applies).
    connectTimeoutMs: num(env, 'RELAY_CONNECT_TIMEOUT_SECONDS', 10, 0, MAX_TIMER_SECONDS) * 1000,
    pingIntervalMs: num(env, 'RELAY_PING_SECONDS', 30, 1, MAX_TIMER_SECONDS) * 1000,
    maxSessionMs: num(env, 'RELAY_MAX_SESSION_SECONDS', 24 * 3600, 60, MAX_TIMER_SECONDS) * 1000,
    connectors,
    clients,
    maxPerName: num(env, 'RELAY_MAX_PER_NAME', 32),
    maxConnectorsPerName: num(env, 'RELAY_MAX_CONNECTORS_PER_NAME', 2),
    relayId: env.RELAY_ID || hostname(),
  };
}

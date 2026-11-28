/**
 * The relay's settings, from environment variables (see README.md). Invalid settings stop the
 * relay at start: a relay with no token or no allowlist must never run.
 */
import { readFileSync } from 'node:fs';

export interface RelayConfig {
  host: string;
  port: number;
  /** Accepted tokens (one per client or team; any of them opens a connection). */
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const tokens = [...list(env.RELAY_TOKENS), ...(env.RELAY_TOKEN ? [env.RELAY_TOKEN] : [])];
  if (env.RELAY_TOKEN_FILE) tokens.push(...list(readFileSync(env.RELAY_TOKEN_FILE, 'utf8').replace(/\s+/g, ',')));
  if (tokens.length === 0) throw new Error('Set RELAY_TOKEN (or RELAY_TOKENS / RELAY_TOKEN_FILE): the relay never runs without a token');
  const short = tokens.find((t) => t.length < 24);
  if (short !== undefined) throw new Error('Each relay token must be at least 24 characters (e.g. `openssl rand -hex 32`)');
  // A browser sends the token as a WebSocket subprotocol (`token.<token>`), which allows only
  // RFC 7230 token characters: `new WebSocket` throws on base64's `/` and `=`, so refuse them here.
  if (tokens.some((t) => !TOKEN_CHARS.test(t)))
    throw new Error("A relay token may hold only letters, digits and !#$%&'*+-.^_`|~ (a browser sends it in a header): make one with `openssl rand -hex 32`");

  const targets = list(env.RELAY_TARGETS);
  if (targets.length === 0) throw new Error('Set RELAY_TARGETS to the host:port pairs the relay may reach (e.g. web1.example.net:22)');
  const bad = targets.find((t) => !isTargetSpec(t));
  if (bad !== undefined) throw new Error(`RELAY_TARGETS: ${JSON.stringify(bad)} is not host:port`);

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
  };
}

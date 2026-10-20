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
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${JSON.stringify(v)}`);
  return n;
}

/** `host:port` with a port from 1 to 65535; IPv6 hosts in brackets (`[::1]:22`). */
export function isTargetSpec(t: string): boolean {
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.*-]+):(\d{1,5})$/.exec(t);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 65535 && (m[1] === '*' || !m[1]!.includes('*'));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const tokens = [...list(env.RELAY_TOKENS), ...(env.RELAY_TOKEN ? [env.RELAY_TOKEN] : [])];
  if (env.RELAY_TOKEN_FILE) tokens.push(...list(readFileSync(env.RELAY_TOKEN_FILE, 'utf8').replace(/\s+/g, ',')));
  if (tokens.length === 0) throw new Error('Set RELAY_TOKEN (or RELAY_TOKENS / RELAY_TOKEN_FILE): the relay never runs without a token');
  const short = tokens.find((t) => t.length < 24);
  if (short !== undefined) throw new Error('Each relay token must be at least 24 characters (e.g. `openssl rand -base64 32`)');

  const targets = list(env.RELAY_TARGETS);
  if (targets.length === 0) throw new Error('Set RELAY_TARGETS to the host:port pairs the relay may reach (e.g. web1.example.net:22)');
  const bad = targets.find((t) => !isTargetSpec(t));
  if (bad !== undefined) throw new Error(`RELAY_TARGETS: ${JSON.stringify(bad)} is not host:port`);

  return {
    host: env.RELAY_HOST ?? '127.0.0.1',
    port: num(env, 'RELAY_PORT', 8022),
    tokens,
    targets,
    origins: list(env.RELAY_ORIGINS),
    maxConnections: num(env, 'RELAY_MAX_CONNECTIONS', 50),
    maxPerClient: num(env, 'RELAY_MAX_PER_CLIENT', 8),
    maxFailures: num(env, 'RELAY_MAX_FAILURES', 10),
    failWindowMs: num(env, 'RELAY_FAIL_WINDOW_SECONDS', 600) * 1000,
    trustProxy: env.RELAY_TRUST_PROXY === '1' || env.RELAY_TRUST_PROXY === 'true',
    connectTimeoutMs: num(env, 'RELAY_CONNECT_TIMEOUT_SECONDS', 10) * 1000,
    pingIntervalMs: num(env, 'RELAY_PING_SECONDS', 30) * 1000,
  };
}

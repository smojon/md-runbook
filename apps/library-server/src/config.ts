/**
 * The server's settings, from environment variables (see README.md). Invalid settings stop it at
 * start: a library that takes uploads must never run without a token or the signers it checks.
 * Each part is on when its main setting is there: the library with LIBRARY_DIR, run summaries
 * with RUNS_DIR, alerts with ALERT_MAP.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** A token the server accepts, and the name it is logged by (never the token). */
export interface Token {
  label: string;
  value: string;
}

export interface LibraryConfig {
  /** The folder the web container serves read-only at /runbooks/. */
  dir: string;
  uploadTokens: readonly Token[];
  /** OpenSSH allowed_signers (namespace md-runbook): only runbooks signed by one of these are published. */
  allowedSigners: string;
  /** Accept manifest version 1 (only the bash blocks signed). Off: the whole runbook must be signed. */
  acceptV1: boolean;
  allowDelete: boolean;
  /** index.json's signedOnly: the app then opens only verified runbooks of this library. */
  signedOnly: boolean;
  maxBytes: number;
}

export interface RunsConfig {
  dir: string;
  /** Tokens clients send (`report-runs-token`); none: anyone who reaches the server may post. */
  tokens: readonly Token[];
  /** Tokens of md-runbook-gate (report_token_file): a summary with client "gate" needs one when set. */
  gateTokens: readonly Token[];
  readTokens: readonly Token[];
  /** OpenSSH allowed_signers of the runners' keys (namespace md-runbook-run). */
  allowedRunners?: string;
  /** Refuse summaries that are neither signed by a known runner nor sent with a gate token. */
  requireSigned: boolean;
  maxBytes: number;
}

export interface AlertsConfig {
  /** The alert map (JSON): alertname and matchers to a library runbook and its parameters. */
  map: string;
  dir: string;
  tokens: readonly Token[];
  readTokens: readonly Token[];
  /** The web app's public address (https://runbooks.example.net): links are `<publicUrl>/open?…`. */
  publicUrl: string;
  /** Where the web app serves the library on that address (MD_RUNBOOK_LIBRARY of the web container). */
  libraryPath: string;
  /** The library folder (LIBRARY_DIR), read for each link's sha256; without it links carry no hash. */
  libraryDir?: string;
  maxBytes: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Library state (the highest version published per path). */
  stateDir: string;
  library?: LibraryConfig;
  runs?: RunsConfig;
  alerts?: AlertsConfig;
  /** Page origins allowed to read answers in a browser (CORS); empty: none (same origin only). */
  origins: readonly string[];
  /** Use the last X-Forwarded-For address as the client (behind your own reverse proxy only). */
  trustProxy: boolean;
  /** Requests one client address may make per minute (POST and GET to /v1/). */
  ratePerMinute: number;
  /** Failed token checks one client address may make per `failWindowMs` before it is refused. */
  maxFailures: number;
  failWindowMs: number;
  sshKeygen: string;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${JSON.stringify(v)}`);
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(v)}`);
}

const LABEL_RE = /^([A-Za-z0-9._@-]{1,64}):(.+)$/;

/**
 * Tokens from NAME (comma- or space-separated) and NAME_FILE (one per line, for Docker secrets).
 * `label:token` names a token in the log (`alice:3f9a…`); otherwise it is logged by a short hash.
 */
export function readTokens(env: NodeJS.ProcessEnv, name: string): Token[] {
  const raw = [...list(env[name])];
  const file = env[`${name}_FILE`];
  if (file) raw.push(...list(readFileSync(file, 'utf8')));
  return raw.map((entry) => {
    const m = LABEL_RE.exec(entry);
    const value = m ? m[2]! : entry;
    if (value.length < 24) throw new Error(`${name}: each token must be at least 24 characters (e.g. \`openssl rand -hex 32\`)`);
    const label = m ? m[1]! : `token-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
    return { label, value };
  });
}

function existingFile(name: string, path: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${name}: no file ${path}`);
  return path;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const stateDir = resolve(env.STATE_DIR || 'data');
  const sshKeygen = env.SSH_KEYGEN || 'ssh-keygen';

  let library: LibraryConfig | undefined;
  if (env.LIBRARY_DIR) {
    const dir = resolve(env.LIBRARY_DIR);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`LIBRARY_DIR: no folder ${dir}`);
    const uploadTokens = readTokens(env, 'LIBRARY_UPLOAD_TOKENS');
    if (uploadTokens.length === 0) throw new Error('Set LIBRARY_UPLOAD_TOKENS (or LIBRARY_UPLOAD_TOKENS_FILE): the library never takes uploads without a token');
    const signers = env.LIBRARY_ALLOWED_SIGNERS || join(dir, 'allowed_signers');
    library = {
      dir,
      uploadTokens,
      allowedSigners: existingFile('LIBRARY_ALLOWED_SIGNERS (the signers whose runbooks are published)', isAbsolute(signers) ? signers : resolve(signers)),
      acceptV1: bool(env, 'LIBRARY_ACCEPT_V1', false),
      allowDelete: bool(env, 'LIBRARY_ALLOW_DELETE', false),
      signedOnly: bool(env, 'LIBRARY_SIGNED_ONLY', true),
      maxBytes: num(env, 'LIBRARY_MAX_BYTES', 512 * 1024),
    };
  } else if (env.LIBRARY_UPLOAD_TOKENS || env.LIBRARY_UPLOAD_TOKENS_FILE) throw new Error('LIBRARY_UPLOAD_TOKENS is set but LIBRARY_DIR is not: set the folder the web app serves');

  let runs: RunsConfig | undefined;
  if (env.RUNS_DIR) {
    runs = {
      dir: resolve(env.RUNS_DIR),
      tokens: readTokens(env, 'RUNS_TOKENS'),
      gateTokens: readTokens(env, 'RUNS_GATE_TOKENS'),
      readTokens: readTokens(env, 'RUNS_READ_TOKENS'),
      ...(env.RUNS_ALLOWED_RUNNERS ? { allowedRunners: existingFile('RUNS_ALLOWED_RUNNERS', resolve(env.RUNS_ALLOWED_RUNNERS)) } : {}),
      requireSigned: bool(env, 'RUNS_REQUIRE_SIGNED', false),
      maxBytes: num(env, 'RUNS_MAX_BYTES', 64 * 1024),
    };
    if (runs.requireSigned && !runs.allowedRunners && runs.gateTokens.length === 0)
      throw new Error('RUNS_REQUIRE_SIGNED=true needs RUNS_ALLOWED_RUNNERS (runner keys) or RUNS_GATE_TOKENS (gates): otherwise every summary is refused');
  }

  let alerts: AlertsConfig | undefined;
  if (env.ALERT_MAP) {
    const publicUrl = (env.PUBLIC_URL ?? '').replace(/\/+$/, '');
    let u: URL;
    try {
      u = new URL(publicUrl);
    } catch {
      throw new Error('ALERT_MAP needs PUBLIC_URL: the web app\'s public address (https://runbooks.example.net), what the links open');
    }
    if (u.protocol !== 'https:' || u.search || u.hash || u.username) throw new Error('PUBLIC_URL must be an https address, without query or user name');
    const libraryPath = `/${(env.LIBRARY_PUBLIC_PATH || '/runbooks/').replace(/^\/+|\/+$/g, '')}/`;
    alerts = {
      map: existingFile('ALERT_MAP', resolve(env.ALERT_MAP)),
      dir: resolve(env.ALERTS_DIR || join(stateDir, 'alerts')),
      tokens: readTokens(env, 'ALERTS_TOKENS'),
      readTokens: env.ALERTS_READ_TOKENS || env.ALERTS_READ_TOKENS_FILE ? readTokens(env, 'ALERTS_READ_TOKENS') : readTokens(env, 'RUNS_READ_TOKENS'),
      publicUrl,
      libraryPath: libraryPath === '//' ? '/' : libraryPath,
      ...(env.LIBRARY_DIR ? { libraryDir: resolve(env.LIBRARY_DIR) } : {}),
      maxBytes: num(env, 'ALERTS_MAX_BYTES', 1024 * 1024),
    };
  }

  if (!library && !runs && !alerts) throw new Error('Nothing to serve: set LIBRARY_DIR (publishing), RUNS_DIR (run summaries) and/or ALERT_MAP (alerts)');

  return {
    host: env.SERVER_HOST ?? '127.0.0.1',
    port: num(env, 'SERVER_PORT', 8090),
    stateDir,
    ...(library ? { library } : {}),
    ...(runs ? { runs } : {}),
    ...(alerts ? { alerts } : {}),
    origins: list(env.CORS_ORIGINS),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    ratePerMinute: num(env, 'RATE_PER_MINUTE', 120),
    maxFailures: num(env, 'MAX_FAILURES', 10),
    failWindowMs: num(env, 'FAIL_WINDOW_SECONDS', 600) * 1000,
    sshKeygen,
  };
}

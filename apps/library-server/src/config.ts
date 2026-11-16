/**
 * The server's settings, from environment variables (see README.md). Invalid settings stop it at
 * start: a library that takes uploads must never run without a token or the signers it checks.
 * Each part is on when its main setting is there: the library with LIBRARY_DIR, run summaries
 * with RUNS_DIR, alerts with ALERT_MAP, and pushes of those alerts with PUSH_FCM_SERVICE_ACCOUNT_FILE
 * and/or PUSH_APNS_KEY_FILE.
 */
import { KeyObject, createHash, createPrivateKey } from 'node:crypto';
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

/** Firebase Cloud Messaging (HTTP v1): a service account of the Firebase project. */
export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** The service account's RSA key (PEM), which signs the OAuth2 assertion (RS256). */
  privateKey: string;
  /** Where the assertion is exchanged for an access token (the file's token_uri). */
  tokenUri: string;
}

/** Apple Push Notification service, token-based: a .p8 key of the developer account. */
export interface ApnsConfig {
  /** The .p8 key (PEM, EC P-256), which signs the provider token (ES256). */
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle ID. */
  topic: string;
  /** Development builds (Xcode, a debug build): api.sandbox.push.apple.com. */
  sandbox: boolean;
}

/** Firing alerts pushed to the phones that registered for them (POST /v1/devices). */
export interface PushConfig {
  /** The registered devices (JSON, written atomically, mode 600). */
  file: string;
  /** Tokens a phone registers with (DEVICES_TOKENS; default: the alerts' read tokens). */
  tokens: readonly Token[];
  fcm?: FcmConfig;
  apns?: ApnsConfig;
  maxDevices: number;
  /** Most devices one devices token may register (PUSH_MAX_DEVICES_PER_TOKEN). */
  maxDevicesPerToken: number;
  /** The same alert (fingerprint) is pushed again only after this long. */
  repeatMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Library state (the highest version published per path). */
  stateDir: string;
  library?: LibraryConfig;
  runs?: RunsConfig;
  alerts?: AlertsConfig;
  push?: PushConfig;
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

/** A Firebase service account key file (JSON), as the Firebase console downloads it. */
export function parseServiceAccount(json: string, where = 'PUSH_FCM_SERVICE_ACCOUNT_FILE'): FcmConfig {
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch {
    throw new Error(`${where}: not JSON (the service account key file from the Firebase console)`);
  }
  const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
  if (o.type !== 'service_account') throw new Error(`${where}: not a service account key ("type": "service_account")`);
  for (const k of ['project_id', 'client_email', 'private_key'] as const) if (typeof o[k] !== 'string' || o[k] === '') throw new Error(`${where}: no ${k}`);
  const tokenUri = typeof o.token_uri === 'string' ? o.token_uri : 'https://oauth2.googleapis.com/token';
  if (!tokenUri.startsWith('https://')) throw new Error(`${where}: token_uri must be an https address`);
  let key: KeyObject;
  try {
    key = createPrivateKey(o.private_key as string);
  } catch {
    throw new Error(`${where}: private_key is not a private key`);
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`${where}: private_key is not an RSA key`);
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(o.project_id as string)) throw new Error(`${where}: project_id is not a project ID`);
  return { projectId: o.project_id as string, clientEmail: o.client_email as string, privateKey: o.private_key as string, tokenUri };
}

const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** An APNs .p8 key (PEM, EC P-256) and its key ID, team ID and topic. */
export function parseApns(env: NodeJS.ProcessEnv, file: string): ApnsConfig {
  const key = readFileSync(existingFile('PUSH_APNS_KEY_FILE', resolve(file)), 'utf8');
  let k: KeyObject;
  try {
    k = createPrivateKey(key);
  } catch {
    throw new Error('PUSH_APNS_KEY_FILE: not a private key (the AuthKey_XXXXXXXXXX.p8 file of your Apple developer account)');
  }
  if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('PUSH_APNS_KEY_FILE: not an APNs key (EC P-256)');
  const keyId = env.PUSH_APNS_KEY_ID ?? '';
  const teamId = env.PUSH_APNS_TEAM_ID ?? '';
  const topic = env.PUSH_APNS_TOPIC || 'dev.mdrunbook.app';
  if (!APPLE_ID_RE.test(keyId)) throw new Error('PUSH_APNS_KEY_ID: the key\'s 10-character Key ID (Certificates, Identifiers & Profiles → Keys)');
  if (!APPLE_ID_RE.test(teamId)) throw new Error('PUSH_APNS_TEAM_ID: your 10-character Team ID (Membership details)');
  if (!BUNDLE_ID_RE.test(topic)) throw new Error('PUSH_APNS_TOPIC: the app\'s bundle ID, such as dev.mdrunbook.app');
  return { key, keyId, teamId, topic, sandbox: bool(env, 'PUSH_APNS_SANDBOX', false) };
}

/** Pushes: on when a sender is set (FCM, APNs or both), and only with alerts (they are what is pushed). */
function loadPush(env: NodeJS.ProcessEnv, stateDir: string, alerts: AlertsConfig | undefined): PushConfig | undefined {
  const fcmFile = env.PUSH_FCM_SERVICE_ACCOUNT_FILE;
  const apnsFile = env.PUSH_APNS_KEY_FILE;
  if (!fcmFile && !apnsFile) {
    const stray = ['DEVICES_TOKENS', 'DEVICES_TOKENS_FILE', 'PUSH_APNS_KEY_ID', 'PUSH_APNS_TEAM_ID'].find((n) => env[n]);
    if (stray) throw new Error(`${stray} is set but no push sender: set PUSH_FCM_SERVICE_ACCOUNT_FILE (Android) and/or PUSH_APNS_KEY_FILE (iPhone)`);
    return undefined;
  }
  if (!alerts) throw new Error('PUSH_FCM_SERVICE_ACCOUNT_FILE / PUSH_APNS_KEY_FILE need ALERT_MAP: the server pushes firing alerts');
  const fcm = fcmFile ? parseServiceAccount(readFileSync(existingFile('PUSH_FCM_SERVICE_ACCOUNT_FILE', resolve(fcmFile)), 'utf8')) : undefined;
  const apns = apnsFile ? parseApns(env, apnsFile) : undefined;
  const tokens = env.DEVICES_TOKENS || env.DEVICES_TOKENS_FILE ? readTokens(env, 'DEVICES_TOKENS') : alerts.readTokens;
  if (tokens.length === 0) throw new Error('Pushes need DEVICES_TOKENS (what a phone registers with), or ALERTS_READ_TOKENS / RUNS_READ_TOKENS: otherwise anyone could register for the alerts');
  return {
    file: join(stateDir, 'devices.json'),
    tokens,
    ...(fcm ? { fcm } : {}),
    ...(apns ? { apns } : {}),
    maxDevices: num(env, 'PUSH_MAX_DEVICES', 1000),
    maxDevicesPerToken: num(env, 'PUSH_MAX_DEVICES_PER_TOKEN', 50),
    repeatMs: num(env, 'PUSH_REPEAT_SECONDS', 3600) * 1000,
  };
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
    // Without a token, anyone who reaches /v1/alerts could post an alert whose link sends on-call
    // to another saved host, with parameters of their choosing (security review, 2026-11-16).
    if (alerts.tokens.length === 0 && !bool(env, 'ALERTS_ALLOW_ANYONE', false)) {
      throw new Error('ALERT_MAP needs ALERTS_TOKENS (what Alertmanager sends): otherwise anyone could post alerts. ALERTS_ALLOW_ANYONE=true takes them without a token (on a private network only)');
    }
  }

  if (!library && !runs && !alerts) throw new Error('Nothing to serve: set LIBRARY_DIR (publishing), RUNS_DIR (run summaries) and/or ALERT_MAP (alerts)');

  const push = loadPush(env, stateDir, alerts);

  return {
    host: env.SERVER_HOST ?? '127.0.0.1',
    port: num(env, 'SERVER_PORT', 8090),
    stateDir,
    ...(library ? { library } : {}),
    ...(runs ? { runs } : {}),
    ...(alerts ? { alerts } : {}),
    ...(push ? { push } : {}),
    origins: list(env.CORS_ORIGINS),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    ratePerMinute: num(env, 'RATE_PER_MINUTE', 120),
    maxFailures: num(env, 'MAX_FAILURES', 10),
    failWindowMs: num(env, 'FAIL_WINDOW_SECONDS', 600) * 1000,
    sshKeygen,
  };
}

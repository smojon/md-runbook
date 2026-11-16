/**
 * Publish to Library… and Remove from Library…, as VS Code's (src/libraryPublish.ts and
 * src/libraryClient.ts): POST a signed runbook to the library server's
 * /v1/library/runbooks/<path>, or DELETE one (where LIBRARY_ALLOW_DELETE is on), with an upload
 * token. The server's address is a setting (Hosts & settings), by default the origin of the
 * library the app reads (the web container serves both). The token is kept per server in the
 * app's secure storage (the Keychain, the Android Keystore; on the web this browser's storage) and
 * only ever sent to that server, in the Authorization header.
 */
import { libraryApiUrl, libraryPathProblem, nameFitsPath } from '@md-runbook/core/library';
import { reportAddressProblem } from '@md-runbook/core/secrets';
import { Manifest, signedStatus, wholeRunbookSigned } from '@md-runbook/core/signing';
import { libraryServerSetting } from '../settings/store';
import { getJson, setJson } from '../storage/kv';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';
import { t } from '../i18n';
import { libraryBase } from './library';
import type { Runbook } from './store';

export { libraryPathProblem, nameFitsPath };

/** One request may take this long. */
export const LIBRARY_SEND_TIMEOUT_MS = 30_000;
/** An upload token: at least 24 printable characters, no spaces (the server's LIBRARY_UPLOAD_TOKENS). */
export const TOKEN_RE = /^[\x21-\x7e]{24,}$/;

export type PublishFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; redirect: 'error'; signal: AbortSignal },
) => Promise<{ status: number; url?: string; text(): Promise<string> }>;

/** The server's JSON answer (publish: name … unchanged; delete: deleted, version; refused: error, problems). */
export interface LibraryAnswer {
  path?: string;
  name?: string;
  version?: number;
  previous?: number;
  signer?: string;
  unchanged?: boolean;
  deleted?: string;
  error?: string;
  problems?: string[];
}

export type LibraryResult = { kind: 'answer'; status: number; answer: LibraryAnswer } | { kind: 'unreachable'; why: string };

export type PublishCheck =
  | { ok: true; manifest: Manifest }
  | { ok: false; why: 'unsigned' | 'unreadable' | 'version1' | 'changed' | 'expired'; manifest?: Manifest };

/**
 * Whether the library server would take this text, as far as can be told without its signers:
 * signed as a whole (manifest version 2), unchanged since, not expired.
 */
export function publishCheck(text: string, today = new Date().toISOString().slice(0, 10)): PublishCheck {
  if (!/md-runbook:signature v1/.test(text)) return { ok: false, why: 'unsigned' };
  const s = signedStatus(text);
  if (!s) return { ok: false, why: 'unreadable' };
  if (s.version !== 2) return { ok: false, why: 'version1', manifest: s.manifest };
  if (!wholeRunbookSigned(s)) return { ok: false, why: 'changed', manifest: s.manifest };
  if (s.manifest.expires && s.manifest.expires < today) return { ok: false, why: 'expired', manifest: s.manifest };
  return { ok: true, manifest: s.manifest };
}

/** The server's address without trailing slashes, or why it can't be one (https only, http for this machine). */
export function libraryServerAddress(url: string): { base: string } | { problem: string } {
  const base = url.trim().replace(/\/+$/, '');
  const problem = reportAddressProblem(base);
  return problem ? { problem } : { base };
}

const originOf = (url: string): string | undefined => {
  try {
    const o = new URL(url).origin;
    return o && o !== 'null' ? o : undefined;
  } catch {
    return undefined;
  }
};

/** The host a server address names, as the sheet shows it. */
export function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/** The default server: the origin of the library the app reads (undefined when there is none). */
export const defaultLibraryServer = (): string | undefined => {
  const base = libraryBase();
  return base ? originOf(base) : undefined;
};

/** The server Publish and Remove use: the setting, else the default; undefined when neither is usable. */
export function libraryServer(): string | undefined {
  const set = libraryServerSetting();
  const candidate = set || defaultLibraryServer();
  if (!candidate) return undefined;
  const a = libraryServerAddress(candidate);
  return 'base' in a ? a.base : undefined;
}

/** A path as typed: forward slashes, no leading slash. */
export const cleanLibraryPath = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^\/+/, '');

/** Why the typed path can't take the runbook signed as `name` (undefined: it can). */
export function pathProblem(path: string, name: string | undefined): string | undefined {
  const p = cleanLibraryPath(path);
  const problem = libraryPathProblem(p);
  if (problem) return problem;
  return name !== undefined && !nameFitsPath(name, p) ? t.publishPathName(name) : undefined;
}

// ---- the upload token (per server origin) ----

/** The secure storage key for a server's token (letters, digits and . _ - only, as the Keychain wants). */
export const tokenKey = (server: string): string => `library.token.${(originOf(server) ?? server).replace(/[^A-Za-z0-9._-]/g, '_')}`;

export const storedToken = (server: string): Promise<string | null> => getSecret(tokenKey(server)).catch(() => null);
export const storeToken = (server: string, token: string): Promise<void> => setSecret(tokenKey(server), token.trim());
export const forgetToken = (server: string): Promise<void> => deleteSecret(tokenKey(server));

// ---- where each runbook was published (the default path next time) ----

const PUBLISHED_KEY = 'md-runbook.libraryPublished';
const isPaths = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && Object.values(v).every((p) => typeof p === 'string');

export async function rememberPublished(runbookId: string, path: string): Promise<void> {
  const all = (await getJson(PUBLISHED_KEY, isPaths)) ?? {};
  await setJson(PUBLISHED_KEY, { ...all, [runbookId]: path });
}

/**
 * The path to offer: where this runbook was published last, else (a library copy of this
 * server's library) the path it came from, else its signed name as a file.
 */
export async function defaultPath(runbook: Pick<Runbook, 'id' | 'library'>, server: string, name: string | undefined): Promise<string> {
  const seen = (await getJson(PUBLISHED_KEY, isPaths))?.[runbook.id];
  if (seen) return seen;
  if (runbook.library && originOf(runbook.library.base) === originOf(server)) return runbook.library.path;
  return name ? `${name}.md` : '';
}

// ---- sending ----

/** Send one request to the library server. Never follows a redirect (the token would go along). */
export async function sendToLibrary(o: {
  method: 'POST' | 'DELETE';
  server: string;
  path: string;
  token: string;
  text?: string;
  fetchFn?: PublishFetch;
  timeoutMs?: number;
}): Promise<LibraryResult> {
  const url = libraryApiUrl(o.server, o.path);
  const abort = new AbortController();
  const timeout = o.timeoutMs ?? LIBRARY_SEND_TIMEOUT_MS;
  const timer = setTimeout(() => abort.abort(), timeout);
  const headers: Record<string, string> = { authorization: `Bearer ${o.token}` };
  if (o.text !== undefined) headers['content-type'] = 'text/markdown; charset=utf-8';
  let status: number;
  let body: string;
  try {
    const fetchFn: PublishFetch = o.fetchFn ?? ((u, init) => fetch(u, init));
    const r = await fetchFn(url, {
      method: o.method,
      headers,
      ...(o.text !== undefined ? { body: o.text } : {}),
      redirect: 'error',
      signal: abort.signal,
    });
    // A runtime that follows redirects anyway (React Native's fetch): its answer is not the server's.
    if (r.url && r.url !== url) return { kind: 'unreachable', why: t.publishRedirected(serverHost(r.url)) };
    status = r.status;
    body = await r.text();
  } catch (e) {
    return {
      kind: 'unreachable',
      why: abort.signal.aborted ? t.publishTimeout(Math.round(timeout / 1000)) : e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
  let answer: LibraryAnswer;
  try {
    const parsed: unknown = JSON.parse(body);
    answer = typeof parsed === 'object' && parsed !== null ? (parsed as LibraryAnswer) : { error: body.slice(0, 200) };
  } catch {
    answer = { error: body.slice(0, 200) };
  }
  return { kind: 'answer', status, answer };
}

/** What a published answer says (200: the same text was there already; 201: published). */
export function publishedText(where: string, a: LibraryAnswer): string {
  return a.unchanged
    ? t.publishUnchanged(where, a.name ?? '?', a.version ?? 0)
    : t.publishDone(where, a.name ?? '?', a.version ?? 0, a.previous, a.signer ?? '?');
}

/** A refused request, as a title and its points (the server's reason and problems when it gave them). */
export function refusalText(
  method: 'POST' | 'DELETE',
  where: string,
  status: number,
  a: LibraryAnswer,
): { title: string; points: readonly string[] } {
  const reason = [...(a.error ? [a.error] : []), ...(a.problems ?? [])];
  if (status === 401) return { title: t.publishTokenRefused, points: reason };
  if (method === 'DELETE' && status === 405) return { title: t.removeNotAllowed, points: t.removeNotAllowedPoints };
  if (method === 'DELETE' && status === 404 && a.error && /not in the library/.test(a.error))
    return { title: t.removeNotThere(where), points: [] };
  if (status === 404) return { title: t.publishNoLibrary, points: reason };
  if (status === 403) return { title: t.publishForbidden, points: reason.length ? reason : [t.publishNoReason] };
  return { title: t.publishRefused(where, status), points: reason.length ? reason : [t.publishNoReason] };
}

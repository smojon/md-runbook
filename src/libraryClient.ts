/**
 * Talking to a team library server (apps/library-server): POST a signed runbook to
 * /v1/library/runbooks/<path>, or DELETE one (only where LIBRARY_ALLOW_DELETE is on), with an
 * upload token. Shared by `md-runbook publish` / `unpublish` and VS Code's Publish to Library… /
 * Remove from Library…. No vscode import: unit-tested. The token is sent in the Authorization
 * header only, never in an address, and never written anywhere.
 */

import { libraryApiUrl } from '@md-runbook/core/library';
import { reportAddressProblem } from '@md-runbook/core/secrets';
import { Manifest, signedStatus, wholeRunbookSigned } from '@md-runbook/core/signing';

/** Where the command line reads the upload token from (never from its arguments). */
export const LIBRARY_TOKEN_ENV = 'MD_RUNBOOK_LIBRARY_TOKEN';
/** One request may take this long. */
export const LIBRARY_SEND_TIMEOUT_MS = 30_000;

export type LibraryFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; redirect: 'error'; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

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

/** The server's address without trailing slashes, or why it can't be one (https only, http for localhost). */
export function libraryServerAddress(url: string): { base: string } | { problem: string } {
  const base = url.trim().replace(/\/+$/, '');
  const problem = reportAddressProblem(base);
  return problem ? { problem } : { base };
}

/** A path as typed: forward slashes, no leading slash. */
export const cleanLibraryPath = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^\/+/, '');

/** Send one request to the library server. Never follows a redirect (the token would go along). */
export async function sendToLibrary(o: {
  method: 'POST' | 'DELETE';
  server: string;
  path: string;
  token: string;
  text?: string;
  fetchFn?: LibraryFetch;
  timeoutMs?: number;
}): Promise<LibraryResult> {
  const url = libraryApiUrl(o.server, o.path);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? LIBRARY_SEND_TIMEOUT_MS);
  const headers: Record<string, string> = { authorization: `Bearer ${o.token}` };
  if (o.text !== undefined) headers['content-type'] = 'text/markdown; charset=utf-8';
  let status: number;
  let body: string;
  try {
    const r = await (o.fetchFn ?? ((u, init) => fetch(u, init)))(url, { method: o.method, headers, ...(o.text !== undefined ? { body: o.text } : {}), redirect: 'error', signal: abort.signal });
    status = r.status;
    body = await r.text();
  } catch (e) {
    return { kind: 'unreachable', why: abort.signal.aborted ? `no answer in ${Math.round((o.timeoutMs ?? LIBRARY_SEND_TIMEOUT_MS) / 1000)} s` : e instanceof Error ? e.message : String(e) };
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

/** What a published answer says (200: the same text was there; 201: published). */
export function publishedText(where: string, a: LibraryAnswer): string {
  return a.unchanged
    ? `${where}: ${a.name} version ${a.version} is published already (the same text)`
    : `published ${a.name} version ${a.version} at ${where}${a.previous ? ` (was version ${a.previous})` : ''}, signed by ${a.signer}`;
}

/** A DELETE the server refused, in a few words, by status (the server's own reason when it gave one). */
export function removeRefusal(where: string, status: number, a: LibraryAnswer): string {
  if (status === 405) return `the library server doesn't allow removing runbooks (LIBRARY_ALLOW_DELETE is off)`;
  if (status === 404) return a.error && /not in the library/.test(a.error) ? `${where} is not in the library` : `no library there (HTTP 404${a.error ? `: ${a.error}` : ''})`;
  if (status === 401) return `the upload token was refused: ${a.error ?? 'HTTP 401'}`;
  if (status === 403) return `not allowed (HTTP 403): ${a.error ?? 'no reason given'}`;
  return `the library refused it (HTTP ${status}): ${a.error ?? 'no reason given'}`;
}

/** A refusal the user can act on (exit 1 for the command line); others are the server's or the network's (exit 2). */
export const refusedStatus = (status: number): boolean => [400, 401, 403, 404, 405, 409, 413, 422].includes(status);

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

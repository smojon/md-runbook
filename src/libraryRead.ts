/**
 * Reading a team library for VS Code's Library view, as the app reads it
 * (apps/mobile/src/runbooks/library.ts, with core's parsers): its index.json, else the server's
 * JSON listing of the folder (nginx autoindex), its runbooks' texts and its allowed_signers. What
 * each runbook's signature is worth against the signers you trust (libraryVerdict). No vscode
 * import: unit-tested with a fake fetch.
 */

import { MAX_LIBRARY_FILES, LibraryIndex, libraryFileUrl, libraryUrlProblemKind, nameFitsPath, normalizeLibraryUrl, parseAutoindex, parseIndexJson } from '@md-runbook/core/library';
import { readSignature, signedStatus, signerNames, wholeRunbookSigned } from '@md-runbook/core/signing';
import { runbookTitle } from '@md-runbook/core/title';

/** A runbook larger than this is not read (the app's limit). */
export const MAX_RUNBOOK_BYTES = 5 * 1024 * 1024;
/** At most this much text is read from one library, all its runbooks together. */
export const MAX_LIBRARY_CHARS = 20 * 1024 * 1024;
const MAX_DEPTH = 3;
const TIMEOUT_MS = 30_000;

export type ReadFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'follow' }) => Promise<{
  status: number;
  ok: boolean;
  url?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** The app's words for a library address that can't be one, or undefined. */
export function libraryUrlProblem(url: string): string | undefined {
  const kind = libraryUrlProblemKind(url);
  return kind === 'invalid'
    ? 'Not a library address: use the https address of the folder, such as https://runbooks.example.net/runbooks/.'
    : kind === 'userinfo'
      ? 'Not a library address: no user name or password before the host (user@host).'
      : kind === 'https'
        ? 'Only https addresses (http only for localhost).'
        : undefined;
}

/** The library folder a setting names (ends with /), or undefined when it's empty or not usable. */
export function libraryBaseOf(setting: string): string | undefined {
  const s = setting.trim();
  return s && !libraryUrlProblem(s) ? normalizeLibraryUrl(s) : undefined;
}

export interface LibraryEntry {
  path: string;
  fileName: string;
  /** The group it is listed under ('' for none). */
  folder: string;
  title: string;
  text?: string;
  error?: string;
}

export interface Library {
  base: string;
  signedOnly: boolean;
  entries: LibraryEntry[];
  /** The library's allowed_signers file as served, when it has one. */
  allowedSigners?: string;
}

export type LibraryRead = { kind: 'none' } | { kind: 'error'; message: string } | { kind: 'ok'; library: Library };

const looksHtml = (s: string): boolean => /^\s*<(!doctype\s+html|html[\s>])/i.test(s);
const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

interface Got {
  status: number;
  text?: string;
  error?: string;
}

async function getText(fetchFn: ReadFetch, url: string): Promise<Got> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: abort.signal, headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
    // A redirect may stay on the library's server only: the host shown is the one that served the text.
    const from = res.url ? originOf(res.url) : undefined;
    if (from !== undefined && from !== originOf(url)) return { status: 0, error: `redirected to another server (${new URL(res.url!).host}): not read` };
    if (!res.ok) return { status: res.status };
    if (Number(res.headers.get('content-length') ?? 0) > MAX_RUNBOOK_BYTES) return { status: 413 };
    const text = await res.text();
    return Buffer.byteLength(text, 'utf8') > MAX_RUNBOOK_BYTES ? { status: 413 } : { status: res.status, text };
  } catch (e) {
    return { status: 0, error: abort.signal.aborted ? 'no answer in 30 s' : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const jsonOf = (text: string | undefined): unknown => {
  if (text === undefined || looksHtml(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

async function listLibrary(base: string, fetchFn: ReadFetch): Promise<{ index: LibraryIndex; allowedSigners?: boolean } | LibraryRead> {
  const idx = await getText(fetchFn, base + 'index.json');
  if (idx.error) return { kind: 'error', message: idx.error };
  if (idx.text !== undefined && !looksHtml(idx.text)) {
    const parsed = parseIndexJson(jsonOf(idx.text));
    return parsed ? { index: parsed } : { kind: 'error', message: 'its index.json is not a list of runbooks' };
  }
  if (idx.status !== 404 && idx.status !== 403 && idx.text === undefined) return { kind: 'error', message: `HTTP ${idx.status}` };
  const files: string[] = [];
  let allowedSigners = false;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    const res = await getText(fetchFn, dir ? libraryFileUrl(base, dir) + '/' : base);
    if (res.error) throw new Error(res.error);
    const listing = parseAutoindex(jsonOf(res.text));
    if (!listing) return false;
    if (!dir) allowedSigners = listing.allowedSigners;
    for (const f of listing.files) if (files.length < MAX_LIBRARY_FILES) files.push(dir ? `${dir}/${f}` : f);
    if (depth < MAX_DEPTH) for (const d of listing.dirs) if (files.length < MAX_LIBRARY_FILES) await walk(dir ? `${dir}/${d}` : d, depth + 1);
    return true;
  };
  if (!(await walk('', 1))) return { kind: 'none' };
  return { index: { files: files.map((path) => ({ path })), signedOnly: false }, allowedSigners };
}

/** Read the library at `base` (a folder address, ends with /). */
export async function readLibrary(base: string, fetchFn: ReadFetch = (u, i) => fetch(u, i)): Promise<LibraryRead> {
  let listed: Awaited<ReturnType<typeof listLibrary>>;
  try {
    listed = await listLibrary(base, fetchFn);
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  if ('kind' in listed) return listed;
  const { index } = listed;
  const entries: LibraryEntry[] = new Array(index.files.length);
  let next = 0;
  let total = 0;
  const worker = async (): Promise<void> => {
    while (next < index.files.length) {
      const i = next++;
      const f = index.files[i]!;
      const fileName = f.path.split('/').pop()!;
      const folder = f.folder ?? f.path.split('/').slice(0, -1).join('/');
      const fallback = f.title ?? fileName.replace(/\.(md|markdown)$/i, '');
      if (total > MAX_LIBRARY_CHARS) {
        entries[i] = { path: f.path, fileName, folder, title: fallback, error: 'not read: the library holds more than 20 MB of text' };
        continue;
      }
      const got = await getText(fetchFn, libraryFileUrl(base, f.path));
      total += got.text?.length ?? 0;
      if (got.text === undefined || looksHtml(got.text) || total > MAX_LIBRARY_CHARS) {
        const error = got.error ?? (got.status === 413 ? `${fileName} is larger than 5 MB` : got.text !== undefined && total > MAX_LIBRARY_CHARS ? 'not read: the library holds more than 20 MB of text' : `HTTP ${got.status}`);
        entries[i] = { path: f.path, fileName, folder, title: fallback, error };
      } else {
        entries[i] = { path: f.path, fileName, folder, title: f.title ?? runbookTitle(got.text) ?? fallback, text: got.text };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, index.files.length) }, worker));
  let allowedSigners: string | undefined;
  if (listed.allowedSigners !== false) {
    const got = await getText(fetchFn, base + 'allowed_signers');
    if (got.text !== undefined && !looksHtml(got.text)) allowedSigners = got.text;
  }
  return { kind: 'ok', library: { base, signedOnly: index.signedOnly, entries, ...(allowedSigners !== undefined ? { allowedSigners } : {}) } };
}

/** What a library runbook's signature is worth here. */
export type Verdict =
  | { kind: 'verified'; name: string; version: number; signer: string }
  | { kind: 'untrusted'; name: string; version: number; signers: string[] }
  | { kind: 'unsigned' }
  | { kind: 'damaged' }
  | { kind: 'partial'; name: string; version: number }
  | { kind: 'changed'; name: string; version: number }
  | { kind: 'expired'; name: string; version: number; expires: string }
  | { kind: 'other-name'; name: string; version: number }
  | { kind: 'older'; name: string; version: number; seen: number };

/**
 * The verdict on a library runbook's text: `trusted` is the signer of your allowed_signers whose
 * key made one of its signatures (trustedRunbookSigner), undefined when none did (or none is set);
 * `seen` the highest version of this path under this name verified before (a lower one now is a
 * downgrade, as the app and the gate's version floors refuse).
 */
export function libraryVerdict(path: string, text: string, trusted: string | undefined, seen: number | undefined, today = new Date().toISOString().slice(0, 10)): Verdict {
  const block = readSignature(text);
  if (!block) return /md-runbook:signature v1/.test(text) ? { kind: 'damaged' } : { kind: 'unsigned' };
  const s = signedStatus(text);
  if (!s) return { kind: 'damaged' };
  const { name, version } = s.manifest;
  if (s.version !== 2) return { kind: 'partial', name, version };
  if (!wholeRunbookSigned(s)) return { kind: 'changed', name, version };
  if (s.manifest.expires && s.manifest.expires < today) return { kind: 'expired', name, version, expires: s.manifest.expires };
  if (!nameFitsPath(name, path)) return { kind: 'other-name', name, version };
  if (!trusted) return { kind: 'untrusted', name, version, signers: signerNames(block) };
  if (seen !== undefined && version < seen) return { kind: 'older', name, version, seen };
  return { kind: 'verified', name, version, signer: trusted };
}

/** The verdict in a few words, for a row's description. */
export function verdictLabel(v: Verdict): string {
  switch (v.kind) {
    case 'verified':
      return `verified · v${v.version} · ${v.signer}`;
    case 'untrusted':
      return `signed by ${v.signers.join(', ')} · not a signer you trust`;
    case 'unsigned':
      return 'not signed';
    case 'damaged':
      return 'signature damaged';
    case 'partial':
      return 'only its bash blocks are signed';
    case 'changed':
      return 'changed since signing';
    case 'expired':
      return `signature expired ${v.expires}`;
    case 'other-name':
      return `signed as ${v.name}, not this file`;
    case 'older':
      return `v${v.version}: older than v${v.seen} seen before`;
  }
}

/** The library groups in list order: no folder first, then by name; runbooks by title. */
export function groupEntries(entries: readonly LibraryEntry[]): { folder: string; entries: LibraryEntry[] }[] {
  const groups = new Map<string, LibraryEntry[]>();
  for (const e of entries) {
    if (!groups.has(e.folder)) groups.set(e.folder, []);
    groups.get(e.folder)!.push(e);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, list]) => ({ folder, entries: [...list].sort((x, y) => x.title.localeCompare(y.title)) }));
}

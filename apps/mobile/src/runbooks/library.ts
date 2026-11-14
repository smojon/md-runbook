/**
 * The team library: runbooks in a folder on a web server that every user of the app sees, without
 * uploading anything. The web app's container serves its `runbooks/` folder at /runbooks/ (on the
 * web the library is there by default); the phones, or a web app elsewhere, use the address set
 * in Hosts & settings (or added by a mdrunbook://library?url=… link or QR code).
 *
 * The folder's files come from its `index.json` when there is one (titles, folders, signedOnly),
 * else from the server's listing of the folder (nginx `autoindex_format json`), subfolders as
 * groups. An `allowed_signers` file next to them is offered to trust (signing/trust.ts).
 *
 * Opening a library runbook makes the user's own copy (source 'library'): runs and outputs stay
 * theirs, the shared file is never changed. When the library's file changes, the copy offers
 * Update (outputs of unchanged blocks are kept) or Keep mine.
 */
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { DEFAULT_WRITE_OPTIONS, clearOutputBlocks, isCodeMeta, parse, serialize, toCellInputs } from '@md-runbook/core';
import type { CellInput } from '@md-runbook/core';
import { readSignature } from '@md-runbook/core/signing';
import { runbookTitle } from '@md-runbook/core/title';
import { t } from '../i18n';
import { loadSettings, libraryUrlSetting } from '../settings/store';
import {
  AllowedSigner,
  SignatureState,
  isSignedIntact,
  loadTrustedSigners,
  parseAllowedSigners,
  signatureState,
  trustedSigners,
} from '../signing/trust';
import { parseSshsig } from '../signing/verify';
import { textHash } from './origin';
import {
  MAX_RUNBOOK_BYTES,
  Runbook,
  addLibraryCopy,
  getRunbook,
  libraryCopy,
  loadRunbooks,
  setLibraryRef,
  updateRunbookText,
} from './store';

/** At most this many runbooks (and folder levels) are read from a library. */
export const MAX_LIBRARY_FILES = 200;
const MAX_DEPTH = 3;
/** A library fetched less than this long ago is not fetched again on start (pull to refresh does). */
export const LIBRARY_CACHE_MS = 60_000;

// ---- the address ----

/** Why this can't be a library address, or undefined: https only (http for this machine). */
export function libraryUrlProblem(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return t.libraryUrlInvalid;
  }
  if (u.protocol === 'https:') return u.search || u.hash ? t.libraryUrlInvalid : undefined;
  if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))
    return u.search || u.hash ? t.libraryUrlInvalid : undefined;
  return t.libraryUrlHttps;
}

/** The address as a folder (ends with /). */
export function normalizeLibraryUrl(url: string): string {
  // String work, not URL setters (React Native's URL has none).
  const s = url.trim();
  return s.endsWith('/') ? s : s + '/';
}

/** On the web: the app's own /runbooks/ (the container's library); none on the phones. */
export function defaultLibraryBase(): string | undefined {
  if (Platform.OS !== 'web') return undefined;
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return origin && /^https?:\/\//.test(origin) ? `${origin}/runbooks/` : undefined;
}

/** The library the app reads: the address set in the settings, else the default. */
export function libraryBase(): string | undefined {
  const set = libraryUrlSetting();
  if (set && !libraryUrlProblem(set)) return normalizeLibraryUrl(set);
  return set ? undefined : defaultLibraryBase();
}

/** The link that adds a library (Share library's QR code): the app's own scheme, as hosts links are. */
export function libraryLink(base: string): string {
  return `mdrunbook://library?url=${encodeURIComponent(base)}`;
}

/**
 * The library address a link adds: mdrunbook://library?url=… (a QR code, the phones' deep link)
 * or the web app's /library?url=…; undefined for other links.
 */
export function libraryLinkUrl(link: string): string | undefined {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return undefined;
  }
  const isLibrary =
    u.protocol === 'mdrunbook:'
      ? u.host === 'library' || u.pathname.replace(/^\/+/, '') === 'library'
      : /^https?:$/.test(u.protocol) && u.pathname === '/library';
  return isLibrary ? (u.searchParams.get('url') ?? undefined) : undefined;
}

// ---- reading a library ----

export interface LibraryFile {
  /** Relative to the library's folder: `deploy.md`, `db/restore.md`. */
  path: string;
  title?: string;
  /** The group it is listed under ('' for none); by default its subfolder. */
  folder?: string;
}

export interface LibraryIndex {
  files: LibraryFile[];
  signedOnly: boolean;
}

/** A path inside the library: relative, no `..`, no backslashes or addresses. */
const safePath = (p: string): boolean =>
  p !== '' &&
  !p.startsWith('/') &&
  !p.includes('\\') &&
  !p.includes('://') &&
  p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
const isMarkdown = (p: string): boolean => /\.(md|markdown)$/i.test(p);
const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/');

/**
 * index.json: `{ "signedOnly": true, "runbooks": [ "deploy.md", { "path": "db/restore.md",
 * "title": "Restore", "folder": "Databases" } ] }`, or the list alone. Undefined when it's not one.
 */
export function parseIndexJson(v: unknown): LibraryIndex | undefined {
  const obj = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const list = Array.isArray(v) ? v : obj?.runbooks;
  if (!Array.isArray(list)) return undefined;
  const files: LibraryFile[] = [];
  for (const e of list) {
    const f: LibraryFile | undefined =
      typeof e === 'string'
        ? { path: e }
        : typeof e === 'object' && e !== null && typeof (e as LibraryFile).path === 'string'
          ? {
              path: (e as LibraryFile).path,
              ...(typeof (e as LibraryFile).title === 'string' && (e as LibraryFile).title!.trim()
                ? { title: (e as LibraryFile).title!.trim() }
                : {}),
              ...(typeof (e as LibraryFile).folder === 'string' ? { folder: (e as LibraryFile).folder!.trim() } : {}),
            }
          : undefined;
    const path = f?.path.replace(/^\.\//, '');
    if (f && path && safePath(path) && isMarkdown(path) && !files.some((x) => x.path === path)) files.push({ ...f, path });
  }
  return { files: files.slice(0, MAX_LIBRARY_FILES), signedOnly: obj?.signedOnly === true };
}

/**
 * nginx's JSON listing of a folder (`[{ "name": "a.md", "type": "file", … }, { "name": "db",
 * "type": "directory", … }]`): its runbooks, subfolders, and whether allowed_signers is there.
 */
export function parseAutoindex(v: unknown): { files: string[]; dirs: string[]; allowedSigners: boolean } | undefined {
  if (!Array.isArray(v)) return undefined;
  const files: string[] = [];
  const dirs: string[] = [];
  let allowedSigners = false;
  for (const e of v) {
    if (typeof e !== 'object' || e === null) continue;
    const { name, type } = e as { name?: unknown; type?: unknown };
    if (typeof name !== 'string' || !safePath(name) || name.includes('/') || name.startsWith('.')) continue;
    if (type === 'directory') dirs.push(name);
    else if (type === 'file' && isMarkdown(name)) files.push(name);
    else if (type === 'file' && name === 'allowed_signers') allowedSigners = true;
  }
  const byName = (a: string, b: string): number => a.localeCompare(b);
  return { files: files.sort(byName), dirs: dirs.sort(byName), allowedSigners };
}

export interface LibraryEntry {
  path: string;
  fileName: string;
  folder: string;
  title: string;
  /** The file's text (undefined: it couldn't be read, see `error`). */
  text?: string;
  hash?: string;
  error?: string;
}

export interface Library {
  base: string;
  signedOnly: boolean;
  entries: LibraryEntry[];
  /** The library's allowed_signers, when it has one. */
  signers?: { list: AllowedSigner[]; skipped: number };
}

export type LibraryFetch = { kind: 'none' } | { kind: 'error'; message: string } | { kind: 'ok'; library: Library };

const urlOf = (base: string, path: string): string => base + path.split('/').map(encodeURIComponent).join('/');
/** An HTML page where JSON or a file was asked for (a single-page app's fallback). */
const looksHtml = (s: string): boolean => /^\s*</.test(s);

async function getText(fetcher: typeof fetch, url: string): Promise<{ status: number; text?: string }> {
  const res = await fetcher(url, { cache: 'no-cache' });
  if (!res.ok) return { status: res.status };
  if (Number(res.headers?.get('content-length') ?? 0) > MAX_RUNBOOK_BYTES) return { status: 413 };
  const text = await res.text();
  return text.length > MAX_RUNBOOK_BYTES ? { status: 413 } : { status: res.status, text };
}

const jsonOf = (text: string | undefined): unknown => {
  if (text === undefined || looksHtml(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The list of runbooks: index.json, else the server's listing (nothing: no library). */
async function listLibrary(base: string, fetcher: typeof fetch): Promise<{ index: LibraryIndex; allowedSigners?: boolean } | LibraryFetch> {
  const idx = await getText(fetcher, base + 'index.json');
  if (idx.text !== undefined && !looksHtml(idx.text)) {
    const parsed = parseIndexJson(jsonOf(idx.text));
    if (!parsed) return { kind: 'error', message: t.libraryBadIndex };
    return { index: parsed };
  }
  if (idx.status !== 404 && idx.status !== 403 && idx.text === undefined) return { kind: 'error', message: `HTTP ${idx.status}` };
  const files: string[] = [];
  let allowedSigners = false;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    const res = await getText(fetcher, dir ? urlOf(base, dir) + '/' : base);
    const listing = parseAutoindex(jsonOf(res.text));
    if (!listing) return false;
    if (!dir) allowedSigners = listing.allowedSigners;
    for (const f of listing.files) if (files.length < MAX_LIBRARY_FILES) files.push(dir ? `${dir}/${f}` : f);
    if (depth < MAX_DEPTH)
      for (const d of listing.dirs) if (files.length < MAX_LIBRARY_FILES) await walk(dir ? `${dir}/${d}` : d, depth + 1);
    return true;
  };
  if (!(await walk('', 1))) return { kind: 'none' };
  return { index: { files: files.map((path) => ({ path })), signedOnly: false }, allowedSigners };
}

/** Read the library at `base`: its runbooks' texts, titles and folders, and its allowed_signers. */
export async function fetchLibrary(base: string, fetcher: typeof fetch = fetch): Promise<LibraryFetch> {
  let listed: Awaited<ReturnType<typeof listLibrary>>;
  try {
    listed = await listLibrary(base, fetcher);
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  if ('kind' in listed) return listed;
  const { index } = listed;
  // A few at a time: a library of a hundred runbooks is a hundred requests.
  const entries: LibraryEntry[] = new Array(index.files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < index.files.length) {
      const i = next++;
      const f = index.files[i]!;
      const fileName = f.path.split('/').pop()!;
      const folder = f.folder ?? dirOf(f.path);
      const fallback = f.title ?? fileName.replace(/\.(md|markdown)$/i, '');
      try {
        const got = await getText(fetcher, urlOf(base, f.path));
        if (got.text === undefined || looksHtml(got.text)) {
          entries[i] = {
            path: f.path,
            fileName,
            folder,
            title: fallback,
            error: got.status === 413 ? t.fileTooLarge(fileName) : `HTTP ${got.status}`,
          };
        } else {
          entries[i] = {
            path: f.path,
            fileName,
            folder,
            title: f.title ?? runbookTitle(got.text) ?? fallback,
            text: got.text,
            hash: textHash(got.text),
          };
        }
      } catch (e) {
        entries[i] = { path: f.path, fileName, folder, title: fallback, error: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, index.files.length) }, worker));
  let signers: Library['signers'];
  if (listed.allowedSigners !== false) {
    try {
      const got = await getText(fetcher, base + 'allowed_signers');
      if (got.text !== undefined && !looksHtml(got.text)) {
        const parsed = parseAllowedSigners(got.text);
        signers = { list: parsed.signers, skipped: parsed.skipped };
      }
    } catch {
      signers = undefined;
    }
  }
  return { kind: 'ok', library: { base, signedOnly: index.signedOnly, entries, ...(signers ? { signers } : {}) } };
}

// ---- the library the list shows ----

export interface LibraryState {
  /** The address read ('' when there is none). */
  base: string;
  status: 'idle' | 'loading' | 'ready' | 'none' | 'error';
  library?: Library;
  error?: string;
  /** Each runbook's signature, by path (filled in after the texts arrive). */
  signatures: Readonly<Record<string, SignatureState>>;
  fetchedAt?: number;
  /** A read is going on (the refresh button spins). */
  busy?: boolean;
}

const IDLE: LibraryState = { base: '', status: 'idle', signatures: {} };
let state: LibraryState = IDLE;
const listeners = new Set<() => void>();
const set = (next: LibraryState): void => {
  state = next;
  listeners.forEach((l) => l());
};
/** The read going on, and the address it reads (another address waits for it, then reads its own). */
let inFlight: { base: string | undefined; done: Promise<void> } | undefined;

export const libraryState = (): LibraryState => state;

export function useLibrary(): LibraryState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

async function signaturesOf(library: Library): Promise<Record<string, SignatureState>> {
  const out: Record<string, SignatureState> = {};
  for (const e of library.entries) if (e.text !== undefined) out[e.path] = await signatureState(e.text, trustedSigners());
  return out;
}

/**
 * Read the library (on start, on pull to refresh). Within LIBRARY_CACHE_MS of the last read
 * nothing is fetched unless `force`. A library that's gone (404) leaves no section and no error.
 */
export function refreshLibrary(opts: { force?: boolean; fetcher?: typeof fetch } = {}): Promise<void> {
  if (inFlight) return inFlight.base === libraryBase() ? inFlight.done : inFlight.done.then(() => refreshLibrary(opts));
  const done = (async () => {
    await Promise.all([loadSettings(), loadTrustedSigners(), loadRunbooks()]);
    const base = libraryBase() ?? '';
    if (!base) return set({ ...IDLE });
    const fresh = state.base === base && state.fetchedAt !== undefined && Date.now() - state.fetchedAt < LIBRARY_CACHE_MS;
    if (fresh && !opts.force) return;
    set({
      ...(state.base === base ? state : { ...IDLE, base }),
      status: state.base === base && state.library ? state.status : 'loading',
      busy: true,
    });
    const got = await fetchLibrary(base, opts.fetcher ?? fetch);
    if (libraryBase() !== base) return set({ ...state, busy: false });
    if (got.kind === 'none') return set({ base, status: 'none', signatures: {}, fetchedAt: Date.now() });
    // Offline or a server error: what was read before stays listed.
    if (got.kind === 'error')
      return set({ ...state, base, status: state.library ? 'ready' : 'error', error: got.message, fetchedAt: Date.now(), busy: false });
    set({ base, status: 'ready', library: got.library, signatures: state.base === base ? state.signatures : {}, fetchedAt: Date.now() });
    const signatures = await signaturesOf(got.library);
    if (state.library === got.library) set({ ...state, signatures });
  })().finally(() => {
    if (inFlight?.done === done) inFlight = undefined;
  });
  inFlight = { base: libraryBase(), done };
  return done;
}

/** The signatures again (a signer was trusted or forgotten). */
export async function recheckSignatures(): Promise<void> {
  const lib = state.library;
  if (!lib) return;
  const signatures = await signaturesOf(lib);
  if (state.library === lib) set({ ...state, signatures });
}

/** Tests. */
export function resetLibrary(): void {
  inFlight = undefined;
  set(IDLE);
}

// ---- copies ----

/** Whether the entry can be opened (a signedOnly library opens signed, unchanged runbooks only). */
export function openableReason(lib: Pick<Library, 'signedOnly'>, entry: LibraryEntry, sig: SignatureState | undefined): string | undefined {
  if (entry.text === undefined) return entry.error ?? t.libraryUnreadable;
  if (!lib.signedOnly) return undefined;
  if (!sig) return t.libraryChecking;
  return isSignedIntact(sig) ? undefined : t.librarySignedOnly(sig.kind);
}

const refOf = (base: string, entry: LibraryEntry & { text: string; hash: string }) => ({
  base,
  path: entry.path,
  hash: entry.hash,
  bare: textHash(clearOutputBlocks(entry.text)),
});

/**
 * Open a library runbook: the user's copy when they have one, else a new copy of the library's
 * text. A signedOnly library refuses unsigned or changed runbooks (checked here, not only in the list).
 */
export async function openLibraryRunbook(
  lib: Library,
  entry: LibraryEntry,
): Promise<{ kind: 'opened'; runbook: Runbook } | { kind: 'error'; message: string }> {
  await loadRunbooks();
  const mine = libraryCopy(lib.base, entry.path);
  if (mine) return { kind: 'opened', runbook: mine };
  if (entry.text === undefined || entry.hash === undefined) return { kind: 'error', message: entry.error ?? t.libraryUnreadable };
  const why = openableReason(lib, entry, await signatureState(entry.text, trustedSigners()));
  if (why) return { kind: 'error', message: why };
  return {
    kind: 'opened',
    runbook: addLibraryCopy(entry.fileName, entry.text, refOf(lib.base, { ...entry, text: entry.text, hash: entry.hash })),
  };
}

/** A copy against the library's file now: up to date, a newer version, or one the user skipped. */
export function copyStatus(copy: Runbook, entry: LibraryEntry): 'current' | 'update' | 'kept' {
  if (!copy.library || entry.hash === undefined || entry.hash === copy.library.hash) return 'current';
  return entry.hash === copy.library.kept ? 'kept' : 'update';
}

/**
 * The library's new text with the copy's outputs: each output block (and its history) goes with
 * the block that ran, when that block is still there unchanged (same fence and code). `lost`
 * counts the outputs whose block changed or went away.
 */
export function carryOutputs(mine: string, theirs: string): { text: string; lost: number } {
  const old = parse(mine);
  const outputs = new Map<string, { meta: Record<string, unknown>; used: boolean }[]>();
  for (const c of old.cells) {
    if (c.kind !== 'code' || !isCodeMeta(c.meta) || !c.meta.output) continue;
    const k = `${c.meta.info}\n${c.value}`;
    outputs.set(k, [...(outputs.get(k) ?? []), { meta: { output: c.meta.output, history: c.meta.history }, used: false }]);
  }
  if (outputs.size === 0) return { text: theirs, lost: 0 };
  const doc = parse(theirs);
  const cells: CellInput[] = toCellInputs(doc).map((c, i) => {
    const p = doc.cells[i]!;
    if (p.kind !== 'code' || !isCodeMeta(p.meta)) return c;
    const o = outputs.get(`${p.meta.info}\n${p.value}`)?.find((x) => !x.used);
    if (!o) return c;
    o.used = true;
    return { ...c, meta: { ...p.meta, ...o.meta }, output: { kind: 'preserved' } };
  });
  const lost = [...outputs.values()].flat().filter((o) => !o.used).length;
  return { text: serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS), lost };
}

export type UpdateWarning =
  | { kind: 'lost-outputs'; count: number }
  /** The copy has edits of its own (ticked boxes, changed text): the update replaces them. */
  | { kind: 'own-edits' }
  | { kind: 'signature-dropped'; was: string }
  | { kind: 'other-signer'; was: string; now: string }
  | { kind: 'signature-broken'; was: string };

/** The key of a block's first signature, to notice a re-signing by another key under the same name. */
const signerKey = (sig: string): string | undefined => {
  const s = parseSshsig(sig);
  return s ? Array.from(s.publicKey, (b) => b.toString(16).padStart(2, '0')).join('') : undefined;
};

/** What Update would do to the copy: the new text and what the user should know first. */
export function planUpdate(
  copy: Runbook,
  entry: LibraryEntry & { text: string },
  next: SignatureState,
): { text: string; warnings: UpdateWarning[] } {
  const { text, lost } = carryOutputs(copy.text, entry.text);
  const warnings: UpdateWarning[] = [];
  if (lost > 0) warnings.push({ kind: 'lost-outputs', count: lost });
  if (copy.library && textHash(clearOutputBlocks(copy.text)) !== copy.library.bare) warnings.push({ kind: 'own-edits' });
  const was = readSignature(copy.text);
  const now = readSignature(entry.text);
  if (was) {
    if (!now) warnings.push({ kind: 'signature-dropped', was: was.signer });
    else if (now.signer !== was.signer || signerKey(now.signature) !== signerKey(was.signature))
      warnings.push({ kind: 'other-signer', was: was.signer, now: now.signer });
    else if (next.kind === 'changed' || next.kind === 'invalid') warnings.push({ kind: 'signature-broken', was: was.signer });
  }
  return { text, warnings };
}

/** Update the copy to the library's version (after planUpdate, and the user's yes to its warnings). */
export function applyUpdate(copyId: string, base: string, entry: LibraryEntry & { text: string; hash: string }, text: string): void {
  if (!getRunbook(copyId)) return;
  updateRunbookText(copyId, text);
  setLibraryRef(copyId, refOf(base, entry));
}

/** Keep mine: no "Update available" for this version of the library's file. */
export function keepMine(copyId: string, entry: LibraryEntry): void {
  const copy = getRunbook(copyId);
  if (copy?.library && entry.hash) setLibraryRef(copyId, { ...copy.library, kept: entry.hash });
}

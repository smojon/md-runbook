/**
 * The team library: runbooks in a folder on a web server that every user of the app sees, without
 * uploading anything. The web app's container serves its `runbooks/` folder at /runbooks/ (on the
 * web the library is there by default); the phones, or a web app elsewhere, use the address set
 * in Hosts & settings (or added by a mdrunbook://library?url=… link or QR code).
 *
 * The folder's files come from its `index.json` when there is one (titles, folders, signedOnly),
 * else from the server's listing of the folder (nginx `autoindex_format json`), subfolders as
 * groups. An `allowed_signers` file next to them is offered to trust, for this library only
 * (signing/trust.ts). The app remembers per library the highest signed version of each name
 * and whether it asked for signedOnly (LibraryMemory).
 *
 * Opening a library runbook makes the user's own copy (source 'library'): runs and outputs stay
 * theirs, the shared file is never changed. When the library's file changes, the copy offers
 * Update (outputs of unchanged blocks are kept) or Keep mine.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { DEFAULT_WRITE_OPTIONS, clearOutputBlocks, isCodeMeta, parse, serialize, toCellInputs } from '@md-runbook/core';
import type { CellInput } from '@md-runbook/core';
import { readSignature, signedStatus } from '@md-runbook/core/signing';
import { runbookTitle } from '@md-runbook/core/title';
import { t } from '../i18n';
import { loadSettings, libraryUrlSetting } from '../settings/store';
import { getJson, setJson } from '../storage/kv';
import {
  AllowedSigner,
  SignatureState,
  TrustedSigner,
  isExpired,
  isVerified,
  loadTrustedSigners,
  manifestOf,
  parseAllowedSigners,
  sameSigner,
  shownName,
  signatureState,
  trustedFor,
  useTrustedSigners,
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

/** Control characters (C0, DEL) and bidi controls: refused anywhere in an address. */
const hasControl = (s: string): boolean =>
  [...s].some((c) => {
    const n = c.codePointAt(0)!;
    return n < 0x20 || n === 0x7f || (n >= 0x200e && n <= 0x200f) || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069);
  });

/**
 * Why this can't be a library address, or undefined: https only (http for this machine), no
 * user name or password, no query or fragment. Backslashes, blanks and control characters are
 * refused before parsing: URL parsers disagree on them (a backslash is a slash to the web's
 * parser, not to every phone's), so the host shown could differ from the host fetched.
 */
export function libraryUrlProblem(url: string): string | undefined {
  const s = url.trim();
  if (/[\s\\]/.test(s) || hasControl(s)) return t.libraryUrlInvalid;
  // user:password@ before the host, whatever a parser would make of it.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(s)) return t.libraryUrlUserinfo;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return t.libraryUrlInvalid;
  }
  if (u.username || u.password) return t.libraryUrlUserinfo;
  if (u.protocol === 'https:') return u.search || u.hash ? t.libraryUrlInvalid : undefined;
  if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))
    return u.search || u.hash ? t.libraryUrlInvalid : undefined;
  return t.libraryUrlHttps;
}

/**
 * The address as the app stores, fetches and shows it: the parsed URL's own form (`href`: host in
 * lower case and punycode, the path normalised), as a folder (ends with /). Check it with
 * libraryUrlProblem first.
 */
export function normalizeLibraryUrl(url: string): string {
  const s = url.trim();
  let href: string;
  try {
    href = new URL(s).href;
  } catch {
    href = s;
  }
  return href.endsWith('/') ? href : href + '/';
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

/** The host a library address names, as the prompts show it (the parsed URL's, as fetched). */
export function libraryHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
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
  /** Open verified runbooks only: index.json's signedOnly, or kept on by the app (signedOnlyDropped). */
  signedOnly: boolean;
  /** index.json no longer asks for signedOnly, but this library did before: the app keeps it on until the user agrees. */
  signedOnlyDropped?: boolean;
  entries: LibraryEntry[];
  /** The library's allowed_signers: read (an empty list when it has none), undefined when it couldn't be read. */
  signers?: { list: AllowedSigner[]; skipped: number };
}

export type LibraryFetch = { kind: 'none' } | { kind: 'error'; message: string } | { kind: 'ok'; library: Library };

const urlOf = (base: string, path: string): string => base + path.split('/').map(encodeURIComponent).join('/');
/**
 * An HTML page where JSON or a file was asked for (a single-page app's fallback). Only a page that
 * says so: a runbook may start with `<!-- … -->` or `<img …>`.
 */
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
  /** Why it was not taken (a redirect to another server). */
  error?: string;
}

/** The body, at most `cap` bytes: read as a stream where the runtime has one (browsers), cut off past the cap. */
async function readCapped(res: Response, cap: number): Promise<string | undefined> {
  const reader = typeof res.body?.getReader === 'function' ? res.body.getReader() : undefined;
  if (!reader) {
    const text = await res.text();
    return new TextEncoder().encode(text).length > cap ? undefined : text;
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > cap) {
      void reader.cancel().catch(() => undefined);
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * React Native's fetch has no streams (whatwg-fetch over XMLHttpRequest reads the whole body
 * first): there the library is read with XMLHttpRequest, whose progress events let a body past
 * the cap be stopped while it arrives.
 */
function xhrGet(url: string, cap: number): Promise<Got & { url?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let over = false;
    xhr.open('GET', url);
    xhr.setRequestHeader('Cache-Control', 'no-cache');
    xhr.responseType = 'text';
    xhr.onprogress = (e: ProgressEvent) => {
      if (e.loaded > cap && !over) {
        over = true;
        xhr.abort();
        resolve({ status: 413 });
      }
    };
    xhr.onload = () => {
      if (over) return;
      const status = xhr.status;
      const text: string = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      const ok = status >= 200 && status < 300;
      resolve({
        status,
        url: xhr.responseURL || undefined,
        ...(ok ? (new TextEncoder().encode(text).length > cap ? { status: 413 } : { text }) : {}),
      });
    };
    xhr.onerror = () => !over && reject(new TypeError('Network request failed'));
    xhr.ontimeout = () => !over && reject(new TypeError('Network request timed out'));
    xhr.onabort = () => !over && reject(new TypeError('Network request aborted'));
    xhr.send();
  });
}

/** Read one file of the library: refused past MAX_RUNBOOK_BYTES, or when a redirect took it to another server. */
async function getText(fetcher: typeof fetch | undefined, url: string): Promise<Got> {
  if (!fetcher && Platform.OS !== 'web' && typeof XMLHttpRequest !== 'undefined') {
    const got = await xhrGet(url, MAX_RUNBOOK_BYTES);
    if (got.url && originOf(got.url) !== originOf(url)) return { status: 0, error: t.libraryRedirected(libraryHost(got.url)) };
    return got.text === undefined ? { status: got.status } : { status: got.status, text: got.text };
  }
  const res = await (fetcher ?? fetch)(url, { cache: 'no-cache' });
  // Followed redirects stay on the library's server: the host the app names is the one that served the text.
  if (typeof res.url === 'string' && res.url !== '' && originOf(res.url) !== originOf(url)) {
    return { status: 0, error: t.libraryRedirected(libraryHost(res.url)) };
  }
  if (!res.ok) return { status: res.status };
  if (Number(res.headers?.get('content-length') ?? 0) > MAX_RUNBOOK_BYTES) return { status: 413 };
  const text = await readCapped(res, MAX_RUNBOOK_BYTES);
  return text === undefined ? { status: 413 } : { status: res.status, text };
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
async function listLibrary(
  base: string,
  fetcher: typeof fetch | undefined,
): Promise<{ index: LibraryIndex; allowedSigners?: boolean } | LibraryFetch> {
  const idx = await getText(fetcher, base + 'index.json');
  if (idx.error) return { kind: 'error', message: idx.error };
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
    if (res.error) throw new Error(res.error);
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

/**
 * Read the library at `base`: its runbooks' texts, titles and folders, and its allowed_signers.
 * `fetcher`: tests; by default the browser's fetch, or XMLHttpRequest on the phones (getText).
 */
export async function fetchLibrary(base: string, fetcher?: typeof fetch): Promise<LibraryFetch> {
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
            error: got.error ?? (got.status === 413 ? t.fileTooLarge(fileName) : `HTTP ${got.status}`),
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
  // The library publishes no signers (none listed, 404): an empty list, so keys trusted from it
  // before stop counting. A failed read (offline, a server error) leaves it unknown.
  let signers: Library['signers'] = listed.allowedSigners === false ? { list: [], skipped: 0 } : undefined;
  if (listed.allowedSigners !== false) {
    try {
      const got = await getText(fetcher, base + 'allowed_signers');
      if (got.text !== undefined && !looksHtml(got.text)) {
        const parsed = parseAllowedSigners(got.text);
        signers = { list: parsed.signers, skipped: parsed.skipped };
      } else if (!got.error && (got.status === 404 || got.status === 410 || got.text !== undefined)) {
        signers = { list: [], skipped: 0 };
      }
    } catch {
      signers = undefined;
    }
  }
  return { kind: 'ok', library: { base, signedOnly: index.signedOnly, entries, ...(signers ? { signers } : {}) } };
}

// ---- what the app remembers of each library: the highest signed versions, signedOnly ----

/**
 * Per library address: the highest version of each signed name seen with a signature that
 * checked out (a lower one later is a downgrade, as the gate's version floors), and whether the
 * library ever asked for signedOnly (kept on when index.json stops asking, until the user agrees).
 */
interface LibraryMemory {
  versions: Record<string, Record<string, number>>;
  signedOnly: string[];
}
const MEMORY_KEY = 'library.memory.v1';
const isMemory = (v: unknown): v is LibraryMemory =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as LibraryMemory).versions === 'object' &&
  (v as LibraryMemory).versions !== null &&
  Object.values((v as LibraryMemory).versions).every(
    (m) => typeof m === 'object' && m !== null && Object.values(m).every((n) => typeof n === 'number'),
  ) &&
  Array.isArray((v as LibraryMemory).signedOnly) &&
  (v as LibraryMemory).signedOnly.every((b) => typeof b === 'string');

let memory: LibraryMemory = { versions: {}, signedOnly: [] };
let memoryLoaded: Promise<void> | undefined;

function loadLibraryMemory(): Promise<void> {
  return (memoryLoaded ??= (async () => {
    memory = (await getJson(MEMORY_KEY, isMemory)) ?? memory;
  })());
}

function saveMemory(next: LibraryMemory): void {
  memory = next;
  void setJson(MEMORY_KEY, memory).catch(() => undefined);
}

/** The highest version of `name` seen from the library at `base`, with a signature that checked out. */
export const highestVersion = (base: string, name: string): number | undefined => memory.versions[base]?.[name];

/** Remember the versions of these states whose signatures checked out (a forged manifest can't raise the floor). */
function noteVersions(base: string, states: readonly SignatureState[]): void {
  const mine = { ...(memory.versions[base] ?? {}) };
  let changed = false;
  for (const s of states) {
    if (!('verified' in s) || s.verified.length === 0) continue;
    const { name, version } = s.manifest;
    if ((mine[name] ?? 0) < version) {
      mine[name] = version;
      changed = true;
    }
  }
  if (changed) saveMemory({ ...memory, versions: { ...memory.versions, [base]: mine } });
}

/** The higher version seen before, when the state's signed version is lower (a downgrade). */
export function olderThanSeen(base: string, s: SignatureState | undefined): number | undefined {
  const m = manifestOf(s);
  const seen = m ? highestVersion(base, m.name) : undefined;
  return m && seen !== undefined && m.version < seen ? seen : undefined;
}

/** The library with the signedOnly the app keeps: once a library asked for it, it stays on until the user agrees. */
function withPolicy(lib: Library): Library {
  if (lib.signedOnly) {
    if (!memory.signedOnly.includes(lib.base)) saveMemory({ ...memory, signedOnly: [...memory.signedOnly, lib.base] });
    return lib;
  }
  return memory.signedOnly.includes(lib.base) ? { ...lib, signedOnly: true, signedOnlyDropped: true } : lib;
}

/** The user agreed: the library at `base` opens unverified runbooks again (its index.json no longer asks for signedOnly). */
export function allowUnverified(base: string): void {
  saveMemory({ ...memory, signedOnly: memory.signedOnly.filter((b) => b !== base) });
  const lib = state.library;
  if (lib?.base === base && lib.signedOnlyDropped) {
    set({ ...state, library: { ...lib, signedOnly: false, signedOnlyDropped: false } });
  }
}

// ---- the library the list shows ----

export interface LibraryState {
  /** The address read ('' when there is none). */
  base: string;
  status: 'idle' | 'loading' | 'ready' | 'none' | 'error';
  library?: Library;
  error?: string;
  /**
   * Each runbook's signature, by the hash of the text it was computed from (entry.hash): a text
   * that changed has no state until it is checked, never the previous version's.
   */
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

/** The entry's signature state, if it was computed from the entry's text as it is now. */
export const signatureOf = (s: LibraryState, entry: LibraryEntry): SignatureState | undefined =>
  entry.hash === undefined ? undefined : s.signatures[entry.hash];

/**
 * The keys a library's runbooks are checked against: those trusted from that library, and of
 * those, only the ones it still publishes (a key the team removed from allowed_signers stops
 * counting) once its allowed_signers was read.
 */
export function libraryKeys(lib: Pick<Library, 'base' | 'signers'>): TrustedSigner[] {
  const mine = trustedFor(lib.base);
  const published = lib.signers?.list;
  return published ? mine.filter((k) => published.some((s) => sameSigner(s, k))) : mine;
}

/** Keys trusted from this library that its allowed_signers no longer lists (offered to remove). */
export function withdrawnKeys(lib: Pick<Library, 'base' | 'signers'>): TrustedSigner[] {
  const published = lib.signers?.list;
  return published ? trustedFor(lib.base).filter((k) => !published.some((s) => sameSigner(s, k))) : [];
}

async function signaturesOf(library: Library): Promise<Record<string, SignatureState>> {
  const out: Record<string, SignatureState> = {};
  const keys = libraryKeys(library);
  for (const e of library.entries)
    if (e.text !== undefined && e.hash !== undefined && !out[e.hash]) out[e.hash] = await signatureState(e.text, keys);
  noteVersions(library.base, Object.values(out));
  return out;
}

/** The states still true for the new texts: those of texts that didn't change. */
const keptFor = (signatures: Readonly<Record<string, SignatureState>>, library: Library): Record<string, SignatureState> =>
  Object.fromEntries(library.entries.flatMap((e) => (e.hash && signatures[e.hash] ? [[e.hash, signatures[e.hash]!]] : [])));

/**
 * Read the library (on start, on pull to refresh). Within LIBRARY_CACHE_MS of the last read
 * nothing is fetched unless `force`. A library that's gone (404) leaves no section and no error.
 */
export function refreshLibrary(opts: { force?: boolean; fetcher?: typeof fetch } = {}): Promise<void> {
  if (inFlight) return inFlight.base === libraryBase() ? inFlight.done : inFlight.done.then(() => refreshLibrary(opts));
  const done = (async () => {
    await Promise.all([loadSettings(), loadTrustedSigners(), loadRunbooks(), loadLibraryMemory()]);
    const base = libraryBase() ?? '';
    if (!base) return set({ ...IDLE });
    const fresh = state.base === base && state.fetchedAt !== undefined && Date.now() - state.fetchedAt < LIBRARY_CACHE_MS;
    if (fresh && !opts.force) return;
    set({
      ...(state.base === base ? state : { ...IDLE, base }),
      status: state.base === base && state.library ? state.status : 'loading',
      busy: true,
    });
    const got = await fetchLibrary(base, opts.fetcher);
    if (libraryBase() !== base) return set({ ...state, busy: false });
    if (got.kind === 'none') return set({ base, status: 'none', signatures: {}, fetchedAt: Date.now() });
    // Offline or a server error: what was read before stays listed.
    if (got.kind === 'error')
      return set({ ...state, base, status: state.library ? 'ready' : 'error', error: got.message, fetchedAt: Date.now(), busy: false });
    const library = withPolicy(got.library);
    set({
      base,
      status: 'ready',
      library,
      signatures: state.base === base ? keptFor(state.signatures, library) : {},
      fetchedAt: Date.now(),
    });
    const signatures = await signaturesOf(library);
    if (state.library === library) set({ ...state, signatures });
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
  memory = { versions: {}, signedOnly: [] };
  memoryLoaded = undefined;
  set(IDLE);
}

// ---- what a library runbook's signature says, for the list and the opened copy ----

/** The file name without `.md`, as signPlan makes a default signed name (only the last part is compared). */
const nameOfPath = (path: string): string =>
  (path.split('/').pop() ?? '')
    .replace(/(\.runbook)?\.(md|markdown)$/i, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .toLowerCase();

/** Whether the signed name fits the file it is served as (its last part is the file's name): `ops/restart` fits `restart.md`. */
export const nameFitsPath = (name: string, path: string): boolean => (name.split('/').pop() ?? '').toLowerCase() === nameOfPath(path);

export interface SignedFacts {
  name: string;
  version: number;
  /** The signed name is not this file's (a signed runbook served under another name). */
  otherName: boolean;
  /** A higher version of this name was seen from this library before. */
  olderThan?: number;
  /** The manifest's expiry day, when it is over. */
  expired?: string;
}

/** The signed name, version, expiry and downgrade of a library runbook's state (undefined: not signed and unchanged). */
export function signedFacts(base: string, path: string, s: SignatureState | undefined, now = Date.now()): SignedFacts | undefined {
  const m = manifestOf(s);
  if (!m) return undefined;
  const older = olderThanSeen(base, s);
  return {
    name: m.name,
    version: m.version,
    otherName: !nameFitsPath(m.name, path),
    ...(older !== undefined ? { olderThan: older } : {}),
    ...(isExpired(m.expires, now) ? { expired: m.expires! } : {}),
  };
}

/** Whether the list may show the state as verified (green): verified, under its own name, not a downgrade. */
export const looksVerified = (s: SignatureState | undefined, facts: SignedFacts | undefined): boolean =>
  isVerified(s) && !facts?.otherName && facts?.olderThan === undefined;

/**
 * A library copy's signature state, as the list computes it for the library's file: the opened
 * copy's banner shows the same label (screens/RunbookView.tsx), checked against the keys trusted
 * from the copy's library.
 */
export function useLibraryCopyState(
  copy: Runbook | undefined,
): { base: string; state: SignatureState; facts: SignedFacts | undefined; signedOnly: boolean } | undefined {
  const lib = useLibrary();
  const trusted = useTrustedSigners();
  const ref = copy?.source === 'library' ? copy.library : undefined;
  const text = ref ? copy?.text : undefined;
  const library = ref && lib.library?.base === ref.base ? lib.library : undefined;
  const [got, setGot] = useState<{ text: string; state: SignatureState } | undefined>();
  useEffect(() => {
    if (!ref || text === undefined) return;
    let live = true;
    void signatureState(text, libraryKeys(library ?? { base: ref.base })).then((state) => {
      if (live) setGot({ text, state });
    });
    return () => {
      live = false;
    };
  }, [ref, text, library, trusted]);
  if (!ref || !got || got.text !== text) return undefined;
  return { base: ref.base, state: got.state, facts: signedFacts(ref.base, ref.path, got.state), signedOnly: library?.signedOnly ?? false };
}

// ---- copies ----

/**
 * Whether the entry can be opened. A signedOnly library opens verified runbooks only: signed by a
 * signer trusted for this library, every runnable block covered, not expired, not older than a
 * version seen before.
 */
export function openableReason(
  lib: Pick<Library, 'base' | 'signedOnly'>,
  entry: Pick<LibraryEntry, 'text' | 'error'>,
  sig: SignatureState | undefined,
): string | undefined {
  if (entry.text === undefined) return entry.error ?? t.libraryUnreadable;
  if (!lib.signedOnly) return undefined;
  if (!sig) return t.libraryChecking;
  if (!isVerified(sig)) return t.librarySignedOnly(sig);
  const older = olderThanSeen(lib.base, sig);
  return older !== undefined ? t.librarySignedOnlyOlder(sig.manifest.version, older) : undefined;
}

const refOf = (base: string, entry: LibraryEntry & { text: string; hash: string }) => ({
  base,
  path: entry.path,
  hash: entry.hash,
  bare: textHash(clearOutputBlocks(entry.text)),
});

/**
 * Open a library runbook: the user's copy when they have one, else a new copy of the library's
 * text. A signedOnly library opens verified runbooks only: checked here on the text itself (not
 * only in the list), the user's copy included.
 */
export async function openLibraryRunbook(
  lib: Library,
  entry: LibraryEntry,
): Promise<{ kind: 'opened'; runbook: Runbook } | { kind: 'error'; message: string }> {
  await Promise.all([loadRunbooks(), loadLibraryMemory()]);
  const keys = libraryKeys(lib);
  const mine = libraryCopy(lib.base, entry.path);
  if (mine) {
    const why = lib.signedOnly ? openableReason(lib, mine, await signatureState(mine.text, keys)) : undefined;
    return why ? { kind: 'error', message: t.libraryCopyRefused(why) } : { kind: 'opened', runbook: mine };
  }
  if (entry.text === undefined || entry.hash === undefined) return { kind: 'error', message: entry.error ?? t.libraryUnreadable };
  const why = openableReason(lib, entry, await signatureState(entry.text, keys));
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
  | { kind: 'signature-broken'; was: string }
  /** The new version's signature leaves runnable blocks uncovered. */
  | { kind: 'partly-signed'; count: number }
  | { kind: 'expired'; on: string }
  /** The new version is signed with a lower version than the copy's, or than one seen before. */
  | { kind: 'older-version'; name: string; now: number; seen: number };

/** The key of a block's first signature, to notice a re-signing by another key under the same name. */
const signerKey = (sig: string): string | undefined => {
  const s = parseSshsig(sig);
  return s ? Array.from(s.publicKey, (b) => b.toString(16).padStart(2, '0')).join('') : undefined;
};

/**
 * What Update would do to the copy: the new text and what the user should know first. `next`:
 * the new text's state, computed for this update (never one kept from an earlier read);
 * `seen`: the highest version of its signed name seen from the library (highestVersion).
 */
export function planUpdate(
  copy: Runbook,
  entry: LibraryEntry & { text: string },
  next: SignatureState,
  seen?: number,
): { text: string; warnings: UpdateWarning[] } {
  const { text, lost } = carryOutputs(copy.text, entry.text);
  const warnings: UpdateWarning[] = [];
  if (lost > 0) warnings.push({ kind: 'lost-outputs', count: lost });
  if (copy.library && textHash(clearOutputBlocks(copy.text)) !== copy.library.bare) warnings.push({ kind: 'own-edits' });
  const was = readSignature(copy.text);
  const now = readSignature(entry.text);
  if (was) {
    if (!now) warnings.push({ kind: 'signature-dropped', was: shownName(was.signer) });
    else if (now.signer !== was.signer || signerKey(now.signature) !== signerKey(was.signature))
      warnings.push({ kind: 'other-signer', was: shownName(was.signer), now: shownName(now.signer) });
    else if (next.kind === 'changed' || next.kind === 'invalid') warnings.push({ kind: 'signature-broken', was: shownName(was.signer) });
  }
  if (next.kind === 'partial') warnings.push({ kind: 'partly-signed', count: next.unsigned });
  const m = manifestOf(next);
  if (m?.expires && isExpired(m.expires)) warnings.push({ kind: 'expired', on: m.expires });
  if (m) {
    const mine = signedStatus(copy.text)?.manifest;
    const floor = Math.max(seen ?? 0, mine?.name === m.name ? mine.version : 0);
    if (m.version < floor) warnings.push({ kind: 'older-version', name: m.name, now: m.version, seen: floor });
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

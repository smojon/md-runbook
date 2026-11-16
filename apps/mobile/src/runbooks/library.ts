/**
 * The team library: runbooks in a folder on a web server that every user of the app sees, without
 * uploading anything. The web app's container serves its `runbooks/` folder at /runbooks/ (on the
 * web the library is there by default); the phones, or a web app elsewhere, use the address set
 * in Hosts & settings (or added by a mdrunbook://library?url=… link or QR code).
 *
 * The folder's files come from its `index.json` when there is one (titles, folders, signedOnly),
 * else from the server's listing of the folder (nginx `autoindex_format json`), subfolders as
 * groups. An `allowed_signers` file next to them is offered to trust, for this library only
 * (signing/trust.ts: the one list of trusted signers). The app remembers per library the highest
 * signed version of each runbook (path and signed name) and whether it asked for signedOnly
 * (LibraryMemory).
 *
 * Opening a library runbook makes the user's own copy (source 'library'): runs and outputs stay
 * theirs, the shared file is never changed. When the library's file changes, the copy offers
 * Update (outputs of unchanged blocks are kept) or Keep mine.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { DEFAULT_WRITE_OPTIONS, clearOutputBlocks, isCodeMeta, parse, serialize, toCellInputs } from '@md-runbook/core';
import type { CellInput } from '@md-runbook/core';
import { SIGNATURE_NAMESPACE, readSignature, signedStatus } from '@md-runbook/core/signing';
import { sha256Hex } from '@md-runbook/core/sha256';
import { runbookTitle } from '@md-runbook/core/title';
import type { LibraryIndex } from '@md-runbook/core/library';
import {
  MAX_LIBRARY_FILES,
  isMarkdownPath,
  libraryFileUrl,
  libraryPathOk,
  libraryUrlProblemKind,
  nameFitsPath,
  normalizeLibraryUrl,
  parseAutoindex,
  parseIndexJson,
} from '@md-runbook/core/library';
import { t } from '../i18n';
import { loadSettings, libraryUrlSetting } from '../settings/store';
import { DEFAULT_LIBRARY_PATH, loadRuntimeConfig, pageOrigin, runtimeConfig } from '../settings/runtimeConfig';
import { fromPublicUrl } from '../settings/publicAddress';
import { getJson, setJson } from '../storage/kv';
import {
  AllowedSigner,
  SignatureState,
  TrustedSigner,
  addedByYou,
  isAddedByYou,
  isExpired,
  isVerified,
  keysFor,
  keysId,
  loadTrustedSigners,
  manifestOf,
  noteWithdrawn,
  parseAllowedSigners,
  sameSigner,
  shownName,
  signatureState,
  trustedFor,
  useTrustedSigners,
} from '../signing/trust';
import { parseSshsig } from '../signing/verify';
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

export type { LibraryFile, LibraryIndex } from '@md-runbook/core/library';
export { MAX_LIBRARY_FILES, libraryFileUrl, nameFitsPath, normalizeLibraryUrl, parseAutoindex, parseIndexJson };

/** At most this many folder levels are read from a library (and MAX_LIBRARY_FILES runbooks). */
const MAX_DEPTH = 3;
/** A library fetched less than this long ago is not fetched again on start (pull to refresh does). */
export const LIBRARY_CACHE_MS = 60_000;
/** One read may take this long (a server that stalls doesn't hold up every later refresh). */
export const LIBRARY_TIMEOUT_MS = 30_000;
/** At most this much text is read from one library, all its runbooks together (characters). */
export const MAX_LIBRARY_CHARS = 20 * 1024 * 1024;

/**
 * SHA-256 (hex) of a library text: what the signature states, copies and updates are keyed by.
 * Never a short hash (runbooks/origin.ts textHash) that another text could be made to share.
 */
export const libraryHash = (text: string): string => sha256Hex(text);

// ---- the address ----

/**
 * Why this can't be a library address, or undefined: https only (http for this machine), no
 * user name or password, no query or fragment (core's libraryUrlProblemKind, in the app's words).
 */
export function libraryUrlProblem(url: string): string | undefined {
  const kind = libraryUrlProblemKind(url);
  return kind === 'invalid'
    ? t.libraryUrlInvalid
    : kind === 'userinfo'
      ? t.libraryUrlUserinfo
      : kind === 'https'
        ? t.libraryUrlHttps
        : undefined;
}

/**
 * On the web: the app's own library folder, /runbooks/ or the container's MD_RUNBOOK_LIBRARY
 * (/config.json, settings/runtimeConfig.ts); none on the phones.
 */
export function defaultLibraryBase(): string | undefined {
  if (Platform.OS !== 'web') return undefined;
  const origin = pageOrigin();
  return origin ? `${origin}${runtimeConfig().library ?? DEFAULT_LIBRARY_PATH}` : undefined;
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

const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/');

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

/** The address of the library file at `path` (as fetched: a runbook link to it names this). */
const urlOf = libraryFileUrl;

/**
 * The library runbook an address names, or undefined: an address under the library the app reads
 * (or under the web app's public address for it: settings/publicAddress.ts), of a Markdown file
 * at a path the library could list. Query and fragment are not part of a library file's address.
 */
export function libraryTarget(url: string): { base: string; path: string } | undefined {
  const base = libraryBase();
  if (!base) return undefined;
  let u: URL;
  try {
    u = new URL(fromPublicUrl(url.trim()));
  } catch {
    return undefined;
  }
  if (u.search || u.hash) return undefined;
  const href = u.href;
  if (!href.startsWith(base)) return undefined;
  let path: string;
  try {
    path = href.slice(base.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    return undefined;
  }
  return libraryPathOk(path) && isMarkdownPath(path) && urlOf(base, path) === href ? { base, path } : undefined;
}

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

/**
 * Why an answer can't be taken as the library's, or undefined: it came from another server; or,
 * a 2xx answer, it doesn't say where it came from (no final address, or one that can't be read),
 * so it could have been redirected anywhere.
 */
export function redirectedAway(status: number, finalUrl: string | undefined, asked: string): string | undefined {
  const from = finalUrl ? originOf(finalUrl) : undefined;
  if (from !== undefined && from === originOf(asked)) return undefined;
  if (from !== undefined) return t.libraryRedirected(libraryHost(finalUrl!));
  return status >= 200 && status < 300 ? t.libraryNoFinalUrl : undefined;
}

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
    xhr.timeout = LIBRARY_TIMEOUT_MS;
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
    const away = redirectedAway(got.status, got.url, url);
    if (away) return { status: 0, error: away };
    return got.text === undefined ? { status: got.status } : { status: got.status, text: got.text };
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LIBRARY_TIMEOUT_MS);
  try {
    const res = await (fetcher ?? fetch)(url, { cache: 'no-cache', signal: abort.signal });
    // Followed redirects stay on the library's server: the host the app names is the one that served the text.
    const away = redirectedAway(res.status, typeof res.url === 'string' ? res.url : undefined, url);
    if (away) return { status: 0, error: away };
    if (!res.ok) return { status: res.status };
    if (Number(res.headers?.get('content-length') ?? 0) > MAX_RUNBOOK_BYTES) return { status: 413 };
    const text = await readCapped(res, MAX_RUNBOOK_BYTES);
    return text === undefined ? { status: 413 } : { status: res.status, text };
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
  /** Text read so far: past MAX_LIBRARY_CHARS the rest is not read. */
  let total = 0;
  const worker = async (): Promise<void> => {
    while (next < index.files.length) {
      const i = next++;
      const f = index.files[i]!;
      const fileName = f.path.split('/').pop()!;
      const folder = f.folder ?? dirOf(f.path);
      const fallback = f.title ?? fileName.replace(/\.(md|markdown)$/i, '');
      if (total > MAX_LIBRARY_CHARS) {
        entries[i] = { path: f.path, fileName, folder, title: fallback, error: t.libraryTooLarge };
        continue;
      }
      try {
        const got = await getText(fetcher, urlOf(base, f.path));
        total += got.text?.length ?? 0;
        if (got.text !== undefined && total > MAX_LIBRARY_CHARS) {
          entries[i] = { path: f.path, fileName, folder, title: fallback, error: t.libraryTooLarge };
        } else if (got.text === undefined || looksHtml(got.text)) {
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
            hash: libraryHash(got.text),
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
        const parsed = parseAllowedSigners(got.text, SIGNATURE_NAMESPACE);
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
 * Per library address: the highest version of each runbook seen with a signature that checked
 * out, by its path and signed name together (floorKey: two files signed `restore` in different
 * folders don't share a floor; a lower version later is a downgrade, as the gate's version
 * floors), and whether the library ever asked for signedOnly (kept on when index.json stops
 * asking, until the user agrees).
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
let memoryReady = false;

/** Read what the app remembers of the libraries (once; later calls wait for the same read). */
export function loadLibraryMemory(): Promise<void> {
  return (memoryLoaded ??= (async () => {
    memory = (await getJson(MEMORY_KEY, isMemory)) ?? memory;
    memoryReady = true;
  })());
}

function saveMemory(next: LibraryMemory): void {
  memory = next;
  void setJson(MEMORY_KEY, memory).catch(() => undefined);
}

/** A version floor's key: the file's path in the library and its signed name (a path holds no newline a name could fake). */
const floorKey = (path: string, name: string): string => `${path}\n${name}`;

/** The highest version of the runbook at `path`, signed as `name`, seen from the library at `base` with a signature that checked out. */
export const highestVersion = (base: string, path: string, name: string): number | undefined =>
  memory.versions[base]?.[floorKey(path, name)];

/** Remember the versions of these runbooks whose signatures checked out (a forged manifest can't raise the floor). */
function noteVersions(base: string, seen: readonly { path: string; state: SignatureState }[]): void {
  const mine = { ...(memory.versions[base] ?? {}) };
  let changed = false;
  for (const { path, state: s } of seen) {
    if (!('verified' in s) || s.verified.length === 0) continue;
    const { name, version } = s.manifest;
    const k = floorKey(path, name);
    if ((mine[k] ?? 0) < version) {
      mine[k] = version;
      changed = true;
    }
  }
  if (changed) saveMemory({ ...memory, versions: { ...memory.versions, [base]: mine } });
}

/** The higher version seen before at this path under this name, when the state's signed version is lower (a downgrade). */
export function olderThanSeen(base: string, path: string, s: SignatureState | undefined): number | undefined {
  const m = manifestOf(s);
  const seen = m ? highestVersion(base, path, m.name) : undefined;
  return m && seen !== undefined && m.version < seen ? seen : undefined;
}

/** Whether versions are remembered for the library at `base` (Hosts & settings offers to forget them). */
export const hasRememberedVersions = (base: string): boolean => Object.keys(memory.versions[base] ?? {}).length > 0;

/**
 * Forget the versions seen from the library at `base` (Hosts & settings → Team library): a
 * version signed too high by mistake, or a runbook renumbered, no longer holds back the ones after.
 */
export function forgetVersions(base: string): void {
  const versions = { ...memory.versions };
  delete versions[base];
  saveMemory({ ...memory, versions });
  // The rows and banners say "older than … seen before" from these: shown again.
  set({ ...state });
}

/**
 * Whether the library at `base` opens verified runbooks only: as read now, else as remembered (a
 * library that asked for it once, until the user agreed otherwise), also before it was read.
 */
export function signedOnlyPolicy(base: string): boolean {
  const lib = state.library;
  if (lib?.base === base) return lib.signedOnly;
  return memory.signedOnly.includes(base);
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
  /** The keys the signatures were checked with (keysId of libraryKeys): with other keys, none is kept. */
  keys?: string;
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
 * The keys a library's runbooks are checked against (keysFor the library): those trusted from that
 * library and not withdrawn, and those added by you. Once its allowed_signers was read, of the
 * library's own only those it still publishes, with the options it publishes them with (a
 * valid-before= or namespaces= the team added to retire a key is followed).
 */
export function libraryKeys(lib: Pick<Library, 'base' | 'signers'>): TrustedSigner[] {
  const own = keysFor(lib.base).filter((k) => !isAddedByYou(k));
  const published = lib.signers?.list;
  const fromLibrary = published
    ? own.flatMap((k) => {
        const line = published.find((s) => sameSigner(s, k));
        return line ? [{ ...line, from: k.from }] : [];
      })
    : own;
  return [...fromLibrary, ...addedByYou()];
}

/**
 * The keys a runbook is checked against: for a library copy, its library's (libraryKeys, as read
 * now when that library is the one read); for any other runbook, the keys added by you.
 */
export function runbookKeys(r: Pick<Runbook, 'source' | 'library'> | undefined): TrustedSigner[] {
  const base = r?.source === 'library' ? r.library?.base : undefined;
  if (base === undefined) return keysFor(undefined);
  return libraryKeys(state.library?.base === base ? state.library : { base });
}

/** Keys trusted from this library that its allowed_signers no longer lists, or didn't when last read (offered to remove). */
export function withdrawnKeys(lib: Pick<Library, 'base' | 'signers'>): TrustedSigner[] {
  const published = lib.signers?.list;
  return published
    ? trustedFor(lib.base).filter((k) => !published.some((s) => sameSigner(s, k)))
    : trustedFor(lib.base).filter((k) => k.withdrawn);
}

async function signaturesOf(library: Library): Promise<{ signatures: Record<string, SignatureState>; keys: string }> {
  const out: Record<string, SignatureState> = {};
  const keys = libraryKeys(library);
  for (const e of library.entries)
    if (e.text !== undefined && e.hash !== undefined && !out[e.hash]) out[e.hash] = await signatureState(e.text, keys);
  noteVersions(
    library.base,
    library.entries.flatMap((e) => (e.hash !== undefined && out[e.hash] ? [{ path: e.path, state: out[e.hash]! }] : [])),
  );
  return { signatures: out, keys: keysId(keys) };
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
    // The container's library folder (MD_RUNBOOK_LIBRARY) comes with /config.json.
    await Promise.all([loadSettings(), loadTrustedSigners(), loadRunbooks(), loadLibraryMemory(), loadRuntimeConfig(opts.fetcher)]);
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
    // Keys it no longer publishes are remembered as withdrawn: they don't count while it can't be read either.
    if (library.signers) noteWithdrawn(base, library.signers.list);
    const keys = keysId(libraryKeys(library));
    set({
      base,
      status: 'ready',
      library,
      // States checked with other keys (a key trusted, withdrawn or retired since) are not shown meanwhile.
      signatures: state.base === base && state.keys === keys ? keptFor(state.signatures, library) : {},
      keys,
      fetchedAt: Date.now(),
    });
    const checked = await signaturesOf(library);
    if (state.library === library) set({ ...state, ...checked });
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
  const checked = await signaturesOf(lib);
  if (state.library === lib) set({ ...state, ...checked });
}

/** Tests. */
export function resetLibrary(): void {
  inFlight = undefined;
  memory = { versions: {}, signedOnly: [] };
  memoryLoaded = undefined;
  memoryReady = false;
  set(IDLE);
}

// ---- what a library runbook's signature says, for the list and the opened copy ----

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
  const older = olderThanSeen(base, path, s);
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
): { base: string; path: string; state: SignatureState; facts: SignedFacts | undefined; signedOnly: boolean } | undefined {
  const lib = useLibrary();
  const trusted = useTrustedSigners();
  const ref = copy?.source === 'library' ? copy.library : undefined;
  const text = ref ? copy?.text : undefined;
  const library = ref && lib.library?.base === ref.base ? lib.library : undefined;
  const [got, setGot] = useState<{ text: string; state: SignatureState } | undefined>();
  useEffect(() => {
    if (!ref || text === undefined) return;
    let live = true;
    void (async () => {
      // Opened straight from the main list: the keys and the remembered policy first.
      await Promise.all([loadTrustedSigners(), loadLibraryMemory()]);
      const state = await signatureState(text, libraryKeys(library ?? { base: ref.base }));
      if (live) setGot({ text, state });
    })();
    return () => {
      live = false;
    };
  }, [ref, text, library, trusted]);
  if (!ref || !got || got.text !== text) return undefined;
  return {
    base: ref.base,
    path: ref.path,
    state: got.state,
    facts: signedFacts(ref.base, ref.path, got.state),
    signedOnly: signedOnlyPolicy(ref.base),
  };
}

/**
 * A runbook that is not a library copy (a file, a link, one made here): its signature against the
 * keys added by you, when you added any (they count for every runbook); undefined otherwise, or
 * until it is checked.
 */
export function useOwnKeysState(r: Runbook | undefined): SignatureState | undefined {
  const trusted = useTrustedSigners();
  const text = r && r.source !== 'library' && readSignature(r.text) ? r.text : undefined;
  const [got, setGot] = useState<{ text: string; keys: string; state: SignatureState } | undefined>();
  const keys = keysFor(undefined);
  const id = keysId(keys);
  useEffect(() => {
    if (text === undefined) return;
    let live = true;
    void (async () => {
      await loadTrustedSigners();
      const mine = keysFor(undefined);
      if (mine.length === 0) return;
      const state = await signatureState(text, mine);
      if (live) setGot({ text, keys: keysId(mine), state });
    })();
    return () => {
      live = false;
    };
  }, [text, trusted]);
  return got && text !== undefined && got.text === text && got.keys === id && keys.length > 0 ? got.state : undefined;
}

/**
 * Why a library copy must not run, or undefined: its library opens verified runbooks only (as
 * read now, or as remembered when it isn't read: signedOnlyPolicy) and the copy isn't one any
 * more: unsigned, edited, expired, older than a version seen, under another name, or its key
 * withdrawn. The runbook screen asks this wherever it asks whether a cell can run, so a copy
 * opened from the main list (pinned, no longer listed, the library unreadable or not read yet)
 * is held to the same rule as one opened from Team runbooks.
 */
export function copyRefusal(copy: Runbook | undefined, copyState: ReturnType<typeof useLibraryCopyState>): string | undefined {
  const ref = copy?.source === 'library' ? copy.library : undefined;
  if (!copy || !ref) return undefined;
  // What the app remembers isn't read yet (the first moments after a start): not run until it is.
  if (!memoryReady) return t.libraryChecking;
  if (!signedOnlyPolicy(ref.base)) return undefined;
  const state = copyState && copyState.base === ref.base ? copyState.state : undefined;
  return openableReason({ base: ref.base, signedOnly: true }, { text: copy.text, path: ref.path }, state);
}

// ---- copies ----

/**
 * Whether the entry (or a copy of it: its text, the library's path) can be opened. A signedOnly
 * library opens verified runbooks only: signed by a signer trusted for this library (or added by
 * you), every runnable block covered, not expired, signed under a name that fits its path
 * (nameFitsPath), not older than a version of it seen before.
 */
export function openableReason(
  lib: Pick<Library, 'base' | 'signedOnly'>,
  entry: Pick<LibraryEntry, 'text' | 'error' | 'path'>,
  sig: SignatureState | undefined,
): string | undefined {
  if (entry.text === undefined) return entry.error ?? t.libraryUnreadable;
  if (!lib.signedOnly) return undefined;
  if (!sig) return t.libraryChecking;
  if (!isVerified(sig)) return t.librarySignedOnly(sig);
  if (!nameFitsPath(sig.manifest.name, entry.path)) return t.librarySignedOnlyOtherName(sig.manifest.name, entry.path);
  const older = olderThanSeen(lib.base, entry.path, sig);
  return older !== undefined ? t.librarySignedOnlyOlder(sig.manifest.version, older) : undefined;
}

const refOf = (base: string, entry: LibraryEntry & { text: string; hash: string }) => ({
  base,
  path: entry.path,
  hash: entry.hash,
  bare: libraryHash(clearOutputBlocks(entry.text)),
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
    const why = lib.signedOnly
      ? openableReason(lib, { text: mine.text, path: entry.path }, await signatureState(mine.text, keys))
      : undefined;
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
 * `seen`: the highest version of this path under its signed name seen from the library (highestVersion).
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
  if (copy.library && libraryHash(clearOutputBlocks(copy.text)) !== copy.library.bare) warnings.push({ kind: 'own-edits' });
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

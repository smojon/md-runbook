/**
 * A team library: a folder of signed runbooks on a web server (the web container's /runbooks/),
 * published to by apps/library-server. Paths in it, and whether a signed name fits the file it
 * is served as: the rules the app and the server apply, for VS Code and the command line.
 */

import { isBidiControl } from './shownText';

/** Folders below the library at most (apps/library-server's MAX_DEPTH). */
export const LIBRARY_MAX_DEPTH = 4;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,99}$/;

/**
 * Why `path` can't be a runbook's path in the library (undefined when it can), as the library
 * server checks it: relative, no `..`, `.` or empty parts, no hidden files or folders, plain
 * names, at most LIBRARY_MAX_DEPTH folders, and a Markdown file (`*.md`).
 */
export function libraryPathProblem(path: string): string | undefined {
  if (path === '' || path.length > 300) return 'expected a path of 1 to 300 characters';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) return 'expected a relative path with / between folders';
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'no empty, . or .. parts';
  if (parts.some((p) => p.startsWith('.'))) return 'no hidden files or folders';
  if (parts.some((p) => !SEGMENT_RE.test(p) || p.endsWith(' ') || p.endsWith('.'))) return 'use letters, digits, spaces and . _ - in names';
  if (parts.length > LIBRARY_MAX_DEPTH + 1) return `at most ${LIBRARY_MAX_DEPTH} folders deep`;
  if (!/\.md$/i.test(parts[parts.length - 1]!)) return 'only Markdown runbooks (*.md, *.runbook.md)';
  return undefined;
}

/** The path without `.md`, each part made as a default signed name is made (signPlan). */
const nameOfPath = (path: string): string =>
  path
    .replace(/(\.runbook)?\.(md|markdown)$/i, '')
    .split('/')
    .map((part) => part.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, ''))
    .join('/')
    .toLowerCase();

/**
 * Whether the signed name fits the file it is served as: the whole name is the end of the path,
 * part by part. `restart` fits `restart.md` and `ops/restart.md`; `ops/restart` fits
 * `ops/restart.md` and `x/ops/restart.md`, not `restart.md` or `staging/restart.md`. The rule of
 * the app and the library server.
 */
export function nameFitsPath(name: string, path: string): boolean {
  const n = name.toLowerCase();
  const p = nameOfPath(path);
  return n !== '' && (p === n || p.endsWith('/' + n));
}

// ---- reading a library (the app's parsers: apps/mobile/src/runbooks/library.ts) ----

/** At most this many runbooks are read from a library. */
export const MAX_LIBRARY_FILES = 200;

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

/** A path inside the library as read from a listing: relative, no `..`, no backslashes or addresses. */
export const libraryPathOk = (p: string): boolean =>
  p !== '' && !p.startsWith('/') && !p.includes('\\') && !p.includes('://') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
export const isMarkdownPath = (p: string): boolean => /\.(md|markdown)$/i.test(p);

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
              ...(typeof (e as LibraryFile).title === 'string' && (e as LibraryFile).title!.trim() ? { title: (e as LibraryFile).title!.trim() } : {}),
              ...(typeof (e as LibraryFile).folder === 'string' ? { folder: (e as LibraryFile).folder!.trim() } : {}),
            }
          : undefined;
    const path = f?.path.replace(/^\.\//, '');
    if (f && path && libraryPathOk(path) && isMarkdownPath(path) && !files.some((x) => x.path === path)) files.push({ ...f, path });
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
    if (typeof name !== 'string' || !libraryPathOk(name) || name.includes('/') || name.startsWith('.')) continue;
    if (type === 'directory') dirs.push(name);
    else if (type === 'file' && isMarkdownPath(name)) files.push(name);
    else if (type === 'file' && name === 'allowed_signers') allowedSigners = true;
  }
  const byName = (a: string, b: string): number => a.localeCompare(b);
  return { files: files.sort(byName), dirs: dirs.sort(byName), allowedSigners };
}

/** Control characters (C0, DEL) and bidi controls: refused anywhere in an address. */
const hasControl = (s: string): boolean =>
  [...s].some((c) => {
    const n = c.codePointAt(0)!;
    return n < 0x20 || n === 0x7f || isBidiControl(n);
  });

/**
 * Why this can't be a library address, or undefined: https only (http for this machine), no
 * user name or password (`userinfo`), no query or fragment (`invalid`). Backslashes, blanks and
 * control characters are refused before parsing: URL parsers disagree on them, so the host shown
 * could differ from the host fetched. Each client says it in its own words.
 */
export function libraryUrlProblemKind(url: string): 'invalid' | 'userinfo' | 'https' | undefined {
  const s = url.trim();
  if (/[\s\\]/.test(s) || hasControl(s)) return 'invalid';
  // user:password@ before the host, whatever a parser would make of it.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(s)) return 'userinfo';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'invalid';
  }
  if (u.username || u.password) return 'userinfo';
  if (u.protocol === 'https:') return u.search || u.hash ? 'invalid' : undefined;
  if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return u.search || u.hash ? 'invalid' : undefined;
  return 'https';
}

/**
 * The address as it is stored, fetched and shown: the parsed URL's own form (`href`: host in
 * lower case and punycode, the path normalised), as a folder (ends with /). Check it with
 * libraryUrlProblemKind first.
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

/** The address of the library file at `path` under the library folder `base` (ends with /). */
export const libraryFileUrl = (base: string, path: string): string => base + path.split('/').map(encodeURIComponent).join('/');

/** The address of the library server's API for the runbook at `path` (each part percent-encoded). */
export function libraryApiUrl(server: string, path: string): string {
  return `${server.replace(/\/+$/, '')}/v1/library/runbooks/${path.split('/').map(encodeURIComponent).join('/')}`;
}

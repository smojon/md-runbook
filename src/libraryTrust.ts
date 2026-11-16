/**
 * Per-library trust (docs/design/vscode-library-trust.md), as the app's keysFor: a key trusted from
 * a team library's allowed_signers counts for that library's runbooks only; your own file
 * (`mdRunbook.signing.allowedSigners`) counts for every runbook.
 * - One allowed_signers file per library origin, in global storage:
 *   library-signers/<sha256(origin)>/allowed_signers, with origin.txt next to it.
 * - A library's runbooks: the Library view's rows, and your copies of them (library/<key>/, with
 *   origin.txt next to the copy). A file elsewhere is no library's: your file only.
 * - A key the library no longer publishes stays as a `# withdrawn` comment line (ssh-keygen skips
 *   it), and counts again once published again.
 * No vscode import: unit-tested.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SignerLine, parseSignerLine, readSigners, withLine } from './allowedSigners';
import type { SignerCheck } from './signerCheck';

export const SIGNERS_DIR = 'library-signers';
export const COPIES_DIR = 'library';
const ORIGIN_FILE = 'origin.txt';
const SIGNERS_FILE = 'allowed_signers';
/** A trusted key the library no longer publishes: this prefix, then its line. */
export const WITHDRAWN = '# withdrawn ';

/** The `https://host[:port]` of a library address, or undefined when it isn't one. */
export function originOf(base: string): string | undefined {
  try {
    const u = new URL(base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The host to show for an origin. */
export const hostOfOrigin = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The allowed_signers file of the keys trusted from the library at `origin`. */
export function librarySignersFile(storage: string, origin: string): string {
  return path.join(storage, SIGNERS_DIR, sha256(origin), SIGNERS_FILE);
}

/** The header of a library's file. */
export const libraryHeader = (origin: string): string =>
  `# Signers trusted from the team library at ${origin}: they count for its runbooks only (OpenSSH allowed_signers)\n`;

/** Write a library's file (and origin.txt next to it). */
export function writeLibrarySigners(storage: string, origin: string, text: string): string {
  const file = librarySignersFile(storage, origin);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(file), ORIGIN_FILE), origin + '\n', 'utf8');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** The origin an origin.txt names, when it is one (as written: nothing else counts). */
function readOrigin(file: string): string | undefined {
  const text = readText(file)?.trim();
  return text !== undefined && originOf(text) === text ? text : undefined;
}

/** Each library's file, with its origin (Trusted Signers… lists them), by host. */
export function librarySignerFiles(storage: string): { origin: string; file: string }[] {
  const root = path.join(storage, SIGNERS_DIR);
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: { origin: string; file: string }[] = [];
  for (const d of dirs) {
    const origin = readOrigin(path.join(root, d, ORIGIN_FILE));
    const file = path.join(root, d, SIGNERS_FILE);
    if (origin !== undefined && sha256(origin) === d && fs.existsSync(file)) out.push({ origin, file });
  }
  return out.sort((a, b) => hostOfOrigin(a.origin).localeCompare(hostOfOrigin(b.origin)));
}

/**
 * Your copy of a library runbook: one per library, path and text (opening it again opens the copy
 * with its runs), with origin.txt next to it. Copies from before origin.txt get it now.
 */
export function libraryCopyFile(storage: string, base: string, entry: { path: string; fileName: string; text: string }): string {
  const key = createHash('sha256').update(base).update('\0').update(entry.path).update('\0').update(entry.text).digest('hex').slice(0, 16);
  const dir = path.join(storage, COPIES_DIR, key);
  const file = path.join(dir, entry.fileName.replace(/[\\/:*?"<>|]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, entry.text, 'utf8');
  const origin = originOf(base);
  if (origin !== undefined && readOrigin(path.join(dir, ORIGIN_FILE)) !== origin) fs.writeFileSync(path.join(dir, ORIGIN_FILE), origin + '\n', 'utf8');
  return file;
}

/**
 * The library origin a runbook file belongs to: only a file in one of your copy folders
 * (storage/library/<key>/) with its origin.txt. A runbook a copy calls is its library's only in
 * the same folder. Anything else: undefined (your file only).
 */
export function libraryOriginOf(file: string, storage: string): string | undefined {
  const rel = path.relative(path.join(storage, COPIES_DIR), file);
  const parts = rel.split(/[\\/]/);
  if (parts.length !== 2 || path.isAbsolute(rel) || !/^[0-9a-f]{16}$/.test(parts[0]!) || parts[1] === ORIGIN_FILE) return undefined;
  return readOrigin(path.join(path.dirname(file), ORIGIN_FILE));
}

/**
 * The files a runbook's signature is checked against, in order: yours (`own`, when set), then the
 * keys trusted from its library (`origin`), when there are any.
 */
export function signerFiles(own: string, storage: string, origin: string | undefined): string[] {
  const files = own ? [own] : [];
  if (origin !== undefined) {
    const lib = librarySignersFile(storage, origin);
    if (fs.existsSync(lib)) files.push(lib);
  }
  return files;
}

/** signerFiles for a runbook file: its library's keys count only for a copy from that library. */
export const runbookSignerFiles = (own: string, storage: string, file: string | undefined): string[] =>
  signerFiles(own, storage, file === undefined ? undefined : libraryOriginOf(file, storage));

/**
 * The trusted signer of `text`: the first file whose keys made one of its signatures (ssh-keygen
 * reads one file per call: two calls at most). "Can't check" (no ssh-keygen) stops there.
 */
export async function signerOf(text: string, files: readonly string[], check: (text: string, file: string) => Promise<SignerCheck>): Promise<SignerCheck> {
  for (const file of files) {
    const got = await check(text, file);
    if (got.signer !== undefined || got.cantCheck) return got;
  }
  return {};
}

// ---- withdrawn keys ----

export type LibrarySigner = SignerLine & { withdrawn?: true };

/** The same key for the same names. */
const sameSigner = (a: Pick<SignerLine, 'principals' | 'keyType' | 'key'>, b: Pick<SignerLine, 'principals' | 'keyType' | 'key'>): boolean =>
  a.keyType === b.keyType && a.key === b.key && [...a.principals].sort().join(',') === [...b.principals].sort().join(',');

/** A library file's signers, withdrawn ones included (their `raw` is the comment line). */
export function readLibrarySigners(text: string): { signers: LibrarySigner[]; skipped: { line: number; problem: string }[] } {
  const { signers, skipped } = readSigners(text);
  const withdrawn: LibrarySigner[] = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const t = raw.trim();
    if (!t.startsWith(WITHDRAWN)) return;
    const s = parseSignerLine(t.slice(WITHDRAWN.length), n);
    if (s && !('problem' in s)) withdrawn.push({ ...s, raw: t, withdrawn: true });
  });
  return { signers: [...signers, ...withdrawn].sort((a, b) => a.line - b.line), skipped };
}

/**
 * The library's file after a read of what it publishes (`published`: its allowed_signers text,
 * '' when it publishes none): trusted keys it no longer lists become `# withdrawn` lines, withdrawn
 * ones it lists again count again. Undefined when nothing changes.
 */
export function withWithdrawn(text: string, published: string): string | undefined {
  const listed = readSigners(published).signers;
  let changed = false;
  const lines = text.split(/(?<=\n)/).map((l) => {
    const eol = l.match(/\r?\n$/)?.[0] ?? '';
    const t = l.trim();
    if (t.startsWith(WITHDRAWN)) {
      const s = parseSignerLine(t.slice(WITHDRAWN.length));
      if (!s || 'problem' in s || !listed.some((x) => sameSigner(x, s))) return l;
      changed = true;
      return t.slice(WITHDRAWN.length) + eol;
    }
    const s = parseSignerLine(t);
    if (!s || 'problem' in s || listed.some((x) => sameSigner(x, s))) return l;
    changed = true;
    return WITHDRAWN + t + eol;
  });
  return changed ? lines.join('') : undefined;
}

/** Note what the library at `origin` publishes now in its file (when you trust keys from it). */
export function noteWithdrawn(storage: string, origin: string, published: string): void {
  const file = librarySignersFile(storage, origin);
  const text = readText(file);
  if (text === undefined) return;
  const next = withWithdrawn(text, published);
  if (next !== undefined) fs.writeFileSync(file, next, 'utf8');
}

/**
 * The text with these lines trusted: a new one at the end, a withdrawn one restored. Which of
 * `lines` were added (their indexes), and how many were there already.
 */
export function withTrustedLines(text: string, header: string, lines: readonly string[]): { text: string; added: number[]; already: number } {
  let out = text;
  const added: number[] = [];
  let already = 0;
  lines.forEach((line, i) => {
    const s = parseSignerLine(line);
    if (!s || 'problem' in s) return;
    const { signers } = readLibrarySigners(out);
    const found = signers.find((x) => sameSigner(x, s));
    if (found && !found.withdrawn) return void already++;
    if (found) {
      const parts = out.split(/(?<=\n)/);
      const at = parts.findIndex((l) => l.trim() === found.raw);
      parts[at] = parts[at]!.replace(WITHDRAWN, '');
      out = parts.join('');
    } else out = withLine(out || header, line);
    added.push(i);
  });
  return { text: out, added, already };
}

/** Trust these lines (allowed_signers lines, as signerLineToAdd gives them) from the library at `origin`. */
export function trustLibraryLines(storage: string, origin: string, lines: readonly string[]): { file: string; added: number[]; already: number } {
  const file = librarySignersFile(storage, origin);
  const got = withTrustedLines(readText(file) ?? '', libraryHeader(origin), lines);
  if (got.added.length > 0) writeLibrarySigners(storage, origin, got.text);
  return { file, added: got.added, already: got.already };
}

/** Your own file's keys a library also publishes (an earlier version trusted them there): by line. */
export function alsoPublished(own: readonly SignerLine[], published: string | undefined): Set<number> {
  const listed = published ? readSigners(published).signers : [];
  return new Set(own.filter((s) => listed.some((x) => sameSigner(x, s))).map((s) => s.line));
}

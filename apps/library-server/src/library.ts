/**
 * Publishing to the team library: the folder the web container serves read-only at /runbooks/.
 * Only signed runbooks go in. Each is checked as the app and md-runbook-gate check it: a signature
 * from the library's allowed_signers (ssh-keygen, namespace md-runbook), the whole runbook signed
 * (manifest version 2) and unchanged since, not expired, its signed name the file's name, and a
 * version higher than any published at that path before. Files are written atomically and
 * index.json is written again after each change.
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LibraryConfig } from './config';
import { manifestVersion, parseManifest, readSignature, runbookTitle, sha256Hex, signedStatus, trustedRunbookSigner, wholeRunbookSigned } from './core';
import { HttpError, Mutex } from './http';

/** Folders below the library at most (the app lists 4 levels). */
export const MAX_DEPTH = 4;
/** Runbooks listed in index.json at most. */
export const MAX_FILES = 500;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,99}$/;

/**
 * Why `path` can't be a runbook's path in the library (undefined when it can): relative, no `..`,
 * `.` or empty parts, no hidden files or folders, plain names, at most MAX_DEPTH folders, and a
 * Markdown file (`*.md`, so `*.runbook.md` too).
 */
export function pathProblem(path: string): string | undefined {
  if (path === '' || path.length > 300) return 'expected a path of 1 to 300 characters';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) return 'expected a relative path with / between folders';
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'no empty, . or .. parts';
  if (parts.some((p) => p.startsWith('.'))) return 'no hidden files or folders';
  if (parts.some((p) => !SEGMENT_RE.test(p) || p.endsWith(' ') || p.endsWith('.'))) return 'use letters, digits, spaces and . _ - in names';
  if (parts.length > MAX_DEPTH + 1) return `at most ${MAX_DEPTH} folders deep`;
  if (!/\.md$/i.test(parts[parts.length - 1]!)) return 'only Markdown runbooks (*.md, *.runbook.md)';
  return undefined;
}

/** The path of a request URL's rest (`db/restore.md`, percent-encoded parts decoded), checked. */
export function decodePath(rest: string): string {
  let parts: string[];
  try {
    parts = rest.split('/').map((p) => decodeURIComponent(p));
  } catch {
    throw new HttpError(400, 'the path is not percent-encoded correctly');
  }
  if (parts.some((p) => p.includes('/') || p.includes('\\') || /[\0-\x1f\x7f]/.test(p))) throw new HttpError(400, 'the path has an encoded / or \\, or a control character');
  const path = parts.join('/');
  const why = pathProblem(path);
  if (why) throw new HttpError(400, `path ${JSON.stringify(path.slice(0, 80))}: ${why}`);
  return path;
}

/** The path without `.md`, each part made as the app's default signed name is made. */
const nameOfPath = (path: string): string =>
  path
    .replace(/(\.runbook)?\.(md|markdown)$/i, '')
    .split('/')
    .map((part) => part.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, ''))
    .join('/')
    .toLowerCase();

/**
 * Whether the signed name fits the file it is served as: the whole name is the end of the path
 * in the library, part by part. `restart` fits `restart.md` and `ops/restart.runbook.md`;
 * `ops/restart` fits `ops/restart.md` and `x/ops/restart.md`, not `restart.md` or
 * `staging/restart.md`. The app's rule (apps/mobile/src/runbooks/library.ts), so the server never
 * publishes a runbook the app then refuses to open.
 */
export function nameFitsPath(name: string, path: string): boolean {
  const n = name.toLowerCase();
  const p = nameOfPath(path);
  return n !== '' && (p === n || p.endsWith('/' + n));
}

const today = (now: Date): string => now.toISOString().slice(0, 10);

export interface Checked {
  name: string;
  version: number;
  /** The principal of allowed_signers whose key made a signature. */
  signer: string;
  /** SHA-256 of the manifest: what a gate logs and a `revoked` file lists. */
  manifest: string;
  manifestVersion: 1 | 2;
  expires?: string;
}

/** The signed version of a runbook's text, or 0 when it has no readable signature. */
export function signedVersion(text: string): number {
  return signedRelease(text)?.version ?? 0;
}

/** The signed name (lower case) and version of a runbook's text, or undefined when it has no readable signature. */
export function signedRelease(text: string): { name: string; version: number } | undefined {
  const block = readSignature(text);
  if (!block) return undefined;
  try {
    const m = parseManifest(block.manifest);
    return { name: m.name.toLowerCase(), version: m.version };
  } catch {
    return undefined;
  }
}

/**
 * Everything a runbook must be to be published at `path`, except its version against the
 * published one (Library.publish): the facts of its signature, or an HttpError saying what is wrong.
 */
export async function checkRunbook(text: string, path: string, o: { allowedSigners: string; acceptV1: boolean; sshKeygen?: string; now?: Date }): Promise<Checked> {
  const block = readSignature(text);
  if (!block) throw new HttpError(422, 'the runbook is not signed: the library takes signed runbooks only (md-runbook sign, Sign Runbook)');
  let m;
  try {
    m = parseManifest(block.manifest);
  } catch (e) {
    throw new HttpError(422, `the signature block is damaged: ${e instanceof Error ? e.message : String(e)}`);
  }
  const status = signedStatus(text);
  if (!status) throw new HttpError(422, 'the signature block is damaged');
  const v = manifestVersion(m);
  if (v === 1) {
    if (!o.acceptV1) throw new HttpError(422, 'signed before manifest version 2: only its bash blocks are signed, not the whole runbook; sign it again');
    if (status.changed.length > 0 || status.missing.length > 0 || status.moved.length > 0 || status.missingCalls.length > 0)
      throw new HttpError(422, 'blocks changed since signing: sign it again');
  } else if (!wholeRunbookSigned(status)) throw new HttpError(422, 'the runbook changed since signing (outside outputs, notes and ticked boxes): sign it again');
  const now = o.now ?? new Date();
  if (m.expires && today(now) > m.expires) throw new HttpError(422, `the signature expired on ${m.expires}`);
  if (!nameFitsPath(m.name, path)) throw new HttpError(422, `the signed name ${m.name} doesn't fit the file ${path}: the whole name must be the end of its path in the library (without .md)`);
  const signer = await trustedRunbookSigner(text, o.allowedSigners, o.sshKeygen);
  if (!signer) throw new HttpError(403, "the signature is not from a signer in the library's allowed_signers (or the manifest was changed after signing)");
  return { name: m.name, version: m.version, signer, manifest: sha256Hex(block.manifest), manifestVersion: v, ...(m.expires ? { expires: m.expires } : {}) };
}

/** Write `data` to `file` through a temporary file next to it and a rename: readers see the old file or the new one. */
export async function writeAtomic(file: string, data: string, mode = 0o644): Promise<void> {
  const tmp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`);
  const h = await fsp.open(tmp, 'wx', mode);
  try {
    await h.writeFile(data, 'utf8');
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

async function lstatOrUndefined(p: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fsp.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

interface IndexEntry {
  path: string;
  title?: string;
  folder?: string;
}

export interface PublishResult extends Checked {
  path: string;
  /** The version published there before (0: none). */
  previous: number;
  /** The same text was there already: nothing changed. */
  unchanged?: boolean;
}

export class Library {
  private readonly lock = new Mutex();
  private readonly versionsFile: string;
  private readonly namesFile: string;

  constructor(
    readonly config: LibraryConfig,
    stateDir: string,
    private readonly sshKeygen = 'ssh-keygen',
  ) {
    this.versionsFile = join(stateDir, 'library-versions.json');
    this.namesFile = join(stateDir, 'library-names.json');
  }

  /**
   * The highest version ever published of each signed name (lower case), at any path: an old
   * release can't come back under another folder (`old/ops/restart.md` for `ops/restart`; security
   * review, 2026-11-16). Missing (a library from before): made from the files published now.
   */
  private async readNames(): Promise<Record<string, number>> {
    try {
      const v = JSON.parse(await fsp.readFile(this.namesFile, 'utf8')) as unknown;
      if (typeof v === 'object' && v !== null) return v as Record<string, number>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const names: Record<string, number> = {};
    for (const p of await this.files()) {
      // A file that can't be read gives no floor; it doesn't stop publishing.
      const r = signedRelease(await fsp.readFile(join(this.config.dir, p), 'utf8').catch(() => ''));
      if (r) names[r.name] = Math.max(names[r.name] ?? 0, r.version);
    }
    return names;
  }

  /** The folder of `path`, made where missing; refused if any part of it is a symbolic link or not a folder. */
  private async folderOf(path: string, create: boolean): Promise<string> {
    let dir = this.config.dir;
    for (const part of path.split('/').slice(0, -1)) {
      dir = join(dir, part);
      const st = await lstatOrUndefined(dir);
      if (!st) {
        if (!create) return dir;
        await fsp.mkdir(dir, { mode: 0o755 });
      } else if (!st.isDirectory() || st.isSymbolicLink()) throw new HttpError(409, `${path}: a part of the path is not a folder (or is a link)`);
    }
    return dir;
  }

  private async readVersions(): Promise<Record<string, number>> {
    try {
      const v = JSON.parse(await fsp.readFile(this.versionsFile, 'utf8')) as unknown;
      return typeof v === 'object' && v !== null ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  /** The highest version ever published at each path (kept when a file is deleted, so an older one can't come back). */
  versions(): Promise<Record<string, number>> {
    return this.readVersions();
  }

  async publish(path: string, text: string, now = new Date()): Promise<PublishResult> {
    const checked = await checkRunbook(text, path, { allowedSigners: this.config.allowedSigners, acceptV1: this.config.acceptV1, sshKeygen: this.sshKeygen, now });
    return this.lock.run(async () => {
      const file = join(await this.folderOf(path, true), path.split('/').pop()!);
      const st = await lstatOrUndefined(file);
      if (st && !st.isFile()) throw new HttpError(409, `${path} is not a plain file on the server (a link or a folder)`);
      const current = st ? await fsp.readFile(file, 'utf8') : undefined;
      const versions = await this.readVersions();
      const previous = Math.max(current !== undefined ? signedVersion(current) : 0, versions[path] ?? 0);
      if (current === text) return { ...checked, path, previous, unchanged: true };
      if (checked.version <= previous) throw new HttpError(409, `${path}: version ${checked.version} is not higher than the version published (${previous}); sign it again to count the version up`);
      const names = await this.readNames();
      const name = checked.name.toLowerCase();
      const highest = names[name] ?? 0;
      if (checked.version < highest) {
        throw new HttpError(409, `${path}: ${checked.name} version ${checked.version} is older than version ${highest}, published before (here or at another path); sign it again to count the version up`);
      }
      await writeAtomic(file, text);
      await fsp.mkdir(dirname(this.versionsFile), { recursive: true, mode: 0o750 });
      await writeAtomic(this.versionsFile, JSON.stringify({ ...versions, [path]: checked.version }, null, 1) + '\n');
      await writeAtomic(this.namesFile, JSON.stringify({ ...names, [name]: Math.max(highest, checked.version) }, null, 1) + '\n');
      await this.writeIndex();
      return { ...checked, path, previous };
    });
  }

  async remove(path: string): Promise<{ path: string; version: number }> {
    return this.lock.run(async () => {
      const file = join(await this.folderOf(path, false), path.split('/').pop()!);
      const st = await lstatOrUndefined(file);
      if (!st) throw new HttpError(404, `${path} is not in the library`);
      if (!st.isFile()) throw new HttpError(409, `${path} is not a plain file on the server`);
      const release = signedRelease(await fsp.readFile(file, 'utf8'));
      // Its name keeps its highest version: an older release can't come back at another path.
      const names = await this.readNames();
      if (release) {
        await fsp.mkdir(dirname(this.namesFile), { recursive: true, mode: 0o750 });
        await writeAtomic(this.namesFile, JSON.stringify({ ...names, [release.name]: Math.max(names[release.name] ?? 0, release.version) }, null, 1) + '\n');
      }
      const version = release?.version ?? 0;
      await fsp.rm(file);
      await this.writeIndex();
      return { path, version };
    });
  }

  /** The library's runbooks: Markdown files, no hidden ones, no links, MAX_DEPTH folders down. */
  async files(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string, depth: number): Promise<void> => {
      const entries = await fsp.readdir(join(this.config.dir, rel), { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= MAX_FILES) return;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        if (e.isFile() && pathProblem(p) === undefined) out.push(p);
        else if (e.isDirectory() && depth < MAX_DEPTH) await walk(p, depth + 1);
      }
    };
    await walk('', 0);
    return out;
  }

  /**
   * index.json for the app: every runbook with its title, and signedOnly from the settings. A
   * `folder` set by hand in the index before is kept.
   */
  async writeIndex(): Promise<void> {
    const indexFile = join(this.config.dir, 'index.json');
    const folders = new Map<string, string>();
    try {
      const old = JSON.parse(await fsp.readFile(indexFile, 'utf8')) as { runbooks?: unknown };
      if (Array.isArray(old.runbooks))
        for (const e of old.runbooks) if (e && typeof e === 'object' && typeof e.path === 'string' && typeof e.folder === 'string') folders.set(e.path, e.folder);
    } catch {
      // none yet, or not ours to read: written anew
    }
    const runbooks: IndexEntry[] = [];
    for (const path of await this.files()) {
      let title: string | undefined;
      try {
        title = runbookTitle(await fsp.readFile(join(this.config.dir, path), 'utf8')) || undefined;
      } catch {
        title = undefined;
      }
      runbooks.push({ path, ...(title ? { title: title.slice(0, 200) } : {}), ...(folders.has(path) ? { folder: folders.get(path)! } : {}) });
    }
    await writeAtomic(indexFile, JSON.stringify({ signedOnly: this.config.signedOnly, runbooks }, null, 1) + '\n');
  }

}

/** The text of the runbook at `path` in the library folder `dir`, or undefined (missing, or reached through a link). */
export async function readLibraryFile(dir: string, path: string): Promise<string | undefined> {
  if (pathProblem(path) !== undefined) return undefined;
  try {
    let p = dir;
    for (const part of path.split('/')) {
      p = join(p, part);
      const st = await lstatOrUndefined(p);
      if (!st || st.isSymbolicLink()) return undefined;
    }
    return (await fsp.lstat(p)).isFile() ? await fsp.readFile(p, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

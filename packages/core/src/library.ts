/**
 * A team library: a folder of signed runbooks on a web server (the web container's /runbooks/),
 * published to by apps/library-server. Paths in it, and whether a signed name fits the file it
 * is served as: the rules the app and the server apply, for VS Code and the command line.
 */

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

/** The address of the library server's API for the runbook at `path` (each part percent-encoded). */
export function libraryApiUrl(server: string, path: string): string {
  return `${server.replace(/\/+$/, '')}/v1/library/runbooks/${path.split('/').map(encodeURIComponent).join('/')}`;
}

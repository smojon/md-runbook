/**
 * Windows: a program installed while VS Code runs is not found by the cells VS Code starts. Every
 * cell inherits VS Code's environment, and VS Code read PATH once, when it started; a runbook
 * that installs Git in one step and runs `git` in the next fails until VS Code is restarted.
 *
 * A new terminal reads the Machine and User PATH from the registry. This does the same for a
 * cell, but only *adds*: the directories that are new are appended, so the inherited PATH keeps
 * its order and its own entries (a virtualenv, a PATH set before starting VS Code) still win.
 */

import { execFile } from 'node:child_process';

const KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
];

/** The `Path` value in the output of `reg query <key> /v Path`, or "". */
export function parseRegQuery(output: string): string {
  const m = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
  return m ? m[1]!.trim() : '';
}

/** `%NAME%` references expanded from `env`, as Windows does for REG_EXPAND_SZ; unknown ones stay. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    const found = key === undefined ? undefined : env[key];
    return found === undefined ? whole : found;
  });
}

function normalize(dir: string): string {
  return dir.trim().replace(/[\\/]+$/, '').toLowerCase();
}

/** `current` with the directories of `fresh` it lacks appended, in order; unchanged if none. */
export function mergePath(current: string, fresh: readonly string[]): string {
  const have = new Set(current.split(';').map(normalize).filter(Boolean));
  const added: string[] = [];
  for (const dir of fresh) {
    const key = normalize(dir);
    if (!key || have.has(key)) continue;
    have.add(key);
    added.push(dir.trim());
  }
  if (added.length === 0) return current;
  return [current.replace(/;+$/, ''), ...added].filter(Boolean).join(';');
}

function regQuery(key: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'Path'], { windowsHide: true, timeout: 5000 }, (error, stdout) =>
      resolve(error ? '' : String(stdout)),
    );
  });
}

let cache: { at: number; dirs: string[] } | undefined;
/** Run All starts many cells in a row; reading the registry once every few seconds is enough. */
const CACHE_MS = 3000;

/** The Machine then the User PATH directories from the registry, expanded; [] if unreadable. */
export async function registryPath(env: NodeJS.ProcessEnv, now: number = Date.now()): Promise<string[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.dirs;
  const dirs: string[] = [];
  for (const key of KEYS) {
    const value = parseRegQuery(await regQuery(key));
    dirs.push(...expandWindowsVars(value, env).split(';').filter((d) => d.trim()));
  }
  cache = { at: now, dirs };
  return dirs;
}

/**
 * Give `env` (a cell's environment, changed in place) the PATH directories added to the registry
 * since VS Code started. Only on Windows; elsewhere installers change shell profiles, which a
 * running program cannot re-read either, and `env` is returned unchanged.
 */
export async function freshenPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  read: (env: NodeJS.ProcessEnv) => Promise<string[]> = registryPath,
): Promise<NodeJS.ProcessEnv> {
  if (platform !== 'win32') return env;
  // Windows' own spelling is usually "Path"; a copied env object is case-sensitive.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
  const current = env[key] ?? '';
  const merged = mergePath(current, await read(env));
  if (merged !== current) env[key] = merged;
  return env;
}

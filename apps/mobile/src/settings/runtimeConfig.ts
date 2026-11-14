/**
 * The web container's runtime configuration: `/config.json` on the app's own origin, written when
 * the container starts from its environment (apps/web/40-md-runbook-config.sh):
 *
 *   { "publicUrl": "https://runbooks.example.net", "library": "/sop/" }
 *
 * from MD_RUNBOOK_PUBLIC_URL and MD_RUNBOOK_LIBRARY. It holds no secrets: anyone who reaches the
 * web app can read it. Read once, on the web only; where there is none (GitHub Pages, the dev
 * server) or it can't be read, it is empty and the defaults hold (the page's own origin,
 * /runbooks/). A value that isn't valid is left out, as if it weren't set.
 */
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

export interface RuntimeConfig {
  /** MD_RUNBOOK_PUBLIC_URL: the web app's public address, normalised (no trailing slash). */
  publicUrl?: string;
  /** MD_RUNBOOK_LIBRARY: the team library's folder on the app's origin, `/runbooks/` by default. */
  library?: string;
}

/** The library folder when none is set: what the container serves at /runbooks/. */
export const DEFAULT_LIBRARY_PATH = '/runbooks/';
/** How long the app waits for /config.json before it goes on without it. */
const CONFIG_TIMEOUT_MS = 5_000;

const hasControl = (s: string): boolean => [...s].some((c) => c.codePointAt(0)! < 0x20 || c.codePointAt(0) === 0x7f);

/**
 * Why this can't be the web app's public address, or undefined: https (http only for this
 * machine), no user name or password, no query or fragment. Backslashes, blanks and control
 * characters are refused before parsing, as for a library address.
 */
export function publicUrlProblem(url: string): 'invalid' | 'https' | undefined {
  const s = url.trim();
  if (s === '' || /[\s\\]/.test(s) || hasControl(s) || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(s)) return 'invalid';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'invalid';
  }
  if (u.username || u.password || u.search || u.hash || s.includes('#') || s.includes('?')) return 'invalid';
  if (u.protocol === 'https:') return undefined;
  if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return undefined;
  return 'https';
}

/** The address as links start with it: the parsed URL's own form, without a trailing slash. */
export function normalizePublicUrl(url: string): string {
  let href = url.trim();
  try {
    href = new URL(href).href;
  } catch {
    // Checked with publicUrlProblem first.
  }
  return href.replace(/\/+$/, '');
}

/**
 * A library folder on the app's origin: starts and ends with `/`, plain names in between (no
 * `..`, no hidden folders, nothing a URL or nginx would read otherwise).
 */
export const isLibraryPath = (p: string): boolean => /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)+$/.test(p);

/** /config.json's content as the app uses it: the values that are valid, the others left out. */
export function parseRuntimeConfig(v: unknown): RuntimeConfig {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const out: RuntimeConfig = {};
  if (typeof o.publicUrl === 'string' && o.publicUrl.trim() !== '') {
    if (publicUrlProblem(o.publicUrl) === undefined) out.publicUrl = normalizePublicUrl(o.publicUrl);
    else console.warn('config.json: publicUrl is not an https address, ignored');
  }
  if (typeof o.library === 'string' && o.library.trim() !== '') {
    if (isLibraryPath(o.library.trim())) out.library = o.library.trim();
    else console.warn('config.json: library is not a folder path such as /runbooks/, ignored');
  }
  return out;
}

let config: RuntimeConfig = {};
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();

/** The page's origin on the web (http or https), else undefined. */
export function pageOrigin(): string | undefined {
  if (Platform.OS !== 'web') return undefined;
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return origin && /^https?:\/\//.test(origin) ? origin : undefined;
}

/** Read /config.json, once (later calls wait for the same read). `fetcher`: tests. */
export function loadRuntimeConfig(fetcher?: typeof fetch): Promise<void> {
  return (loaded ??= (async () => {
    const origin = pageOrigin();
    if (!origin) return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CONFIG_TIMEOUT_MS);
    try {
      const res = await (fetcher ?? fetch)(`${origin}/config.json`, { cache: 'no-store', signal: abort.signal });
      if (!res.ok) return;
      const text = await res.text();
      // A single-page host answers every path with the app's page.
      if (/^\s*</.test(text)) return;
      config = parseRuntimeConfig(JSON.parse(text));
      listeners.forEach((l) => l());
    } catch {
      // None, or not JSON: the defaults.
    } finally {
      clearTimeout(timer);
    }
  })());
}

export const runtimeConfig = (): RuntimeConfig => config;

export function useRuntimeConfig(): RuntimeConfig {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => config,
  );
}

/** Tests: nothing read yet; or, with `next`, that configuration as if read. */
export function resetRuntimeConfig(next?: RuntimeConfig): void {
  config = next ?? {};
  loaded = next ? Promise.resolve() : undefined;
  listeners.forEach((l) => l());
}

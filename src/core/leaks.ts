/**
 * Leak scanner: finds things that should not leave the machine (secrets in known formats,
 * private keys, cloud keys, high-entropy tokens, internal domains). It reports; `redactLeaks`
 * replaces the secret findings with [REDACTED].
 */

import { DEFAULT_PATTERNS, REDACTED, compilePattern } from './redact';

export interface LeakScanOptions {
  /** Internal DNS suffixes (e.g. `corp.example.com`); hosts under them are reported. */
  internalDomains?: string[];
}

export interface LeakFinding {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** 0-based offset into the scanned text. */
  offset: number;
  length: number;
  /** Pattern name, e.g. `aws-access-key-id`, `high-entropy`, `internal-domain`. */
  kind: string;
  /** Masked text: secrets show their first characters only; internal domains are shown whole. */
  preview: string;
}

interface Detector {
  kind: string;
  re: RegExp;
}

const EXTRA_DETECTORS: readonly Detector[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: 'gcp-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'gcp-oauth-token', re: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { kind: 'azure-storage-key', re: /(?<=\b(?:AccountKey|SharedAccessKey)=)[A-Za-z0-9+/=]{20,}/gi },
  { kind: 'azure-sas-signature', re: /(?<=[?&]sig=)[A-Za-z0-9%+/=]{20,}/g },
  { kind: 'azure-client-secret', re: /(?<![\w~.-])[A-Za-z0-9_~.-]{3}\dQ~[A-Za-z0-9_~.-]{31,34}(?![\w~.-])/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
];

/** Generic key/header patterns report after the specific formats, so a span gets its most precise kind. */
const GENERIC = new Set(['authorization-header', 'cookie-header', 'secret-key-value']);
const PATTERN_DETECTORS: readonly Detector[] = [...DEFAULT_PATTERNS]
  .sort((a, b) => Number(GENERIC.has(a.name ?? '')) - Number(GENERIC.has(b.name ?? '')))
  .map((p) => ({ kind: p.name === 'pem-private-key' ? 'private-key' : (p.name ?? 'secret'), re: compilePattern(p) }));

/** Values that are references, not secrets: `$TOKEN`, `${TOKEN}`, `$env:TOKEN`, `%TOKEN%`, `$(cmd)`. */
const VARIABLE_REF = /^(?:(?:Bearer|Basic|token)\s+)?(?:\$\{?[A-Za-z_]\w*\}?|\$env:\w+|%\w+%|\$\(.*\))$/i;

const TOKEN_RE = /[A-Za-z0-9+/=_-]{24,}/g;
const MIN_ENTROPY = 4.0;

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * A token worth reporting as a likely secret. Skipped: 40/64-hex digests (git SHAs, sha256),
 * lowercase dash-separated names (pod names, UUIDs), path-like tokens and tokens without digits.
 */
export function isHighEntropyToken(token: string): boolean {
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(token)) return false;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(token)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return false;
  if (/\/[A-Za-z_-]+\//.test(token)) return false;
  if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) return false;
  return shannonEntropy(token) >= MIN_ENTROPY;
}

export function maskSecret(s: string): string {
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…(${s.length} chars)`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function domainDetector(domains: readonly string[] | undefined): Detector | undefined {
  const list = (domains ?? []).map((d) => d.trim().replace(/^\*?\.+/, '')).filter((d) => d !== '');
  if (list.length === 0) return undefined;
  const alt = list.sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  return { kind: 'internal-domain', re: new RegExp(`(?<![\\w.-])(?:[a-z0-9-]+\\.)*(?:${alt})(?![\\w-]|\\.[a-z0-9])`, 'gi') };
}

function skipMatch(m: string): boolean {
  return m.includes(REDACTED) || VARIABLE_REF.test(m.trim());
}

export function scanForLeaks(text: string, opts: LeakScanOptions = {}): LeakFinding[] {
  const spans: Array<{ offset: number; length: number; kind: string }> = [];
  const taken = (start: number, end: number): boolean => spans.some((s) => start < s.offset + s.length && s.offset < end);
  const add = (offset: number, length: number, kind: string): void => {
    if (length > 0 && !taken(offset, offset + length)) spans.push({ offset, length, kind });
  };

  for (const d of [...EXTRA_DETECTORS, ...PATTERN_DETECTORS]) {
    d.re.lastIndex = 0;
    for (const m of text.matchAll(d.re)) {
      if (m[0] === '' || skipMatch(m[0])) continue;
      add(m.index ?? 0, m[0].length, d.kind);
    }
  }
  for (const m of text.matchAll(TOKEN_RE)) {
    if (isHighEntropyToken(m[0])) add(m.index ?? 0, m[0].length, 'high-entropy');
  }
  const domains = domainDetector(opts.internalDomains);
  if (domains) for (const m of text.matchAll(domains.re)) add(m.index ?? 0, m[0].length, domains.kind);

  spans.sort((a, b) => a.offset - b.offset);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  return spans.map((s) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= s.offset) lo = mid;
      else hi = mid - 1;
    }
    const raw = text.slice(s.offset, s.offset + s.length);
    return {
      line: lo + 1,
      column: s.offset - (lineStarts[lo] ?? 0) + 1,
      offset: s.offset,
      length: s.length,
      kind: s.kind,
      preview: s.kind === 'internal-domain' ? raw : maskSecret(raw),
    };
  });
}

/** Replace every finding except internal domains (not secrets; pseudonymization handles them) with [REDACTED]. */
export function redactLeaks(text: string, opts: LeakScanOptions = {}): string {
  const hits = scanForLeaks(text, opts).filter((f) => f.kind !== 'internal-domain');
  let out = text;
  for (const f of hits.reverse()) out = out.slice(0, f.offset) + REDACTED + out.slice(f.offset + f.length);
  return out;
}

/** One-line summary such as `2 high-entropy, 1 aws-access-key-id`. */
export function summarizeLeaks(findings: readonly LeakFinding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${n} ${k}`).join(', ');
}

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
const VARIABLE_REF = /^(?:(?:Bearer|Basic|token)\s+)?(?:\$\{?[A-Za-z_]\w*\}?|\$env:\w+|%\w+%|\$\(.*\)|\$\{(?:secret|input|param|secretFile):[\w:]+\})$/i;

/**
 * Variable references anywhere in the text (never secrets): md-runbook's own `${secret:NAME}`,
 * `${input:NAME}`, `${param:NAME}`, `${secretFile:NAME}`, shell `${VAR}`, `${VAR:-default}`,
 * `$VAR`, `$(command)`, PowerShell `$env:VAR` and cmd `%VAR%`.
 */
const REFERENCE_RE =
  /\$\{(?:secret|input|param|secretFile):[\w:]+\}|\$\{[A-Za-z_]\w*(?::?[-=?+][^}\n]*)?\}|\$\((?:[^()\n]|\([^()\n]*\))*\)|\$env:\w+|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%/g;

/** An auth scheme in front of a value (`Bearer $TOKEN`): the value is what counts. */
const AUTH_SCHEME = /^(?:(?:Bearer|Basic|token)\s+)?/i;

/** Lines like `-----BEGIN RSA PRIVATE KEY-----` whose body is already `[REDACTED]`. */
const REDACTED_AFTER = new RegExp(`^\\s*${REDACTED.replace(/[[\]]/g, '\\$&')}`);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Secrets that only their context gives away. */
const CONTEXT_DETECTORS: readonly Detector[] = [
  // Keycloak credential representations: {"type":"secret","value":"…"} (either key order, kcadm pretty-printing).
  { kind: 'keycloak-credential', re: /(?<="type"\s*:\s*"secret"[^{}]{0,200}?"value"\s*:\s*")[^"\s]+/gi },
  { kind: 'keycloak-credential', re: /(?<="value"\s*:\s*")[^"\s]+(?="[^{}]{0,200}?"type"\s*:\s*"secret")/gi },
  // A UUID a few words after "secret": `Client secret for iam-portal: 6d0e…` (Keycloak client secrets are UUIDs).
  { kind: 'uuid-secret', re: new RegExp(`(?<=\\bsecrets?\\b[^\\n]{0,40}?)(?<![\\w-])${UUID}(?![\\w-])`, 'gi') },
];

/** Kubernetes hash labels; their values are pod-template/revision hashes, not secrets. */
const K8S_HASH_KEY = /\b(?:pod-template-hash|controller-revision-hash)[=:]\s*["']?$/;

const TOKEN_RE = /[A-Za-z0-9+/_-]{24,}(?:={1,2}(?![A-Za-z0-9+/_-]))?/g;
const MIN_ENTROPY = 4.0;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode the first characters of a base64 string (no padding needed); '' if it isn't base64. */
export function base64Prefix(s: string, chars = 64): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const ch of s.slice(0, chars)) {
    if (ch === '=') break;
    const v = B64_ALPHABET.indexOf(ch);
    if (v < 0) return '';
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

const B64_TOKEN_RE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/=])/g;

interface Span {
  offset: number;
  length: number;
  kind: string;
}

/** Base64 that decodes to a PEM block or a docker config (`{"auths":…}`). */
function encodedSecrets(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(B64_TOKEN_RE)) {
    const plain = base64Prefix(m[0]);
    if (/^\s*-----BEGIN /.test(plain) || /^\s*\{\s*"auths"\s*:/.test(plain)) out.push({ offset: m.index ?? 0, length: m[0].length, kind: 'encoded-secret' });
  }
  return out;
}

interface YamlKey {
  /** Column of the key (after any `- ` list markers). */
  indent: number;
  /** The line starts a list item (`- key: …`). */
  item: boolean;
  key: string;
  /** Value after the colon ('' if none) and its offset in the line. */
  value: string;
  valueAt: number;
}

function yamlKey(line: string): YamlKey | undefined {
  const m = /^( *)((?:- +)*)("[^"]*"|'[^']*'|[^\s:#'"-][^:#]*?|-[^\s:#][^:#]*?) *:(?: +(.*?))? *$/.exec(line);
  if (!m) return undefined;
  const raw = m[4] ?? '';
  const value = raw.replace(/ +#.*$/, '');
  return {
    indent: (m[1] ?? '').length + (m[2] ?? '').length,
    item: (m[2] ?? '') !== '',
    key: (m[3] ?? '').replace(/^["']|["']$/g, ''),
    value,
    valueAt: raw === '' ? line.length : line.replace(/ +$/, '').length - raw.length,
  };
}

const lineIndent = (line: string): number => {
  const m = /^( *)((?:- +)*)/.exec(line);
  return (m?.[1] ?? '').length + (m?.[2] ?? '').length;
};
const isBlank = (line: string): boolean => /^\s*(?:#.*)?$/.test(line);
const isDocBreak = (line: string): boolean => /^(?:---|\.\.\.)\s*$/.test(line);
const isSecretKind = (k: YamlKey | undefined): boolean => k?.key === 'kind' && /^["']?Secret["']?$/.test(k.value);

/** Is the YAML mapping whose key at line `at` is at column `indent` a `kind: Secret`? */
function yamlObjectIsSecret(lines: readonly string[], at: number, indent: number): boolean {
  for (let j = at - 1; j >= 0; j--) {
    const line = lines[j] ?? '';
    if (isBlank(line)) continue;
    if (isDocBreak(line)) break;
    const ind = lineIndent(line);
    if (ind < indent) break;
    if (ind > indent) continue;
    const k = yamlKey(line);
    if (isSecretKind(k)) return true;
    if (k?.item) break;
  }
  for (let j = at + 1; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (isBlank(line)) continue;
    if (isDocBreak(line)) break;
    const ind = lineIndent(line);
    if (ind < indent) break;
    if (ind > indent) continue;
    const k = yamlKey(line);
    if (k?.item) break;
    if (isSecretKind(k)) return true;
  }
  return false;
}

/** Values under `data:` / `stringData:` of a `kind: Secret` manifest, YAML or JSON (also escaped JSON in annotations). */
function k8sSecretValues(text: string): Span[] {
  const out: Span[] = [];
  const push = (offset: number, value: string): void => {
    const v = value.trim();
    if (v === '' || /^[|>][-+]?\d*$/.test(v) || v === '{}' || v.includes(REDACTED)) return;
    out.push({ offset: offset + value.indexOf(v), length: v.length, kind: 'k8s-secret-data' });
  };

  // YAML
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const starts: number[] = [];
  let pos = 0;
  for (const l of text.split('\n')) {
    starts.push(pos);
    pos += l.length + 1;
  }
  lines.forEach((line, i) => {
    const k = yamlKey(line);
    if (!k || (k.key !== 'data' && k.key !== 'stringData') || k.value !== '') return;
    if (!yamlObjectIsSecret(lines, i, k.indent)) return;
    let child = -1;
    let block = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (l.trim() === '') continue;
      const ind = lineIndent(l);
      if (ind <= k.indent) break;
      if (child < 0) child = ind;
      const base = starts[j] ?? 0;
      if (ind === child) {
        const c = yamlKey(l);
        if (!c) continue;
        block = /^[|>][-+]?\d*$/.test(c.value.trim());
        const unquoted = c.value.replace(/^(["'])(.*)\1$/, '$2');
        push(base + c.valueAt + (unquoted === c.value ? 0 : 1), unquoted);
      } else if (ind > child && block) {
        push(base, l);
      }
    }
  });

  // JSON (also `\"data\":{…}` inside an escaped last-applied-configuration)
  const kindSecret = /\\?"kind\\?"\s*:\s*\\?"Secret\\?"/;
  for (const m of text.matchAll(/\\?"(?:data|stringData)\\?"\s*:\s*\{([^{}]*)\}/g)) {
    const at = m.index ?? 0;
    let start = 0;
    for (let d = 0, j = at - 1; j >= 0; j--) {
      const ch = text[j];
      if (ch === '}') d++;
      else if (ch === '{' && d-- === 0) {
        start = j;
        break;
      }
    }
    let end = text.length;
    for (let d = 0, j = at + m[0].length; j < text.length; j++) {
      const ch = text[j];
      if (ch === '{') d++;
      else if (ch === '}' && d-- === 0) {
        end = j + 1;
        break;
      }
    }
    if (!kindSecret.test(text.slice(start, end))) continue;
    const bodyAt = at + m[0].indexOf('{') + 1;
    for (const v of (m[1] ?? '').matchAll(/\\?"[^"\\]*\\?"\s*:\s*\\?"([^"\\]*)\\?"/g)) {
      const value = v[1] ?? '';
      const valueEnd = (v.index ?? 0) + v[0].length - (v[0].endsWith('\\"') ? 2 : 1);
      push(bodyAt + valueEnd - value.length, value);
    }
  }
  return out;
}

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
 * A token worth reporting as a likely secret. Skipped: hex strings (git SHAs, sha256, hashes),
 * lowercase dash-separated names (pod names, ReplicaSet hashes), UUIDs, path-like tokens and
 * tokens without digits.
 */
export function isHighEntropyToken(token: string): boolean {
  if (/^[0-9a-f]+$|^[0-9A-F]+$/.test(token)) return false;
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

export function scanForLeaks(text: string, opts: LeakScanOptions = {}): LeakFinding[] {
  const spans: Span[] = [];
  const taken = (start: number, end: number): boolean => spans.some((s) => start < s.offset + s.length && s.offset < end);
  const add = (offset: number, length: number, kind: string): void => {
    if (length > 0 && !taken(offset, offset + length)) spans.push({ offset, length, kind });
  };
  const refs = [...text.matchAll(REFERENCE_RE)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const inRef = (pos: number): boolean => refs.some((r) => pos >= r.start && pos < r.end);
  const overlapsRef = (start: number, end: number): boolean => refs.some((r) => start < r.end && r.start < end);
  /** A match that is (or starts with) a variable reference, or was already redacted. */
  const skip = (m: string, at: number): boolean =>
    m.includes(REDACTED) || VARIABLE_REF.test(m.trim()) || inRef(at + (AUTH_SCHEME.exec(m)?.[0].length ?? 0));

  const regexHits = (detectors: readonly Detector[]): void => {
    for (const d of detectors) {
      d.re.lastIndex = 0;
      for (const m of text.matchAll(d.re)) {
        const at = m.index ?? 0;
        const end = at + m[0].length;
        if (m[0] === '' || skip(m[0], at)) continue;
        // `-----BEGIN … PRIVATE KEY-----` with its body already redacted is harmless.
        if (d.kind === 'private-key' && m[0].startsWith('-----BEGIN') && REDACTED_AFTER.test(text.slice(end, end + 40))) continue;
        add(at, m[0].length, d.kind);
      }
    }
  };
  const spanHits = (found: readonly Span[]): void => {
    for (const s of found) if (!overlapsRef(s.offset, s.offset + s.length)) add(s.offset, s.length, s.kind);
  };

  regexHits(EXTRA_DETECTORS);
  regexHits(CONTEXT_DETECTORS);
  spanHits(encodedSecrets(text));
  spanHits(k8sSecretValues(text));
  regexHits(PATTERN_DETECTORS);
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (!isHighEntropyToken(m[0]) || overlapsRef(at, at + m[0].length)) continue;
    if (K8S_HASH_KEY.test(text.slice(Math.max(0, at - 30), at))) continue;
    add(at, m[0].length, 'high-entropy');
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

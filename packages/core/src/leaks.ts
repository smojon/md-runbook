/**
 * Leak scanner: finds things that should not leave the machine (secrets in known formats,
 * private keys, cloud keys, high-entropy tokens, internal domains). It reports; `redactLeaks`
 * replaces the secret findings with [REDACTED].
 */

import { beforeComment, isSpace, trimEndWith } from './lineText';
import { DEFAULT_PATTERNS, REDACTED, WIDENED_PATTERN_NAMES, mergeSpans, patternFinder } from './redact';
import { SpanFinder, Spans, findReferences } from './redactScan';

export interface LeakScanOptions {
  /** Internal DNS suffixes (e.g. `corp.example.com`); hosts under them are reported. */
  internalDomains?: string[];
  /** The widened patterns (0.30) too; default true (false: what 0.29 reported, for comparison). */
  widened?: boolean;
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

/** A redaction pattern as a detector (redact.ts `patternFinder`: the built-in ones that backtrack read in linear time). */
interface PatternDetector {
  kind: string;
  find: SpanFinder;
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
const PATTERN_DETECTORS: readonly PatternDetector[] = DEFAULT_PATTERNS.filter((p) => !WIDENED_PATTERN_NAMES.has(p.name ?? ''))
  .sort((a, b) => Number(GENERIC.has(a.name ?? '')) - Number(GENERIC.has(b.name ?? '')))
  .map((p) => ({ kind: p.name === 'pem-private-key' ? 'private-key' : (p.name ?? 'secret'), find: patternFinder(p) }));
/** The widened patterns (0.30): reported after every other finding, so those stay as they were, and only for a value that looks like a secret. */
const WIDENED_DETECTORS: readonly PatternDetector[] = DEFAULT_PATTERNS.filter((p) => WIDENED_PATTERN_NAMES.has(p.name ?? '')).map((p) => ({
  kind: p.name!,
  find: patternFinder(p),
}));

/** Values that stand for a secret in docs and examples: placeholders, not secrets. */
const PLACEHOLDER =
  /^(?:x+|\*+|\.+|-+|_+|#+|…|<[^>]*>|\{\{.*\}\}|\[[^\]]*\]|n\/a|(?:your|my|the|some|example|sample|dummy|fake|test|placeholder|new|old)(?:[-_.]?\w*)?|change[-_]?me|secrets?|password|passwd|token|redacted|hidden|none|null|undefined|true|false|tbd|todo)$/i;

/**
 * Does the value at [at, end) look like a secret? What the widened patterns find in the leak scan
 * (on runbook source, too: prose such as "api key: see the vault") is reported only then:
 * - one word (after an auth scheme such as `Basic`), not a placeholder, an elided example (`…`,
 *   `...`) or a variable reference;
 * - quoted (`"…"`, or the span is the inside of quotes): 4 characters or more;
 * - else 6 or more with letters and a digit or symbol (`hunter2`), or 12 or more letters of
 *   entropy 3 or more.
 */
export function looksLikeSecret(text: string, at: number, end: number): boolean {
  let v = text.slice(at, end);
  const before = text[at - 1];
  let quoted = (before === '"' || before === "'") && text[end] === before;
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    quoted = true;
    v = v.slice(1, -1);
  }
  v = v.trim().replace(/^(?:Basic|Bearer|Token|Digest|Negotiate|Bot)\s+/i, '');
  if (v === '' || /\s/.test(v) || PLACEHOLDER.test(v) || /…|\.\.\.|\$[{(A-Za-z_]|%\w+%/.test(v)) return false;
  if (quoted) return v.length >= 4;
  return (v.length >= 6 && /[A-Za-z]/.test(v) && /[^A-Za-z]/.test(v)) || (v.length >= 12 && shannonEntropy(v) >= 3);
}

/** Does the value at `at` follow `requirepass` or `masterauth` (with or without dashes) and blanks? */
function afterRedisSetting(text: string, at: number): boolean {
  let i = at;
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i--;
  return i < at && /(?:requirepass|masterauth)$/i.test(text.slice(Math.max(0, i - 11), i));
}

/** Values that are references, not secrets: `$TOKEN`, `${TOKEN}`, `$env:TOKEN`, `%TOKEN%`, `$(cmd)`. */
const VARIABLE_REF = /^(?:(?:Bearer|Basic|token)\s+)?(?:\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*|\$env:\w+|%\w+%|\$\(.*\)|\$\{(?:secret|input|param|out|secretFile):[\w:]+\})$/i;

/**
 * Variable references anywhere in the text (never secrets): md-runbook's own `${secret:NAME}`,
 * `${input:NAME}`, `${param:NAME}`, `${secretFile:NAME}`, shell `${VAR}`, `${VAR:-default}`,
 * `$VAR`, `$(command)`, PowerShell `$env:VAR` and cmd `%VAR%`. Read in linear time by
 * redactScan.ts `findReferences` (`${…` retried each `${` to the line's end).
 */
export const REFERENCE_RE =
  /\$\{(?:secret|input|param|out|secretFile):[\w:]+\}|\$\{[A-Za-z_]\w*(?::?[-=?+][^}\n]*)?\}|\$\((?:[^()\n]|\([^()\n]*\))*\)|\$env:\w+|\$[A-Za-z_]\w*|%[A-Za-z_]\w*%/g;

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

/**
 * `key: value` (after indentation and `- ` markers): a quoted key, or a bare one up to the first
 * `:` (no `#` before it); then nothing, or spaces and the value. Read by hand: the regular
 * expression it replaces backtracked quadratically on a long run of spaces.
 */
function yamlKey(line: string): YamlKey | undefined {
  const m = /^( *)((?:- +)*)/.exec(line)!;
  const keyAt = m[0].length;
  const c = line[keyAt];
  let keyEnd: number;
  if (c === '"' || c === "'") {
    const close = line.indexOf(c, keyAt + 1);
    if (close < 0) return undefined;
    keyEnd = close + 1;
  } else {
    // A bare key: not starting with a blank, `:`, `#` or a quote; `-` only before another letter.
    if (c === undefined || /[\s:#'"]/.test(c)) return undefined;
    if (c === '-' && (keyAt + 1 >= line.length || /[\s:#]/.test(line[keyAt + 1]!))) return undefined;
    const colon = line.indexOf(':', keyAt);
    const hash = line.indexOf('#', keyAt);
    if (colon < 0 || (hash >= 0 && hash < colon)) return undefined;
    keyEnd = colon;
    while (keyEnd > keyAt && line[keyEnd - 1] === ' ') keyEnd--;
  }
  let colon = keyEnd;
  while (line[colon] === ' ') colon++;
  if (line[colon] !== ':') return undefined;
  // After the colon: nothing, or spaces then the value (its trailing spaces dropped).
  const after = colon + 1;
  let raw = '';
  let rawAt = line.length;
  if (after < line.length) {
    if (line[after] !== ' ') return undefined;
    let v = after;
    while (line[v] === ' ') v++;
    raw = trimEndWith(line.slice(v), isSpace);
    rawAt = v;
  }
  return {
    indent: keyAt,
    item: m[2] !== '',
    key: line.slice(keyAt, keyEnd).replace(/^["']|["']$/g, ''),
    value: beforeComment(raw, isSpace),
    valueAt: raw === '' ? line.length : rawAt,
  };
}

export const lineIndent = (line: string): number => {
  const m = /^( *)((?:- +)*)/.exec(line);
  return (m?.[1] ?? '').length + (m?.[2] ?? '').length;
};
const isBlank = (line: string): boolean => /^\s*(?:#.*)?$/.test(line);
const isDocBreak = (line: string): boolean => /^(?:---|\.\.\.)\s*$/.test(line);
const isSecretKind = (k: YamlKey | undefined): boolean => k?.key === 'kind' && /^["']?Secret["']?$/.test(k.value);

/**
 * Is the YAML mapping whose key at line `at` is at column `indent` a `kind: Secret`? Kept as the
 * definition: `secretMappings` answers it for every line in one pass each way.
 */
export function yamlObjectIsSecret(lines: readonly string[], at: number, indent: number): boolean {
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

/**
 * `yamlObjectIsSecret(lines, i, <column of line i>)` for every line i, in linear time. Asked for
 * each `data:` line, the scans above read all the lines at its column: 50 KB of `data:` lines took
 * 46 s. Here each direction keeps, per open column, what its scan would find so far: looking back,
 * a `kind: Secret` at that column since its last list item (included) or shallower line; looking
 * ahead, a `kind: Secret` before the next list item or shallower line. A `---` or `...` ends all.
 */
export function secretMappings(lines: readonly string[]): (at: number) => boolean {
  const keys = lines.map((l) => (isBlank(l) || isDocBreak(l) ? undefined : yamlKey(l)));
  const sweep = (from: number, step: number, update: (seen: boolean, k: YamlKey | undefined) => boolean): Uint8Array => {
    const found = new Uint8Array(lines.length);
    const open: Array<{ indent: number; seen: boolean }> = [];
    for (let i = from; i >= 0 && i < lines.length; i += step) {
      const line = lines[i] ?? '';
      if (isBlank(line)) continue;
      if (isDocBreak(line)) {
        open.length = 0;
        continue;
      }
      const ind = lineIndent(line);
      while (open.length > 0 && open[open.length - 1]!.indent > ind) open.pop();
      let top = open[open.length - 1];
      if (top?.indent === ind) found[i] = top.seen ? 1 : 0;
      else open.push((top = { indent: ind, seen: false }));
      top.seen = update(top.seen, keys[i]);
    }
    return found;
  };
  // Back: a list item is read, then ends the scan. Ahead: a list item ends the scan unread.
  const back = sweep(0, 1, (seen, k) => (k?.item ? isSecretKind(k) : seen || isSecretKind(k)));
  const ahead = sweep(lines.length - 1, -1, (seen, k) => (k?.item ? false : seen || isSecretKind(k)));
  return (at) => back[at] === 1 || ahead[at] === 1;
}

/**
 * For each `[start, end)` (in order), the end of the first `}` at or after it that closes nothing
 * opened at or after `start`, plus one, else the text's length; and for each start, the last `{`
 * before it that nothing before it closes, else 0. As reading back and ahead from each one with a
 * depth count did, in one pass each way: `"data":{}` repeated over 100 KB took 7.5 s.
 */
export function enclosingBraces(text: string, spans: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out = spans.map((): [number, number] => [0, text.length]);
  const opens: number[] = [];
  let at = 0;
  spans.forEach(([start], n) => {
    for (; at < start; at++) {
      if (text[at] === '{') opens.push(at);
      else if (text[at] === '}') opens.pop();
    }
    out[n]![0] = opens[opens.length - 1] ?? 0;
  });
  const closes: number[] = [];
  at = text.length - 1;
  for (let n = spans.length - 1; n >= 0; n--) {
    const end = spans[n]![1];
    for (; at >= end; at--) {
      if (text[at] === '}') closes.push(at);
      else if (text[at] === '{') closes.pop();
    }
    const close = closes[closes.length - 1];
    if (close !== undefined) out[n]![1] = close + 1;
  }
  return out;
}

export const KIND_SECRET_JSON = /\\?"kind\\?"\s*:\s*\\?"Secret\\?"/;

/**
 * For each span (in order, not overlapping), whether the object around it (enclosingBraces) holds
 * a `"kind": "Secret"`, as `KIND_SECRET_JSON.test(text.slice(start, end))` said: one found in the
 * whole text that starts and ends inside it. They don't overlap, so the first one that starts
 * inside says.
 */
export function inSecretObjects(text: string, spans: ReadonlyArray<readonly [number, number]>): boolean[] {
  const kinds = [...text.matchAll(new RegExp(KIND_SECRET_JSON.source, 'g'))].map((k) => ({ start: k.index ?? 0, end: (k.index ?? 0) + k[0].length }));
  return enclosingBraces(text, spans).map(([start, end]) => {
    const kind = kinds[lastStartingBefore(kinds, (k) => k.start, start) + 1];
    return kind !== undefined && kind.end <= end;
  });
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
  const isSecret = secretMappings(lines);
  lines.forEach((line, i) => {
    const k = yamlKey(line);
    if (!k || (k.key !== 'data' && k.key !== 'stringData') || k.value !== '') return;
    // k.indent is the line's column (lineIndent): what secretMappings asks at.
    if (!isSecret(i)) return;
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
  const matches = [...text.matchAll(/\\?"(?:data|stringData)\\?"\s*:\s*\{([^{}]*)\}/g)];
  const secret = inSecretObjects(
    text,
    matches.map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]),
  );
  matches.forEach((m, n) => {
    if (!secret[n]) return;
    const at = m.index ?? 0;
    const bodyAt = at + m[0].indexOf('{') + 1;
    for (const v of (m[1] ?? '').matchAll(/\\?"[^"\\]*\\?"\s*:\s*\\?"([^"\\]*)\\?"/g)) {
      const value = v[1] ?? '';
      const valueEnd = (v.index ?? 0) + v[0].length - (v[0].endsWith('\\"') ? 2 : 1);
      push(bodyAt + valueEnd - value.length, value);
    }
  });
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

/** The index of the last item (sorted by `start`) that starts before `end`, or -1. */
function lastStartingBefore<T>(items: readonly T[], start: (t: T) => number, end: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (start(items[mid]!) < end) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function scanForLeaks(text: string, opts: LeakScanOptions = {}): LeakFinding[] {
  return findLeaks(text, opts);
}

/**
 * scanForLeaks; `secrets` (if given) gets every secret span found, also those that overlap a
 * finding reported before them (each place is reported once).
 */
function findLeaks(text: string, opts: LeakScanOptions, secrets?: Spans): LeakFinding[] {
  // Findings and references don't overlap among themselves and are kept in text order, so the one
  // a span could overlap is the last that starts before its end (found by bisection: a line full of
  // findings and references stays fast).
  const spans: Span[] = [];
  const add = (offset: number, length: number, kind: string): void => {
    if (length <= 0) return;
    if (secrets && kind !== 'internal-domain') secrets.push([offset, offset + length]);
    const i = lastStartingBefore(spans, (s) => s.offset, offset + length);
    const prev = spans[i];
    if (prev && prev.offset + prev.length > offset) return;
    spans.splice(i + 1, 0, { offset, length, kind });
  };
  const refs = findReferences(text).map(([start, end]) => ({ start, end }));
  const overlapsRef = (start: number, end: number): boolean => (refs[lastStartingBefore(refs, (r) => r.start, end)]?.end ?? -1) > start;
  const inRef = (pos: number): boolean => overlapsRef(pos, pos + 1);
  /** A match that is (or starts with) a variable reference, or was already redacted. */
  const skip = (m: string, at: number): boolean =>
    m.includes(REDACTED) || VARIABLE_REF.test(m.trim()) || inRef(at + (AUTH_SCHEME.exec(m)?.[0].length ?? 0));

  const regexHits = (detectors: ReadonlyArray<Detector | PatternDetector>, accept?: (at: number, end: number, kind: string) => boolean): void => {
    for (const d of detectors) {
      if ('re' in d) d.re.lastIndex = 0;
      const found: Spans = 'find' in d ? d.find(text) : [...text.matchAll(d.re)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
      for (const [at, end] of found) {
        const m = text.slice(at, end);
        if (m === '' || skip(m, at) || (accept && !accept(at, end, d.kind))) continue;
        // `-----BEGIN … PRIVATE KEY-----` with its body already redacted is harmless.
        if (d.kind === 'private-key' && m.startsWith('-----BEGIN') && REDACTED_AFTER.test(text.slice(end, end + 40))) continue;
        add(at, m.length, d.kind);
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
  // Redis's settings are also read in prose ("requirepass and masterauth must match") and with
  // placeholders (`requirepass ""`): their values count when they look like a secret.
  regexHits(PATTERN_DETECTORS, (at, end, kind) => kind !== 'secret-flag-value' || !afterRedisSetting(text, at) || looksLikeSecret(text, at, end));
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (!isHighEntropyToken(m[0]) || overlapsRef(at, at + m[0].length)) continue;
    if (K8S_HASH_KEY.test(text.slice(Math.max(0, at - 30), at))) continue;
    add(at, m[0].length, 'high-entropy');
  }
  const domains = domainDetector(opts.internalDomains);
  if (domains) for (const m of text.matchAll(domains.re)) add(m.index ?? 0, m[0].length, domains.kind);
  if (opts.widened !== false) regexHits(WIDENED_DETECTORS, (at, end) => looksLikeSecret(text, at, end));

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

/**
 * Replace every finding except internal domains (not secrets; pseudonymization handles them) with
 * [REDACTED]: the union of all the secret spans found, as createRedactor does, so a finding that
 * overlaps one reported before it still gets its whole span replaced.
 */
export function redactLeaks(text: string, opts: LeakScanOptions = {}): string {
  const secrets: Spans = [];
  findLeaks(text, opts, secrets);
  let out = '';
  let at = 0;
  for (const [start, end] of mergeSpans(secrets)) {
    out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return out + text.slice(at);
}

/** One-line summary such as `2 high-entropy, 1 aws-access-key-id`. */
export function summarizeLeaks(findings: readonly LeakFinding[]): string {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${n} ${k}`).join(', ');
}

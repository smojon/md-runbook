/**
 * Secret redaction. Each pattern's whole match is replaced with [REDACTED]; patterns use
 * lookbehind/lookahead to keep surrounding context (e.g. "Authorization: [REDACTED]"). The
 * regular expressions that backtrack quadratically are read by linear matchers that find exactly
 * the same (redactScan.ts); they stay here as the definition.
 */

import { LINEAR_FINDERS, PASSWORD_TOOLS, PasswordToolRule, SPACED_KEY_WORDS, SpanFinder, Spans } from './redactScan';

export const REDACTED = '[REDACTED]';

export interface RedactionPattern {
  name?: string;
  /** JavaScript regular expression source. */
  pattern: string;
  /** Regex flags; 'g' is always added. */
  flags?: string;
}

const SECRET_KEYS =
  'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|privatekey|client[_-]?key|credentials?|\\.key';

// Placeholders and shell references (`${secret:X}`, `$(cmd)`, `$env:X`, `%X%`) are not values. A bare
// `$NAME` is not exempt: the patterns are case-insensitive, so it could not be told from `$ecret`.
// A backslash after one ends it only before a quote: `\"${secret:X}\"` in escaped JSON.
const REFERENCE = '(?:\\$\\{[^}\\s]*\\}|\\$\\([^)\\r\\n]*\\)|\\$env:\\w+|%[A-Za-z_]\\w*%)(?![^\\s"\',;&\\\\]|\\\\(?!["\']))';
/** A secret value may not be one of these words (e.g. `"token_type": "Bearer"`) or a reference. */
const NOT_A_VALUE = `(?<!\\$\\{(?:secret|secretFile|input|param):)(?!(?:Bearer|Basic|Negotiate|true|false|null|none)\\b)(?!${REFERENCE})`;

/** Marker pattern: redacts the values under `data:` / `stringData:` of Kubernetes Secret manifests. */
const SECRET_MANIFESTS = 'k8s-secret-data';

/** A key's closing quote, also escaped (`\"` in escaped JSON). */
const KEY_QUOTE = `(?:\\\\?["'])?`;
/** A key's value: a backslash before a quote (`\"` of escaped JSON) ends it. */
const KEY_VALUE = `(?:[^\\s"',;&}\\\\]|\\\\(?!["']))+`;
/**
 * A value after `\"` (or `\'`, q) up to the `\"` that closes it, as redactScan.ts `escapedValueEnd`
 * reads it. A run of backslashes before q is read whole: 4m+3 of them are an escaped quote in the
 * value (`s3c\\\"ret`: the JSON was escaped twice), 4m+1 the value's 4m backslashes then the
 * closing `\"`, an even number a bare quote (no value). Before any other character, the run is in
 * the value.
 */
const ESCAPED_VALUE = (q: string): string =>
  `(?:[^${q}\\\\\\r\\n]|\\\\+(?=[^${q}\\\\\\r\\n])|(?:\\\\{4})*\\\\{3}${q}|(?:\\\\{4})+(?=\\\\${q}))+(?=\\\\${q})`;
/**
 * A value in quotes after `key` (the look-behind's source up to the quote), as redactScan.ts
 * `quotedValueEnd` reads it: after `"` or `'`, with backslash escapes (`"abc\"def"`) up to the
 * closing quote, else up to the next quote as before; after `\"` or `\'` (escaped JSON), up to the
 * `\"` or `\'` that closes it (ESCAPED_VALUE).
 */
const quotedAfter = (key: string, notValue = ''): string =>
  ['"', "'"]
    .flatMap((q) => [
      `(?<=${key}${q})${notValue}(?:(?:[^${q}\\\\\\r\\n]|\\\\[^\\r\\n])+|[^${q}\\r\\n]+)(?=${q})`,
      `(?<=${key}\\\\${q})${notValue}${ESCAPED_VALUE(q)}`,
    ])
    .join('|');
const SECRET_KEY = `\\b[\\w.-]*(?:${SECRET_KEYS})[\\w.-]*${KEY_QUOTE}[ \\t]*[:=][ \\t]*`;
const PASS_KEY = `(?:^|[^A-Za-z0-9])(?:[\\w.-]*[_.-])?pass${KEY_QUOTE}[ \\t]*[:=][ \\t]*`;

const BASE_PATTERNS: readonly RedactionPattern[] = [
  {
    name: 'pem-private-key',
    pattern: '(?<=-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\\s\\S]+?(?=-----END [A-Z0-9 ]*PRIVATE KEY-----|$)',
  },
  // Structural (see redactSecretManifests); the regex itself never matches.
  { name: SECRET_MANIFESTS, pattern: '(?!)' },
  {
    name: 'authorization-header',
    // `Authorization: …` runs to the end of the line; `Authorization=…` (hashtables, query strings) stops at , ; } &
    pattern: '(?<=\\b(?:Proxy-)?Authorization["\']?[ \\t]*:[ \\t]*)[^\\s"\'][^\\r\\n"\']*|(?<=\\b(?:Proxy-)?Authorization["\']?[ \\t]*=[ \\t]*)[^\\s"\'][^\\r\\n"\',;}&]*',
    flags: 'i',
  },
  {
    name: 'cookie-header',
    pattern: '(?<=\\b(?:Set-)?Cookie["\']?[ \\t]*[:=][ \\t]*)[^\\s"\'][^\\r\\n"\']*',
    flags: 'i',
  },
  {
    name: 'bearer-token',
    // A token has a digit or a symbol, so "Bearer expires: 300" or "Bearer authentication" stay readable.
    pattern: '(?<=\\bBearer[ \\t]+)(?=[A-Za-z0-9\\-._~+/]*[0-9._~+/-])[A-Za-z0-9\\-._~+/]{8,}=*',
    flags: 'i',
  },
  {
    name: 'jwt',
    pattern: '\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}(?:\\.[A-Za-z0-9_-]*)*',
  },
  {
    name: 'secret-key-value-quoted',
    // password = "Hunter 2 with spaces" → the whole quoted value; {"password": "a\"b"} and
    // {\"password\":\"…\"} (escaped JSON) too
    pattern: quotedAfter(SECRET_KEY, NOT_A_VALUE),
    flags: 'i',
  },
  {
    name: 'secret-key-value',
    pattern: `(?<=${SECRET_KEY}${KEY_QUOTE})${NOT_A_VALUE}${KEY_VALUE}`,
    flags: 'i',
  },
  {
    name: 'pass-key-value',
    // DB_PASS=…, $env:KC_PASS = "…", pass: … (but not bypass/compass); in quotes, the whole value
    // (DB_PASS="p@ss w0rd", DB_PASS=\"…\")
    pattern: `${quotedAfter(PASS_KEY, NOT_A_VALUE)}|(?<=${PASS_KEY}${KEY_QUOTE})${NOT_A_VALUE}${KEY_VALUE}`,
    flags: 'i',
  },
  {
    name: 'secret-flag-value',
    // --password value, --client-secret "value", -p value after login, mysql -pValue, curl -u user:pass
    pattern:
      '(?<=(?:^|\\s)--?(?:password|passwd|pass|secret|client-secret|token|api-key|apikey|access-key|secret-key)[ \\t]+)(?:"(?![$%])[^"\\r\\n]*"|\'(?![$%])[^\'\\r\\n]*\'|(?![-$%])[^\\s"\']+)' +
      '|(?<=\\blogin\\b[^\\r\\n]*?\\s-p[ \\t]*)(?!-)[^\\s"\']+' +
      '|(?<=\\bmysql\\b[^\\r\\n]*?\\s-p)[^\\s"\']+' +
      '|(?<=(?:^|\\s)(?:-u|--user)[ \\t]+[^\\s:"\']+:)[^\\s"\']+',
    flags: 'i',
  },
  {
    name: 'keycloak-client-secret',
    // {"type":"secret","value":"7f3a…"} and "client secret … <uuid>"
    pattern:
      '(?<="type"[ \\t]*:[ \\t]*"secret"[ \\t]*,[ \\t]*"value"[ \\t]*:[ \\t]*")[^"]+' +
      '|(?<=\\bsecret\\b[^\\r\\n]{0,40}?)\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b',
    flags: 'i',
  },
  {
    name: 'url-credentials',
    // https://user:PASSWORD@host, redis://:PASSWORD@host (no user)
    pattern: '(?<=\\b[a-z][a-z0-9+.-]*://[^/\\s:@]*:)[^/\\s@]+(?=@)',
    flags: 'i',
  },
  // Base64 of "-----BEGIN" (encoded keys/certs in Secret data) and of '{"auths"' (docker config).
  { name: 'base64-pem', pattern: '\\bLS0tLS1CRUdJTi[A-Za-z0-9+/=]+' },
  { name: 'base64-dockerconfig', pattern: '\\beyJhdXRocyI6[A-Za-z0-9+/=]+' },
  { name: 'openshift-token', pattern: '\\bsha256~[A-Za-z0-9_-]{20,}' },
  { name: 'github-token', pattern: '\\bgh[pousr]_[A-Za-z0-9]{30,}' },
  { name: 'gitlab-token', pattern: '\\bglpat-[A-Za-z0-9_-]{20,}' },
  { name: 'npm-token', pattern: '\\bnpm_[A-Za-z0-9]{36}\\b' },
  { name: 'anthropic-openai-key', pattern: '\\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}' },
  { name: 'slack-token', pattern: '\\bxox[abposr]-[A-Za-z0-9-]{10,}' },
  { name: 'gcp-api-key', pattern: '\\bAIza[0-9A-Za-z_-]{35}\\b' },
  { name: 'gcp-oauth-token', pattern: '\\bya29\\.[0-9A-Za-z_-]{20,}' },
  { name: 'azure-storage-key', pattern: '(?<=\\b(?:AccountKey|SharedAccessKey)=)[A-Za-z0-9+/=]{20,}', flags: 'i' },
  { name: 'azure-sas-signature', pattern: '(?<=[?&]sig=)[A-Za-z0-9%+/=]{20,}' },
  { name: 'aws-access-key-id', pattern: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b' },
];

/** Every JavaScript space but the line ends: the widened patterns' blank, where the ones above read `[ \t]`. */
const WS = '[^\\S\\r\\n\\u2028\\u2029]';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const base = (name: string): RedactionPattern => BASE_PATTERNS.find((p) => p.name === name)!;
const quotedHeader = (name: string): string => quotedAfter(`\\b${name}${KEY_QUOTE}${WS}*[:=]${WS}*`);

/** A blank within a line, `[^\S\r\n]`. */
const BL = '[^\\S\\r\\n]';
/*
 * password-flag-tool reads a line in command segments, as a shell does, simply: out of quotes,
 * `|`, `;` and `&` (`&&`, `||` too) end one, and so does the line's end. "…" (with `\"` and `\\`
 * escaped) and '…' are quotes; one left open runs to the line's end. A tool counts where its name
 * is a word of its own: after the segment's start, a blank, a quote, `(`, a backtick, `{`, `/` or
 * `\` (`/usr/bin/sshpass`, `C:\…\7z.exe`), and before a blank or a quote (`mongo-1`, `app.zip`,
 * `mongo:7` don't count); in quotes too (`sh -c "redis-cli -a …"`). But not as an option's value:
 * after `-X` or `--name` and blanks (`docker run --name mongo -p 27017:27017`). Its flag counts
 * anywhere after it in the same segment, in quotes too.
 *
 * The linear matcher (redactScan.ts toolsBefore) also reads a line that ends in `\` out of quotes
 * as going on (`redis-cli -h h \` then `  -a …`), and a flag right after that line break. This
 * regular expression doesn't: it reads one line at a time, so the two agree on text without such
 * a line (test/redactScan.test.ts compares them only there, and tests continued lines apart).
 */
/** Out of quotes: a character that neither ends a segment nor opens a quote. */
const OUT_CHAR = `[^\\r\\n|;&"']`;
/** In "…": a character, `\"` or `\\`, or a backslash before any other character. */
const DQ_CHAR = `(?:[^"\\\\\\r\\n]|\\\\["\\\\]|\\\\(?=[^"\\\\\\r\\n]))`;
const SQ_CHAR = `[^'\\r\\n]`;
const SEGMENT_ITEM = `(?:${OUT_CHAR}|"${DQ_CHAR}*"|'${SQ_CHAR}*')`;
/** From out of quotes to a place in the same segment, maybe in a quote opened on the way. */
const OUT_TO = `${SEGMENT_ITEM}*(?:"${DQ_CHAR}*|'${SQ_CHAR}*)?`;
/** What a tool's name may follow, if it doesn't start its segment. */
const TOOL_LEFT = `(?<=[\\s"'(\`{/\\\\])`;
/** Not an option's value: no `-X` or `--name` (a whole word) and blanks right before. */
const NOT_OPTION_VALUE = `(?<!(?<![^\\s])(?:-\\w|--\\w[\\w-]*)\\s+)`;
/** `word` in any case: `[Ss][Cc]…` (the pattern has no i flag: `-p` and `-P` differ). */
const anyCase = (word: string): string => word.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
const toolRule = (r: PasswordToolRule): string => {
  const word = (w: string): string => (r.anyCase ? anyCase(escapeRe(w)) : escapeRe(w));
  const tool = `${NOT_OPTION_VALUE}(?:${r.tools.map(word).join('|')})(?:\\.[Ee][Xx][Ee])?(?=[\\s"'])`;
  // The line's start, the segments before, then the tool out of quotes, in "…" or in '…', and on to a blank and the flag.
  const flag =
    `(?<![^\\r\\n])(?:${SEGMENT_ITEM}*[|;&])*` +
    `(?:(?:${SEGMENT_ITEM}*${TOOL_LEFT})?${tool}${OUT_TO}` +
    `|${SEGMENT_ITEM}*"${DQ_CHAR}*${TOOL_LEFT}${tool}${DQ_CHAR}*(?:"${OUT_TO})?` +
    `|${SEGMENT_ITEM}*'${SQ_CHAR}*${TOOL_LEFT}${tool}${SQ_CHAR}*(?:'${OUT_TO})?)` +
    `${BL}(?:${r.flags.map(word).join('|')})`;
  const gap = r.space && r.glued ? `${WS}*` : r.space ? `${WS}+` : '';
  if (r.split !== undefined) return `(?<=${flag}${gap}[^\\s${escapeRe(r.split)}"']+${escapeRe(r.split)})[^\\s"']+`;
  if (r.prefix !== undefined) return `(?<=${flag}${gap}${escapeRe(r.prefix)})[^\\s"']+`;
  return `(?<=${flag}${gap})(?:"(?![$%])[^"\\r\\n]*"|'(?![$%])[^'\\r\\n]*'|(?![-$%])[^\\s"']+)`;
};
/** `htpasswd -b FILE USER PASSWORD`, `htpasswd -nb USER PASSWORD` (the options in one word). */
const HTPASSWD = ['(?![A-Za-z]*n)', '(?=[A-Za-z]*n)']
  .map((n, i) => `(?<=\\bhtpasswd${WS}+-(?=[A-Za-z]*b)${n}[A-Za-z]+${WS}+${i === 0 ? `[^\\s"']+${WS}+` : ''}[^\\s"']+${WS}+)(?![-$%])[^\\s"']+`)
  .join('|');
const SPACED_KEY = `\\b(?:(?:${SPACED_KEY_WORDS.join('|')})${WS}+key|pass${WS}*phrase)${KEY_QUOTE}${WS}*[:=]${WS}*`;

/**
 * Patterns added in 0.30 for what the ones above missed. They run after them (in the leak scan
 * too), so everything those find stays found as it was; each has a linear matcher (redactScan.ts).
 */
const WIDENED_PATTERNS: readonly RedactionPattern[] = [
  // "Authorization": "Basic …", Authorization: 'Bearer …', {"Cookie": "session=…"}: the value in its quotes.
  { name: 'authorization-header-quoted', pattern: quotedHeader('(?:Proxy-)?Authorization'), flags: 'i' },
  { name: 'cookie-header-quoted', pattern: quotedHeader('(?:Set-)?Cookie'), flags: 'i' },
  // The patterns that read blanks around a separator or after a flag, with Unicode spaces (no-break, ideographic…) as blanks.
  {
    name: 'secret-after-unicode-space',
    pattern: ['authorization-header', 'cookie-header', 'bearer-token', 'secret-key-value-quoted', 'secret-key-value', 'pass-key-value', 'secret-flag-value', 'keycloak-client-secret']
      .map((n) => base(n).pattern.split('[ \\t]').join(WS))
      .join('|'),
    flags: 'i',
  },
  // sshpass -p PASSWORD, redis-cli -a PASSWORD, ldapsearch -w PASSWORD, smbclient -U user%PASSWORD… (PASSWORD_TOOLS)
  { name: 'password-flag-tool', pattern: [...PASSWORD_TOOLS.map(toolRule), HTPASSWD].join('|') },
  // api key: …, secret key = …, "private key": "…", passphrase: … (key names SECRET_KEYS misses)
  {
    name: 'secret-key-value-spaced',
    pattern: `${quotedAfter(SPACED_KEY, NOT_A_VALUE)}|(?<=${SPACED_KEY}${KEY_QUOTE})${NOT_A_VALUE}${KEY_VALUE}`,
    flags: 'i',
  },
];

/** Names of the widened patterns: the leak scan reports what they find last, and only when it looks like a secret. */
export const WIDENED_PATTERN_NAMES: ReadonlySet<string> = new Set(WIDENED_PATTERNS.map((p) => p.name!));

export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [...BASE_PATTERNS, ...WIDENED_PATTERNS];

/**
 * Redact every value under `data:` / `stringData:` when the text contains a Kubernetes Secret
 * (`oc get secret -o yaml|json`). Key names are kept, so the output stays useful.
 */
export function redactSecretManifests(text: string): string {
  if (!/["']?kind["']?[ \t]*:[ \t]*["']?Secret\b/.test(text)) return text;
  // YAML: an indented block under data:/stringData:
  let out = text.replace(/^([ \t]*)(data|stringData):[ \t]*(\r?\n)((?:\1[ \t]+[^\r\n]*(?:\r?\n|$))+)/gm, (_m, indent: string, key: string, nl: string, block: string) => {
    const redacted = block.replace(/^([ \t]+[^\s:#][^:\r\n]*:[ \t]*)(?:\|[-+]?|>[-+]?)?[ \t]*(\S[^\r\n]*)?$/gm, (line: string, k: string, v?: string) =>
      v === undefined || v.startsWith('[REDACTED]') ? line : `${k}${REDACTED}`,
    );
    return `${indent}${key}:${nl}${redacted}`;
  });
  // JSON: "data": { "k": "v", … }
  out = out.replace(/("(?:data|stringData)"[ \t]*:[ \t]*\{)([^{}]*)(\})/g, (_m, open: string, body: string, close: string) =>
    open + body.replace(/("[^"\r\n]+"[ \t]*:[ \t]*)"[^"]*"/g, `$1"${REDACTED}"`) + close,
  );
  return out;
}

export interface Redactor {
  redact(text: string): string;
  /** Patterns that failed to compile, with the reason. */
  errors: string[];
}

function normalizeFlags(flags: string | undefined): string {
  const set = new Set((flags ?? '').replace(/[gy]/g, '').split(''));
  set.add('g');
  return [...set].join('');
}

export function compilePattern(p: string | RedactionPattern): RegExp {
  const spec = typeof p === 'string' ? { pattern: p } : p;
  return new RegExp(spec.pattern, normalizeFlags(spec.flags));
}

const patternKey = (p: string | RedactionPattern): string =>
  typeof p === 'string' ? `g/${p}` : `${[...normalizeFlags(p.flags)].sort().join('')}/${p.pattern}`;

/** Built-in patterns read in linear time (redactScan.ts), by pattern and flags: the same regular expression of yours is too. */
const LINEAR = new Map<string, SpanFinder>();
for (const p of DEFAULT_PATTERNS) {
  const find = p.name === undefined ? undefined : LINEAR_FINDERS.get(p.name);
  if (find) LINEAR.set(patternKey(p), find);
}

/**
 * Where `p` matches in `text` ([start, end), in order, as `text.matchAll` finds them): a built-in
 * pattern in linear time, any other with its regular expression. Throws if that doesn't compile.
 */
export function patternFinder(p: string | RedactionPattern): SpanFinder {
  const linear = LINEAR.get(patternKey(p));
  if (linear) return linear;
  const re = compilePattern(p);
  return (text) => [...text.matchAll(re)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/** `text` with every span (in order, not overlapping) but the empty ones replaced by REDACTED. */
function replaceSpans(text: string, spans: Spans): string {
  if (spans.length === 0) return text;
  let out = '';
  let at = 0;
  for (const [start, end] of spans) {
    if (end === start) continue;
    out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return out + text.slice(at);
}

export function createRedactor(patterns: ReadonlyArray<string | RedactionPattern>): Redactor {
  const steps: Array<(text: string) => string> = [];
  const errors: string[] = [];
  let manifests = false;
  for (const p of patterns) {
    if (typeof p !== 'string' && p.name === SECRET_MANIFESTS) {
      manifests = true;
      continue;
    }
    const linear = LINEAR.get(patternKey(p));
    if (linear) {
      steps.push((text) => replaceSpans(text, linear(text)));
      continue;
    }
    try {
      const re = compilePattern(p);
      steps.push((text) => {
        re.lastIndex = 0;
        // Zero-length matches are left alone so a careless pattern can't splatter the text.
        return text.replace(re, (m) => (m === '' ? m : REDACTED));
      });
    } catch (e) {
      const label = typeof p === 'string' ? p : (p.name ?? p.pattern);
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    errors,
    redact(text: string): string {
      let out = manifests ? redactSecretManifests(text) : text;
      for (const step of steps) out = step(out);
      return out;
    },
  };
}

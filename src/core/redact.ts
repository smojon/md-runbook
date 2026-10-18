/**
 * Secret redaction. Each pattern's whole match is replaced with [REDACTED]; patterns use
 * lookbehind/lookahead to keep surrounding context (e.g. "Authorization: [REDACTED]").
 */

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

/** A secret value may not be one of these words (e.g. `"token_type": "Bearer"`). */
const NOT_A_VALUE = '(?!(?:Bearer|Basic|Negotiate|true|false|null|none)\\b)';

/** Marker pattern: redacts the values under `data:` / `stringData:` of Kubernetes Secret manifests. */
const SECRET_MANIFESTS = 'k8s-secret-data';

export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [
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
    // password = "Hunter 2 with spaces" → the whole quoted value
    pattern: `(?<=\\b[\\w.-]*(?:${SECRET_KEYS})[\\w.-]*["']?[ \\t]*[:=][ \\t]*")${NOT_A_VALUE}[^"\\r\\n]+(?=")|(?<=\\b[\\w.-]*(?:${SECRET_KEYS})[\\w.-]*["']?[ \\t]*[:=][ \\t]*')${NOT_A_VALUE}[^'\\r\\n]+(?=')`,
    flags: 'i',
  },
  {
    name: 'secret-key-value',
    pattern: `(?<=\\b[\\w.-]*(?:${SECRET_KEYS})[\\w.-]*["']?[ \\t]*[:=][ \\t]*["']?)${NOT_A_VALUE}[^\\s"',;&}]+`,
    flags: 'i',
  },
  {
    name: 'pass-key-value',
    // DB_PASS=…, $env:KC_PASS = "…", pass: … (but not bypass/compass)
    pattern: `(?<=(?:^|[^A-Za-z0-9])(?:[\\w.-]*[_.-])?pass["']?[ \\t]*[:=][ \\t]*["']?)${NOT_A_VALUE}[^\\s"',;&}]+`,
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
    pattern: '(?<=\\b[a-z][a-z0-9+.-]*://[^/\\s:@]+:)[^/\\s@]+(?=@)',
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

export function createRedactor(patterns: ReadonlyArray<string | RedactionPattern>): Redactor {
  const regexes: RegExp[] = [];
  const errors: string[] = [];
  let manifests = false;
  for (const p of patterns) {
    if (typeof p !== 'string' && p.name === SECRET_MANIFESTS) {
      manifests = true;
      continue;
    }
    try {
      regexes.push(compilePattern(p));
    } catch (e) {
      const label = typeof p === 'string' ? p : (p.name ?? p.pattern);
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    errors,
    redact(text: string): string {
      let out = manifests ? redactSecretManifests(text) : text;
      for (const re of regexes) {
        re.lastIndex = 0;
        // Zero-length matches are left alone so a careless pattern can't splatter the text.
        out = out.replace(re, (m) => (m === '' ? m : REDACTED));
      }
      return out;
    },
  };
}

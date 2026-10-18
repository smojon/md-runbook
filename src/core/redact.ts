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
  'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|privatekey|client[_-]?key|credentials?';

export const DEFAULT_PATTERNS: readonly RedactionPattern[] = [
  {
    name: 'pem-private-key',
    pattern: '(?<=-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\\s\\S]+?(?=-----END [A-Z0-9 ]*PRIVATE KEY-----|$)',
  },
  {
    name: 'authorization-header',
    pattern: '(?<=\\b(?:Proxy-)?Authorization["\']?[ \\t]*[:=][ \\t]*)[^\\s"\'][^\\r\\n"\']*',
    flags: 'i',
  },
  {
    name: 'cookie-header',
    pattern: '(?<=\\b(?:Set-)?Cookie["\']?[ \\t]*[:=][ \\t]*)[^\\s"\'][^\\r\\n"\']*',
    flags: 'i',
  },
  {
    name: 'bearer-token',
    pattern: '(?<=\\bBearer[ \\t]+)[A-Za-z0-9\\-._~+/]+=*',
    flags: 'i',
  },
  {
    name: 'jwt',
    pattern: '\\beyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}(?:\\.[A-Za-z0-9_-]*)*',
  },
  {
    name: 'secret-key-value',
    pattern: `(?<=\\b[\\w.-]*(?:${SECRET_KEYS})[\\w.-]*["']?[ \\t]*[:=][ \\t]*["']?)[^\\s"',;&}]+`,
    flags: 'i',
  },
  {
    name: 'url-credentials',
    pattern: '(?<=\\b[a-z][a-z0-9+.-]*://[^/\\s:@]+:)[^/\\s@]+(?=@)',
    flags: 'i',
  },
  { name: 'openshift-token', pattern: '\\bsha256~[A-Za-z0-9_-]{20,}' },
  { name: 'github-token', pattern: '\\bgh[pousr]_[A-Za-z0-9]{30,}' },
  { name: 'aws-access-key-id', pattern: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b' },
];

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
  for (const p of patterns) {
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
      let out = text;
      for (const re of regexes) {
        re.lastIndex = 0;
        // Zero-length matches are left alone so a careless pattern can't splatter the text.
        out = out.replace(re, (m) => (m === '' ? m : REDACTED));
      }
      return out;
    },
  };
}

/**
 * Linear-time matchers for the built-in redaction patterns whose regular expressions backtracked
 * quadratically: a look-behind over a run of blanks (20,000 blanks took 6 s to redact, 200,000
 * about ten minutes), a look-behind back to the start of the line (`login … -p`), or a retry from
 * each start inside one run (`eyJ-eyJ-…`, `password="${…`); and keycloak-client-secret, linear
 * but the slowest (a 40-character look-behind at every position). Each matcher finds exactly what
 * its regular expression in redact.ts finds with the g flag (same starts, same ends): the regular
 * expressions stay the definition, and test/redactScan.test.ts compares the two on a large random
 * corpus.
 *
 * A matcher reads the text once, left to right, as the regular expression is tried at each
 * position; what a look-behind checks is read backwards from the one position it can match at.
 */

/** [start, end) of each match, in order, as `text.matchAll(re)` finds them. */
export type Spans = Array<[number, number]>;
export type SpanFinder = (text: string) => Spans;

const TAB = 9;
const LF = 10;
const CR = 13;
const DQ = 34;
const DOLLAR = 36;
const PCT = 37;
const AMP = 38;
const SQ = 39;
const LPAREN = 40;
const RPAREN = 41;
const PLUS = 43;
const COMMA = 44;
const DASH = 45;
const DOT = 46;
const SLASH = 47;
const COLON = 58;
const SEMI = 59;
const EQ = 61;
const US = 95;
const LBRACE = 123;
const RBRACE = 125;
const TILDE = 126;

/** `\s` of a JavaScript regular expression (NaN, past either end of the text, is none of these). */
export function isRegexSpace(c: number): boolean {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}
const isS = isRegexSpace;
/** `[ \t]` */
const isBlank = (c: number): boolean => c === 32 || c === TAB;
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAlnum = (c: number): boolean => isDigit(c) || isAlpha(c);
/** `\w` (ASCII, also with the i flag: no u flag). */
const isWord = (c: number): boolean => isAlnum(c) || c === US;
const isQuote = (c: number): boolean => c === DQ || c === SQ;
/** ASCII letters folded to lower case: the i flag without the u flag folds nothing else. */
const lower = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);

/** A run that `stop` ends, cached: asked again from inside the last run, it answers at once. */
class NextStop {
  private from = -1;
  private at = -1;
  constructor(
    private readonly s: Scan,
    private readonly stop: (c: number) => boolean,
  ) {}
  /** The first index ≥ i whose character is a stop, or the text's length. */
  find(i: number): number {
    if (i >= this.from && i <= this.at) return this.at;
    let e = i;
    while (e < this.s.n && !this.stop(this.s.c(e))) e++;
    this.from = i;
    this.at = e;
    return e;
  }
}

class Scan {
  readonly n: number;
  private readonly stops = new Map<string, NextStop>();
  private readonly lineWords = new Map<string, Int32Array>();
  constructor(readonly t: string) {
    this.n = t.length;
  }
  c(i: number): number {
    return this.t.charCodeAt(i);
  }
  /** Does `word` (lower case) start at i, ASCII letters in either case? */
  is(i: number, word: string): boolean {
    if (i < 0 || i + word.length > this.n) return false;
    for (let k = 0; k < word.length; k++) if (lower(this.c(i + k)) !== word.charCodeAt(k)) return false;
    return true;
  }
  /** Does `word` start at i, exactly? */
  has(i: number, word: string): boolean {
    return i >= 0 && this.t.startsWith(word, i);
  }
  /** The start of the run of blanks that ends at i (i itself if there is none). */
  blanksBefore(i: number): number {
    while (i > 0 && isBlank(this.c(i - 1))) i--;
    return i;
  }
  /** The end of the run of `ok` characters from i. */
  runEnd(i: number, ok: (c: number) => boolean): number {
    while (i < this.n && ok(this.c(i))) i++;
    return i;
  }
  next(key: string, stop: (c: number) => boolean): NextStop {
    let s = this.stops.get(key);
    if (!s) this.stops.set(key, (s = new NextStop(this, stop)));
    return s;
  }
  /**
   * The end of the last `\bword\b` (lower case, either case in the text) that ends at or before
   * i with no line break between its end and i (as `\bword\b[^\r\n]*?` before i), or -1.
   */
  wordEndOnLine(word: string, i: number): number {
    let best = this.lineWords.get(word);
    if (!best) {
      best = new Int32Array(this.n + 1);
      let cur = -1;
      const len = word.length;
      for (let x = 0; x <= this.n; x++) {
        const prev = this.c(x - 1);
        if (prev === CR || prev === LF) cur = -1;
        if (x >= len && this.is(x - len, word) && !isWord(this.c(x - len - 1)) && !isWord(this.c(x))) cur = x;
        best[x] = cur;
      }
      this.lineWords.set(word, best);
    }
    return i >= 0 && i <= this.n ? (best[i] ?? -1) : -1;
  }
}

/** Every match of `matchAt` (the end of the match at p, or -1), as a global regular expression finds them. */
function finder(matchAt: (s: Scan, p: number) => number, mustHave?: RegExp): SpanFinder {
  return (text) => {
    const out: Spans = [];
    if (mustHave && !mustHave.test(text)) return out;
    const s = new Scan(text);
    for (let p = 0; p < s.n; ) {
      const e = matchAt(s, p);
      if (e > p) {
        out.push([p, e]);
        p = e;
      } else p++;
    }
    return out;
  };
}

// --- authorization-header, cookie-header -------------------------------------------------------

/** `[^\r\n"']` */
const headerChar = (c: number): boolean => c === c && c !== CR && c !== LF && c !== DQ && c !== SQ;
/** `[^\r\n"',;}&]` */
const headerFieldChar = (c: number): boolean => headerChar(c) && c !== COMMA && c !== SEMI && c !== RBRACE && c !== AMP;
/** `[^\s"']` */
const flagValueChar = (c: number): boolean => c === c && !isS(c) && !isQuote(c);

/**
 * `(?<=\bNAME["']?[ \t]*[:=][ \t]*)[^\s"'][^\r\n"']*` at p: `name` (lower case) ends before the
 * blanks, quote, separator and blanks before p. `fieldAfterEq`: after `=` the value stops at
 * `, ; } &` too. A `Proxy-` or `Set-` before the name changes nothing: `-` is no word character.
 */
function header(s: Scan, p: number, name: string, fieldAfterEq: boolean): number {
  if (!flagValueChar(s.c(p))) return -1;
  const j = s.blanksBefore(p);
  const sep = s.c(j - 1);
  if (sep !== COLON && sep !== EQ) return -1;
  let k = s.blanksBefore(j - 1);
  if (isQuote(s.c(k - 1))) k--;
  if (!s.is(k - name.length, name) || isWord(s.c(k - name.length - 1))) return -1;
  return s.runEnd(p + 1, fieldAfterEq && sep === EQ ? headerFieldChar : headerChar);
}

// --- bearer-token --------------------------------------------------------------------------------

/** `[A-Za-z0-9\-._~+/]` */
const tokenChar = (c: number): boolean => isAlnum(c) || c === DASH || c === DOT || c === US || c === TILDE || c === PLUS || c === SLASH;
/** `[0-9._~+/-]` */
const tokenMark = (c: number): boolean => isDigit(c) || c === DOT || c === US || c === TILDE || c === PLUS || c === SLASH || c === DASH;

/** `(?<=\bBearer[ \t]+)(?=[…]*[0-9._~+/-])[…]{8,}=*` */
function bearer(s: Scan, p: number): number {
  if (!tokenChar(s.c(p)) || !isBlank(s.c(p - 1))) return -1;
  const j = s.blanksBefore(p);
  if (!s.is(j - 6, 'bearer') || isWord(s.c(j - 7))) return -1;
  let e = p;
  let mark = false;
  for (; tokenChar(s.c(e)); e++) if (tokenMark(s.c(e))) mark = true;
  if (!mark || e - p < 8) return -1;
  while (s.c(e) === EQ) e++;
  return e;
}

// --- jwt -----------------------------------------------------------------------------------------

/** `[A-Za-z0-9_-]` */
const jwtChar = (c: number): boolean => isWord(c) || c === DASH;

/** `\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)*` (case-sensitive) */
function jwt(s: Scan, p: number): number {
  if (s.c(p) !== 101 || s.c(p + 1) !== 121 || s.c(p + 2) !== 74 || isWord(s.c(p - 1))) return -1;
  // Each `eyJ` inside one run ends its first part at the same place: found once.
  const r1 = s.next('jwt', (c) => !jwtChar(c)).find(p + 3);
  if (r1 - (p + 3) < 5 || s.c(r1) !== DOT) return -1;
  let e = s.runEnd(r1 + 1, jwtChar);
  if (e - (r1 + 1) < 5) return -1;
  while (s.c(e) === DOT) e = s.runEnd(e + 1, jwtChar);
  return e;
}

// --- secret-key-value, secret-key-value-quoted, pass-key-value -----------------------------------

/** The names in SECRET_KEYS (redact.ts), each spelling of `[_-]?` and `s?` written out (`credential` covers `credentials`). */
const KEY_NAMES = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'api-key',
  'accesskey',
  'access_key',
  'access-key',
  'privatekey',
  'private_key',
  'private-key',
  'clientkey',
  'client_key',
  'client-key',
  'credential',
  '.key',
];
const KEY_FIRST = new Set(KEY_NAMES.map((k) => k.charCodeAt(0)));
/** `[\w.-]` */
const keyChar = (c: number): boolean => isWord(c) || c === DOT || c === DASH;

/**
 * Does `\b[\w.-]*(?:SECRET_KEYS)[\w.-]*` end at k? The run of `[\w.-]` that ends at k must hold a
 * key name, with a word boundary at or before the last one's start.
 */
function secretKeyEndsAt(s: Scan, k: number): boolean {
  let r0 = k;
  while (r0 > 0 && keyChar(s.c(r0 - 1))) r0--;
  if (r0 === k) return false;
  let last = -1;
  for (let i = k - 1; i >= r0 && last < 0; i--) {
    if (!KEY_FIRST.has(lower(s.c(i)))) continue;
    for (const name of KEY_NAMES) {
      if (i + name.length <= k && s.is(i, name)) {
        last = i;
        break;
      }
    }
  }
  if (last < 0) return false;
  for (let i = r0; i <= last; i++) if (isWord(s.c(i - 1)) !== isWord(s.c(i))) return true;
  return false;
}

/** Does `(?:^|[^A-Za-z0-9])(?:[\w.-]*[_.-])?pass` end at k? (The optional group adds nothing: its last character is already no letter or digit.) */
function passKeyEndsAt(s: Scan, k: number): boolean {
  return s.is(k - 4, 'pass') && !isAlnum(s.c(k - 5));
}

const NOT_VALUE_WORDS = ['bearer', 'basic', 'negotiate', 'true', 'false', 'null', 'none'];
const REFERENCE_PREFIXES = ['${secret:', '${secretfile:', '${input:', '${param:'];

/** `(?![^\s"',;&])` at i */
function referenceEndsAt(s: Scan, i: number): boolean {
  if (i >= s.n) return true;
  const c = s.c(i);
  return isS(c) || c === DQ || c === SQ || c === COMMA || c === SEMI || c === AMP;
}

/** REFERENCE (redact.ts) at p: `${…}`, `$(…)`, `$env:X`, `%X%`, then the end of the value. */
function isReference(s: Scan, p: number): boolean {
  const c = s.c(p);
  if (c === DOLLAR) {
    const d = s.c(p + 1);
    if (d === LBRACE) {
      const e = s.next('ref{', (x) => x === RBRACE || isS(x)).find(p + 2);
      return s.c(e) === RBRACE && referenceEndsAt(s, e + 1);
    }
    if (d === LPAREN) {
      const e = s.next('ref(', (x) => x === RPAREN || x === CR || x === LF).find(p + 2);
      return s.c(e) === RPAREN && referenceEndsAt(s, e + 1);
    }
    if (s.is(p, '$env:')) {
      const e = s.runEnd(p + 5, isWord);
      return e > p + 5 && referenceEndsAt(s, e);
    }
    return false;
  }
  if (c === PCT) {
    const d = s.c(p + 1);
    if (!isAlpha(d) && d !== US) return false;
    const e = s.runEnd(p + 2, isWord);
    return s.c(e) === PCT && referenceEndsAt(s, e + 1);
  }
  return false;
}

/** NOT_A_VALUE (redact.ts) at p. */
function notAValue(s: Scan, p: number): boolean {
  for (const w of REFERENCE_PREFIXES) if (s.is(p - w.length, w)) return false;
  for (const w of NOT_VALUE_WORDS) if (s.is(p, w) && !isWord(s.c(p + w.length))) return false;
  return !isReference(s, p);
}

/** `[^\s"',;&}]` */
const keyValueChar = (c: number): boolean => c === c && !isS(c) && !isQuote(c) && c !== COMMA && c !== SEMI && c !== AMP && c !== RBRACE;

/**
 * The start of the key before `["']?[ \t]*[:=][ \t]*` that ends at i, or -1: the quote before
 * the blanks is the key's own (a key name has no quote).
 */
function keyEnd(s: Scan, i: number): number {
  const j = s.blanksBefore(i);
  const sep = s.c(j - 1);
  if (sep !== COLON && sep !== EQ) return -1;
  let k = s.blanksBefore(j - 1);
  if (isQuote(s.c(k - 1))) k--;
  return k;
}

/** `(?<=KEY["']?[ \t]*[:=][ \t]*["']?)NOT_A_VALUE[^\s"',;&}]+` */
function keyValue(s: Scan, p: number, keyEndsAt: (s: Scan, k: number) => boolean): number {
  if (!keyValueChar(s.c(p))) return -1;
  // A quote right before p is the optional one: without it, `[:=]` would have to be that quote.
  const k = keyEnd(s, isQuote(s.c(p - 1)) ? p - 1 : p);
  if (k < 0 || !keyEndsAt(s, k) || !notAValue(s, p)) return -1;
  return s.runEnd(p, keyValueChar);
}

/** `(?<=KEY["']?[ \t]*[:=][ \t]*Q)NOT_A_VALUE[^Q\r\n]+(?=Q)` for the quote Q before p. */
function quotedKeyValue(s: Scan, p: number): number {
  const q = s.c(p - 1);
  if (!isQuote(q)) return -1;
  const k = keyEnd(s, p - 1);
  if (k < 0 || !secretKeyEndsAt(s, k) || !notAValue(s, p)) return -1;
  const e = s.next(q === DQ ? 'q"' : "q'", (c) => c === q || c === CR || c === LF).find(p);
  return e > p && s.c(e) === q ? e : -1;
}

// --- secret-flag-value ---------------------------------------------------------------------------

const FLAG_NAMES = ['password', 'passwd', 'pass', 'secret', 'client-secret', 'token', 'api-key', 'apikey', 'access-key', 'secret-key'];

/** Does `(?:^|\s)--?(?:FLAG_NAMES)` end at j? */
function secretFlagEndsAt(s: Scan, j: number): boolean {
  for (const name of FLAG_NAMES) {
    const d = j - name.length - 1;
    if (s.c(d) !== DASH || !s.is(d + 1, name)) continue;
    if (d === 0 || isS(s.c(d - 1))) return true;
    if (s.c(d - 1) === DASH && (d === 1 || isS(s.c(d - 2)))) return true;
  }
  return false;
}

/** `(?<=(?:^|\s)--?(?:FLAG_NAMES)[ \t]+)(?:"(?![$%])[^"\r\n]*"|'(?![$%])[^'\r\n]*'|(?![-$%])[^\s"']+)` */
function flagValue(s: Scan, p: number): number {
  const c = s.c(p);
  // Every value starts with no blank: inside a run of blanks, nothing is read back.
  if (!flagValueChar(c) && !isQuote(c)) return -1;
  if (!isBlank(s.c(p - 1)) || !secretFlagEndsAt(s, s.blanksBefore(p))) return -1;
  if (isQuote(c)) {
    const d = s.c(p + 1);
    if (d === DOLLAR || d === PCT) return -1;
    const e = s.next(c === DQ ? 'q"' : "q'", (x) => x === c || x === CR || x === LF).find(p + 1);
    return s.c(e) === c ? e + 1 : -1;
  }
  if (c === DASH || c === DOLLAR || c === PCT || !flagValueChar(c)) return -1;
  return s.runEnd(p, flagValueChar);
}

/** `(?<=\bWORD\b[^\r\n]*?\s-p[ \t]*)` (blanks: login) or `(?<=\bWORD\b[^\r\n]*?\s-p)` (mysql), then `[^\s"']+` */
function dashP(s: Scan, p: number, word: string, blanks: boolean): number {
  if (!flagValueChar(s.c(p))) return -1;
  const j = blanks ? s.blanksBefore(p) : p;
  if (lower(s.c(j - 1)) !== 112 || s.c(j - 2) !== DASH || !isS(s.c(j - 3))) return -1;
  if (s.wordEndOnLine(word, j - 3) < 0) return -1;
  return s.runEnd(p, flagValueChar);
}

/** `[^\s:"']` */
const userChar = (c: number): boolean => flagValueChar(c) && c !== COLON;

/** `(?<=(?:^|\s)(?:-u|--user)[ \t]+[^\s:"']+:)[^\s"']+` */
function userPassword(s: Scan, p: number): number {
  if (!flagValueChar(s.c(p)) || s.c(p - 1) !== COLON) return -1;
  let u = p - 1;
  while (u > 0 && userChar(s.c(u - 1))) u--;
  if (u === p - 1 || !isBlank(s.c(u - 1))) return -1;
  const v = s.blanksBefore(u);
  const dashU = s.c(v - 2) === DASH && lower(s.c(v - 1)) === 117 && (v === 2 || isS(s.c(v - 3)));
  const dashUser = s.is(v - 6, '--user') && (v === 6 || isS(s.c(v - 7)));
  return dashU || dashUser ? s.runEnd(p, flagValueChar) : -1;
}

function secretFlag(s: Scan, p: number): number {
  // Each alternative's look-behind ends in a blank, the `p` of `-p`, or a colon.
  const prev = s.c(p - 1);
  if (!isBlank(prev) && lower(prev) !== 112 && prev !== COLON) return -1;
  let e = flagValue(s, p);
  // `(?!-)`: login's value doesn't start with a dash.
  if (e < 0 && s.c(p) !== DASH) e = dashP(s, p, 'login', true);
  if (e < 0) e = dashP(s, p, 'mysql', false);
  if (e < 0) e = userPassword(s, p);
  return e;
}

// --- keycloak-client-secret --------------------------------------------------------------------

/** `(?<="type"[ \t]*:[ \t]*"secret"[ \t]*,[ \t]*"value"[ \t]*:[ \t]*")[^"]+`, read back from the quote before p. */
function keycloakJson(s: Scan, p: number): number {
  if (s.c(p - 1) !== DQ || s.c(p) === DQ) return -1;
  let i = s.blanksBefore(p - 1);
  for (const part of [':', '"value"', ',', '"secret"', ':', '"type"']) {
    if (!s.is(i - part.length, part)) return -1;
    i = part === '"type"' ? i : s.blanksBefore(i - part.length);
  }
  return s.runEnd(p, (c) => c !== DQ);
}

const isHex = (c: number): boolean => isDigit(c) || (lower(c) >= 97 && lower(c) <= 102);
const UUID_GROUPS = [8, 4, 4, 4, 12];

/** `(?<=\bsecret\b[^\r\n]{0,40}?)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b` (i flag) */
function secretUuid(s: Scan, p: number): number {
  if (!isHex(s.c(p)) || isWord(s.c(p - 1))) return -1;
  let e = p;
  for (const [g, len] of UUID_GROUPS.entries()) {
    if (g > 0 && s.c(e++) !== DASH) return -1;
    for (let k = 0; k < len; k++) if (!isHex(s.c(e++))) return -1;
  }
  if (isWord(s.c(e))) return -1;
  const w = s.wordEndOnLine('secret', p);
  return w >= 0 && w >= p - 40 ? e : -1;
}

function keycloakSecret(s: Scan, p: number): number {
  const e = keycloakJson(s, p);
  return e >= 0 ? e : secretUuid(s, p);
}

// --- variable references (leaks.ts REFERENCE_RE) ----------------------------------------------

const REFERENCE_NAMES = ['secret', 'input', 'param', 'out', 'secretFile'];
/** `[\w:]` */
const wordOrColon = (c: number): boolean => isWord(c) || c === COLON;
/** `[-=?+]` */
const isExpansionOp = (c: number): boolean => c === DASH || c === EQ || c === 63 || c === PLUS;

/** REFERENCE_RE (leaks.ts) at p: its alternatives in order, each read once. */
function referenceAt(s: Scan, p: number): number {
  const c = s.c(p);
  const d = s.c(p + 1);
  if (c === PCT) {
    if (!isAlpha(d) && d !== US) return -1;
    const e = s.runEnd(p + 2, isWord);
    return s.c(e) === PCT ? e + 1 : -1;
  }
  if (c !== DOLLAR) return -1;
  if (d === LBRACE) {
    // `\$\{(?:secret|input|param|out|secretFile):[\w:]+\}`
    for (const name of REFERENCE_NAMES) {
      const at = p + 2 + name.length + 1;
      if (!s.has(p + 2, name) || s.c(at - 1) !== COLON) continue;
      const e = s.runEnd(at, wordOrColon);
      if (e > at && s.c(e) === RBRACE) return e + 1;
    }
    // `\$\{[A-Za-z_]\w*(?::?[-=?+][^}\n]*)?\}`
    const a = s.c(p + 2);
    if (!isAlpha(a) && a !== US) return -1;
    const r = s.runEnd(p + 3, isWord);
    const op = s.c(r) === COLON && isExpansionOp(s.c(r + 1)) ? r + 2 : isExpansionOp(s.c(r)) ? r + 1 : -1;
    if (op < 0) return s.c(r) === RBRACE ? r + 1 : -1;
    // Each `${` inside one run ends at the same `}` or line break: found once.
    const e = s.next('ref}', (x) => x === RBRACE || x === LF).find(op);
    return s.c(e) === RBRACE ? e + 1 : -1;
  }
  if (d === LPAREN) {
    // `\$\((?:[^()\n]|\([^()\n]*\))*\)`
    for (let i = p + 2; i < s.n; ) {
      const x = s.c(i);
      if (x === RPAREN) return i + 1;
      if (x === LF) return -1;
      if (x !== LPAREN) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < s.n && s.c(j) !== LPAREN && s.c(j) !== RPAREN && s.c(j) !== LF) j++;
      if (s.c(j) !== RPAREN) return -1;
      i = j + 1;
    }
    return -1;
  }
  // `\$env:\w+`, else `\$[A-Za-z_]\w*`
  if (s.has(p + 1, 'env:')) {
    const e = s.runEnd(p + 5, isWord);
    if (e > p + 5) return e;
  }
  return isAlpha(d) || d === US ? s.runEnd(p + 2, isWord) : -1;
}

/** Where leaks.ts REFERENCE_RE matches, in linear time (its `${NAME:-…}` alternative retried each `${` to the line's end). */
export const findReferences: SpanFinder = finder(referenceAt);

/** The built-in patterns (by name) that have a linear matcher. redact.ts uses one only for that exact pattern. */
export const LINEAR_FINDERS: ReadonlyMap<string, SpanFinder> = new Map([
  ['authorization-header', finder((s, p) => header(s, p, 'authorization', true), /authorization/i)],
  ['cookie-header', finder((s, p) => header(s, p, 'cookie', false), /cookie/i)],
  ['bearer-token', finder(bearer, /bearer/i)],
  ['jwt', finder(jwt, /eyJ/)],
  ['secret-key-value-quoted', finder(quotedKeyValue, /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|credential|\.key/i)],
  ['secret-key-value', finder((s, p) => keyValue(s, p, secretKeyEndsAt), /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|credential|\.key/i)],
  ['pass-key-value', finder((s, p) => keyValue(s, p, passKeyEndsAt), /pass/i)],
  ['secret-flag-value', finder(secretFlag, /-/)],
  ['keycloak-client-secret', finder(keycloakSecret, /secret/i)],
]);

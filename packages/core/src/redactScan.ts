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
const AT = 64;
const BACKSLASH = 92;
const US = 95;
const BACKTICK = 96;
const LBRACE = 123;
const PIPE = 124;
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
export const isBlank = (c: number): boolean => c === 32 || c === TAB;
export const isDigit = (c: number): boolean => c >= 48 && c <= 57;
export const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
export const isAlnum = (c: number): boolean => isDigit(c) || isAlpha(c);
/** `\w` (ASCII, also with the i flag: no u flag). */
export const isWord = (c: number): boolean => isAlnum(c) || c === US;
export const isQuote = (c: number): boolean => c === DQ || c === SQ;
/** ASCII letters folded to lower case: the i flag without the u flag folds nothing else. */
export const lower = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);

/** A run that `stop` ends, cached: asked again from inside the last run, it answers at once. */
export class NextStop {
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

export class Scan {
  readonly n: number;
  private readonly stops = new Map<string, NextStop>();
  private readonly lineWords = new Map<string, Int32Array>();
  /** password-flag-tool: the rules each place is in a command of (toolsBefore), and those anywhere. */
  toolMasks: Int32Array | undefined;
  toolsPresent = 0;
  /** `blank`: what `[ 	]` reads (the widened patterns read every space but line ends). */
  constructor(
    readonly t: string,
    readonly blank: (c: number) => boolean = isBlank,
  ) {
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
    while (i > 0 && this.blank(this.c(i - 1))) i--;
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
export function finder(matchAt: (s: Scan, p: number) => number, mustHave?: RegExp, blank: (c: number) => boolean = isBlank): SpanFinder {
  return (text) => {
    const out: Spans = [];
    if (mustHave && !mustHave.test(text)) return out;
    const s = new Scan(text, blank);
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
  if (!tokenChar(s.c(p)) || !s.blank(s.c(p - 1))) return -1;
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
  'rediscli_auth',
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

/** `(?![^\s"',;&\\]|\\(?!["']))` at i: a backslash ends a reference only before a quote (`\"` of escaped JSON). */
function referenceEndsAt(s: Scan, i: number): boolean {
  if (i >= s.n) return true;
  const c = s.c(i);
  if (c === BACKSLASH) return isQuote(s.c(i + 1));
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

/** The end of a key's value from p, `(?:[^\s"',;&}\\]|\\(?!["']))*`: a backslash before a quote (`\"` of escaped JSON) ends it. */
function keyValueEnd(s: Scan, p: number): number {
  let e = p;
  for (;;) {
    const c = s.c(e);
    if (c === BACKSLASH ? isQuote(s.c(e + 1)) : !keyValueChar(c)) return e;
    e++;
  }
}

/** Where the quote before p starts (`\"` of escaped JSON: at its backslash), or -1 if there is no quote. */
function quoteOpen(s: Scan, p: number): number {
  if (!isQuote(s.c(p - 1))) return -1;
  return s.c(p - 2) === BACKSLASH ? p - 2 : p - 1;
}

/**
 * The start of the key before `(?:\\?["'])?[ \t]*[:=][ \t]*` that ends at i, or -1: the quote
 * before the blanks (with a backslash before it, escaped JSON) is the key's own (a key name has no
 * quote or backslash).
 */
function keyEnd(s: Scan, i: number): number {
  const j = s.blanksBefore(i);
  const sep = s.c(j - 1);
  if (sep !== COLON && sep !== EQ) return -1;
  let k = s.blanksBefore(j - 1);
  if (isQuote(s.c(k - 1))) {
    k--;
    if (s.c(k - 1) === BACKSLASH) k--;
  }
  return k;
}

/** `(?<=KEY(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?)NOT_A_VALUE(?:[^\s"',;&}\\]|\\(?!["']))+` */
function keyValue(s: Scan, p: number, keyEndsAt: (s: Scan, k: number) => boolean): number {
  const c = s.c(p);
  if (c === BACKSLASH ? isQuote(s.c(p + 1)) : !keyValueChar(c)) return -1;
  // A quote right before p is the optional one: without it, `[:=]` would have to be that quote.
  const o = quoteOpen(s, p);
  const k = keyEnd(s, o >= 0 ? o : p);
  if (k < 0 || !keyEndsAt(s, k) || !notAValue(s, p)) return -1;
  return keyValueEnd(s, p);
}

/**
 * The end of the quoted value that starts at p (QUOTED_VALUE in redact.ts), or -1. After `"` or
 * `'`: read with backslash escapes up to the closing quote, else (a backslash before the line's
 * end) up to the next quote as before. After `\"` or `\'` (escaped JSON): up to `\"` or `\'`.
 */
export function quotedValueEnd(s: Scan, p: number): number {
  const q = s.c(p - 1);
  if (!isQuote(q)) return -1;
  if (s.c(p - 2) === BACKSLASH) return escapedValueEnd(s, p, q);
  return quoteRestEnd(s, p, q);
}

/**
 * From p in a quote q opened before it, the closing quote (QUOTE_REST in redact.ts), or -1 if
 * there is no value: read with backslash escapes, else (a backslash before the line's end) up to
 * the next q.
 */
function quoteRestEnd(s: Scan, p: number, q: number): number {
  let e = p;
  for (;;) {
    const c = s.c(e);
    if (c !== c || c === CR || c === LF || c === q) break;
    if (c !== BACKSLASH) {
      e++;
      continue;
    }
    const d = s.c(e + 1);
    if (d !== d || d === CR || d === LF) break;
    e += 2;
  }
  if (e > p && s.c(e) === q) return e;
  const f = s.next(q === DQ ? 'q"' : "q'", (c) => c === q || c === CR || c === LF).find(p);
  return f > p && s.c(f) === q ? f : -1;
}

/**
 * The end of a value after `\"` or `\'` (escaped JSON, ESCAPED_VALUE in redact.ts): up to the `\"`
 * that closes it, or -1. A run of k backslashes before the quote: k = 1, 5, 9… is a closing `\"`
 * (after (k-1)/2 escaped backslashes, an even number), k = 3, 7… an escaped quote in the value
 * (`s3c\\\"ret`), an even k a bare quote (the string around ends: no value).
 */
function escapedValueEnd(s: Scan, p: number, q: number): number {
  for (let e = p; ; ) {
    const c = s.c(e);
    if (c !== c || c === CR || c === LF || c === q) return -1;
    if (c !== BACKSLASH) {
      e++;
      continue;
    }
    const r = s.runEnd(e, (x) => x === BACKSLASH);
    const d = s.c(r);
    if (d !== d || d === CR || d === LF) return -1;
    if (d !== q) e = r;
    else if ((r - e) % 4 === 3) e = r + 1;
    else if ((r - e) % 4 === 1) return r - 1 > p ? r - 1 : -1;
    else return -1;
  }
}

/** `(?<=KEY(?:\\?["'])?[ \t]*[:=][ \t]*)NOT_A_VALUE` then QUOTED_VALUE (redact.ts), for the quote before p. */
function quotedValueAfterKey(s: Scan, p: number, keyEndsAt: (s: Scan, k: number) => boolean): number {
  const o = quoteOpen(s, p);
  if (o < 0) return -1;
  const k = keyEnd(s, o);
  if (k < 0 || !keyEndsAt(s, k) || !notAValue(s, p)) return -1;
  return quotedValueEnd(s, p);
}

const quotedKeyValue = (s: Scan, p: number): number => quotedValueAfterKey(s, p, secretKeyEndsAt);

// --- secret-flag-value ---------------------------------------------------------------------------

export const FLAG_NAMES = ['password', 'passwd', 'pass', 'secret', 'client-secret', 'token', 'api-key', 'apikey', 'access-key', 'secret-key', 'requirepass', 'masterauth'];
/** Redis's password settings count without dashes too: `requirepass …` in redis.conf, `CONFIG SET requirepass …`. */
export const BARE_FLAG_NAMES = ['requirepass', 'masterauth'];

/** Does `(?:^|\s)(?:--?(?:FLAG_NAMES)|BARE_FLAG_NAMES)` end at j? */
function secretFlagEndsAt(s: Scan, j: number): boolean {
  for (const name of FLAG_NAMES) {
    const d = j - name.length - 1;
    if (s.c(d) !== DASH || !s.is(d + 1, name)) continue;
    if (d === 0 || isS(s.c(d - 1))) return true;
    if (s.c(d - 1) === DASH && (d === 1 || isS(s.c(d - 2)))) return true;
  }
  for (const name of BARE_FLAG_NAMES) {
    const d = j - name.length;
    if (s.is(d, name) && (d === 0 || isS(s.c(d - 1)))) return true;
  }
  return false;
}

/**
 * Is the value at p (FLAG_VALUE in redact.ts) a reference, not a secret? In "…" one that starts
 * with `$` (the shell expands it) or REFERENCE; in '…' REFERENCE only (`'$3cret'` is literal);
 * out of quotes one that starts with `-` or `$`, or REFERENCE (`%3cret` is a value, `%PW%` not).
 */
function flagValueIsReference(s: Scan, p: number): boolean {
  const c = s.c(p);
  if (c === DQ) return s.c(p + 1) === DOLLAR || isReference(s, p + 1);
  if (c === SQ) return isReference(s, p + 1);
  return c === DASH || c === DOLLAR || isReference(s, p);
}

/** `(?<=(?:^|\s)(?:--?(?:FLAG_NAMES)|BARE_FLAG_NAMES)[ \t]+)FLAG_VALUE` */
function flagValue(s: Scan, p: number): number {
  const c = s.c(p);
  // Every value starts with no blank: inside a run of blanks, nothing is read back.
  if (!flagValueChar(c) && !isQuote(c)) return -1;
  if (!s.blank(s.c(p - 1)) || !secretFlagEndsAt(s, s.blanksBefore(p))) return -1;
  if (flagValueIsReference(s, p)) return -1;
  if (isQuote(c)) {
    const e = s.next(c === DQ ? 'q"' : "q'", (x) => x === c || x === CR || x === LF).find(p + 1);
    return s.c(e) === c ? e + 1 : -1;
  }
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

/**
 * The rest of a quoted `user<sep>PASSWORD` from p, in the quote q before the user part, without
 * the closing quote (QUOTED_REST in redact.ts), or -1: in "…" with backslash escapes, in '…' up
 * to the next `'`. It doesn't start with a space.
 */
function quotedRestEnd(s: Scan, p: number, q: number): number {
  const c = s.c(p);
  if (c !== c || isS(c)) return -1;
  if (q === DQ) return quoteRestEnd(s, p, q);
  const e = s.next("q'", (x) => x === SQ || x === CR || x === LF).find(p);
  return e > p && s.c(e) === SQ ? e : -1;
}

/** `(?<=(?:^|\s)(?:-u|--user)[ \t]+[^\s:"']+:)[^\s"']+`, or the user part in quotes and QUOTED_REST */
function userPassword(s: Scan, p: number): number {
  if (s.c(p - 1) !== COLON) return -1;
  let u = p - 1;
  while (u > 0 && userChar(s.c(u - 1))) u--;
  if (u === p - 1) return -1;
  const q = s.c(u - 1);
  const quoted = isQuote(q);
  const b = quoted ? u - 1 : u;
  if (!s.blank(s.c(b - 1))) return -1;
  const v = s.blanksBefore(b);
  const dashU = s.c(v - 2) === DASH && lower(s.c(v - 1)) === 117 && (v === 2 || isS(s.c(v - 3)));
  const dashUser = s.is(v - 6, '--user') && (v === 6 || isS(s.c(v - 7)));
  if (!dashU && !dashUser) return -1;
  if (quoted) return quotedRestEnd(s, p, q);
  return flagValueChar(s.c(p)) ? s.runEnd(p, flagValueChar) : -1;
}

function secretFlag(s: Scan, p: number): number {
  // Each alternative's look-behind ends in a blank, the `p` of `-p`, or a colon.
  const prev = s.c(p - 1);
  if (!s.blank(prev) && lower(prev) !== 112 && prev !== COLON) return -1;
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

// --- the widened patterns (redact.ts, after the ones above) --------------------------------------

/** Every JavaScript space but the line ends, `[^\S\r\n…]`: what the widened patterns read where the ones above read `[ \t]`. */
export const isWideBlank = (c: number): boolean => isS(c) && c !== LF && c !== CR && c !== 0x2028 && c !== 0x2029;

const authHeader = (s: Scan, p: number): number => header(s, p, 'authorization', true);
const cookieHeader = (s: Scan, p: number): number => header(s, p, 'cookie', false);
const secretKeyValue = (s: Scan, p: number): number => keyValue(s, p, secretKeyEndsAt);
/** pass-key-value: the whole value in quotes, else a word. */
function passKeyValue(s: Scan, p: number): number {
  const e = quotedValueAfterKey(s, p, passKeyEndsAt);
  return e >= 0 ? e : keyValue(s, p, passKeyEndsAt);
}

/** `(?<=\b(?:Proxy-|Set-)?NAME(?:\\?["'])?WS*[:=]WS*)` then QUOTED_VALUE: a header's value in quotes, after the quote before p. */
function quotedHeader(s: Scan, p: number, name: string): number {
  const o = quoteOpen(s, p);
  if (o < 0) return -1;
  const k = keyEnd(s, o);
  if (k < 0 || !s.is(k - name.length, name) || isWord(s.c(k - name.length - 1))) return -1;
  return quotedValueEnd(s, p);
}

// The patterns that read `[ \t]` around a separator or after a flag, in DEFAULT_PATTERNS order:
// authorization-header, cookie-header, bearer-token, secret-key-value-quoted, secret-key-value,
// pass-key-value, secret-flag-value, keycloak-client-secret.

// The ones that can match, by what comes before the value (the others can't: each needs one of these).
const AFTER_QUOTE = [quotedKeyValue, secretKeyValue, passKeyValue, keycloakSecret];
const AFTER_BLANK = [authHeader, cookieHeader, bearer, secretKeyValue, passKeyValue, secretFlag, keycloakSecret];
const AFTER_SEPARATOR = [authHeader, cookieHeader, secretKeyValue, passKeyValue, secretFlag, keycloakSecret];
const AFTER_P = [secretFlag];
const UUID_ONLY = [keycloakSecret];

/** Their alternatives (SEPARATED, in that order), the first that matches at p, read with Unicode spaces too. */
function separatedWide(s: Scan, p: number): number {
  const prev = s.c(p - 1);
  const c = s.c(p);
  let ms: ReadonlyArray<(s: Scan, p: number) => number>;
  if (isQuote(prev)) ms = AFTER_QUOTE;
  // Only a quoted value may start with a space.
  else if (c !== c || isS(c)) return -1;
  else if (s.blank(prev)) ms = AFTER_BLANK;
  else if (prev === COLON || prev === EQ) ms = AFTER_SEPARATOR;
  else if (lower(prev) === 112) ms = AFTER_P;
  else if (!isWord(prev) && isHex(c)) ms = UUID_ONLY;
  else return -1;
  for (const m of ms) {
    const e = m(s, p);
    if (e >= 0) return e;
  }
  return -1;
}

/**
 * Tools that take a password after a flag, where that flag means the password (only those), and
 * how. `space`: the value follows blanks; `glued`: it follows the flag at once (getopt-style
 * tools). `split`: the value is `user<split>PASSWORD`, `prefix`: `<prefix>PASSWORD`, either one
 * also in quotes (`-U "user%PASSWORD"`). Left out on purpose: `-p NAME` of the MySQL tools (it asks
 * for the password, NAME is the database), `psql`, `pg_dump` and `ssh` (`-p` is the port), `psql -W`
 * (asks), `curl -u` (secret-flag-value), `docker`/`oc`/`podman login -p` (secret-flag-value).
 * `anyCase`: the tools and flags in any case (Windows). A tool counts where its name is a word of
 * its own and no option's value, and its flag only later in the same command segment (toolsBefore).
 */
export interface PasswordToolRule {
  tools: readonly string[];
  flags: readonly string[];
  space?: boolean;
  glued?: boolean;
  split?: string;
  prefix?: string;
  anyCase?: boolean;
}

export const PASSWORD_TOOLS: readonly PasswordToolRule[] = [
  // sshpass -p PASSWORD (getopt: -pPASSWORD too)
  { tools: ['sshpass'], flags: ['-p'], space: true, glued: true },
  // MySQL/MariaDB tools: only -pPASSWORD (with a blank, -p asks and the next word is the database);
  // mysql too, for -p'…' and -p"…" (secret-flag-value reads mysql's -pPASSWORD only out of quotes)
  {
    tools: ['mysql', 'mysqldump', 'mysqladmin', 'mysqlimport', 'mysqlshow', 'mysqlcheck', 'mysqlpump', 'mysqlslap', 'mariadb', 'mariadb-dump', 'mariadb-admin'],
    flags: ['-p'],
    glued: true,
  },
  // redis-cli -a PASSWORD
  { tools: ['redis-cli'], flags: ['-a'], space: true },
  // OpenLDAP clients: -w PASSWORD is the bind password (-W asks)
  {
    tools: ['ldapsearch', 'ldapadd', 'ldapmodify', 'ldapdelete', 'ldapmodrdn', 'ldapcompare', 'ldapwhoami', 'ldappasswd', 'ldapexop'],
    flags: ['-w'],
    space: true,
    glued: true,
  },
  // zip/unzip -P PASSWORD; 7-Zip -pPASSWORD
  { tools: ['zip', 'unzip'], flags: ['-P'], space: true },
  { tools: ['7z', '7za', '7zr', '7zz'], flags: ['-p'], glued: true },
  // ipmitool -P PASSWORD
  { tools: ['ipmitool'], flags: ['-P'], space: true, glued: true },
  // SQL Server: sqlcmd/bcp/osql -P PASSWORD (-U is the user)
  { tools: ['sqlcmd', 'bcp', 'osql'], flags: ['-P'], space: true },
  // Sysinternals PsExec -p PASSWORD
  { tools: ['psexec', 'psexec64'], flags: ['-p'], space: true, anyCase: true },
  // Mosquitto clients -P PASSWORD (-p is the port)
  { tools: ['mosquitto_pub', 'mosquitto_sub', 'mosquitto_rr'], flags: ['-P'], space: true },
  // MongoDB shells and tools: -p PASSWORD
  {
    tools: ['mongo', 'mongosh', 'mongodump', 'mongorestore', 'mongoexport', 'mongoimport', 'mongostat', 'mongotop', 'mongofiles'],
    flags: ['-p'],
    space: true,
  },
  // Java keystores
  {
    tools: ['keytool', 'jarsigner'],
    flags: ['-storepass', '-keypass', '-srcstorepass', '-deststorepass', '-srckeypass', '-destkeypass', '-new'],
    space: true,
  },
  // Net-SNMP v3: -A auth and -X privacy pass phrases
  {
    tools: ['snmpwalk', 'snmpbulkwalk', 'snmpget', 'snmpgetnext', 'snmpbulkget', 'snmpset', 'snmptable', 'snmptrap'],
    flags: ['-A', '-X'],
    space: true,
    glued: true,
  },
  // Samba: -U user%PASSWORD
  { tools: ['smbclient', 'rpcclient'], flags: ['-U'], space: true, glued: true, split: '%' },
  // lftp -u user,PASSWORD
  { tools: ['lftp'], flags: ['-u'], space: true, split: ',' },
  // curl's proxy credentials: -U/--proxy-user user:PASSWORD
  { tools: ['curl'], flags: ['-U', '--proxy-user'], space: true, split: ':' },
  // OpenSSL: -passin/-passout/-pass pass:PASSWORD, and enc -k PASSWORD
  { tools: ['openssl'], flags: ['-passin', '-passout', '-pass'], space: true, prefix: 'pass:' },
  { tools: ['openssl'], flags: ['-k'], space: true },
  // Windows: cmdkey /pass:PASSWORD, schtasks /RP PASSWORD (any case); FreeRDP /p:PASSWORD
  { tools: ['cmdkey'], flags: ['/pass:'], glued: true, anyCase: true },
  { tools: ['schtasks'], flags: ['/rp'], space: true, anyCase: true },
  { tools: ['xfreerdp', 'wlfreerdp', 'sdl-freerdp'], flags: ['/p:'], glued: true },
  // NetworkManager: nmcli … password PASSWORD, wifi-sec.psk PASSWORD
  { tools: ['nmcli'], flags: ['password', 'wifi-sec.psk'], space: true },
];

const TOOL_NAMES = [...new Set(PASSWORD_TOOLS.flatMap((r) => r.tools))];
const TOOLS_RE = new RegExp([...TOOL_NAMES, 'htpasswd'].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

/** `[^\S\r\n]`: a blank within a line (BL in redact.ts). */
const isLineBlank = (c: number): boolean => isS(c) && c !== CR && c !== LF;
/** `[\s"'(`{]`: what a tool's name may follow out of quotes, if it doesn't start its segment (TOOL_LEFT in redact.ts). */
const toolLeft = (c: number): boolean => isS(c) || isQuote(c) || c === LPAREN || c === BACKTICK || c === LBRACE;
/** `[\s"']`: what may follow a tool's name. */
const toolRight = (c: number): boolean => isS(c) || isQuote(c);
/** `[^\s"'|;&(`{]`: a path's character out of quotes (PATH_CHAR). */
const pathChar = (c: number): boolean => c === c && !toolLeft(c) && c !== PIPE && c !== SEMI && c !== AMP;
/** `[\r\n|;&]`: what a segment starts after (out of quotes). */
const segmentBreak = (c: number): boolean => c === CR || c === LF || c === PIPE || c === SEMI || c === AMP;

/** Commands that run the next word as a command: an option after one doesn't take the next word as its value. */
export const WRAPPERS = ['sudo', 'doas', 'env', 'time', 'xargs', 'nice', 'nohup', 'stdbuf', 'timeout'];

/** Does `(?<![\w.-])(?:WRAPPERS)` end at x? */
function wrapperEndsAt(s: Scan, x: number): boolean {
  for (const w of WRAPPERS) if (s.has(x - w.length, w) && !keyChar(s.c(x - w.length - 1))) return true;
  return false;
}

/** `[A-Za-z_][\w.-]*=[^\s"'|;&]*` (ASSIGN in redact.ts), a character at a time: 0 the name, 1 the value, 2 no. */
function assignStep(state: number, c: number): number {
  if (state === 0) return keyChar(c) ? 0 : c === EQ ? 1 : 2;
  if (state === 1) return isQuote(c) || c === PIPE || c === SEMI || c === AMP ? 2 : 1;
  return 2;
}
/** In toolsBefore's masks: this line break continues the segment (a `\` before it, out of quotes). */
const CONTINUED = 1 << 30;

/** The tool names by their first character in lower case (all ASCII), with the rules (bits) each is in. */
const TOOLS_BY_FIRST: Array<Array<{ name: string; anyCase: boolean; bits: number }> | undefined> = new Array(128);
PASSWORD_TOOLS.forEach((r, bit) => {
  for (const name of r.tools) {
    const key = lower(name.charCodeAt(0));
    const list = (TOOLS_BY_FIRST[key] ??= []);
    const t = list.find((x) => x.name === name && x.anyCase === (r.anyCase === true));
    if (t) t.bits |= 1 << bit;
    else list.push({ name, anyCase: r.anyCase === true, bits: 1 << bit });
  }
});

/**
 * NOT_OPTION_VALUE (redact.ts) reads `(?:-\w|--\w[\w-]*)` as a whole word; this is it, a character
 * at a time: 0 nothing read, 1 `-`, 2 `-\w` (an option), 3 `--`, 4 `--\w[\w-]*` (an option), 5 no option.
 */
function optionStep(state: number, c: number): number {
  switch (state) {
    case 0:
      return c === DASH ? 1 : 5;
    case 1:
      return c === DASH ? 3 : isWord(c) ? 2 : 5;
    case 3:
      return isWord(c) ? 4 : 5;
    case 4:
      return isWord(c) || c === DASH ? 4 : 5;
    default:
      return 5;
  }
}

/** Is `flag` of `rule` at i (in any case for `anyCase`)? */
const flagAt = (s: Scan, i: number, flag: string, rule: PasswordToolRule): boolean => (rule.anyCase ? s.is(i, flag) : s.has(i, flag));

/** toolsBefore's character classes: a space, PATH_CHAR, TOOL_LEFT, `[\w.-]`, a segment break, `[A-Za-z_]`. */
const C_SPACE = 1;
const C_PATH = 2;
const C_LEFT = 4;
const C_KEY = 8;
const C_BREAK = 16;
const C_START = 32;
const ASCII_CLASS = new Uint8Array(128).map((_, c) =>
  (isS(c) ? C_SPACE : 0) | (pathChar(c) ? C_PATH : 0) | (toolLeft(c) ? C_LEFT : 0) | (keyChar(c) ? C_KEY : 0) | (segmentBreak(c) ? C_BREAK : 0) | (isAlpha(c) || c === US ? C_START : 0),
);
/** The classes of c (none for NaN, before or after the text). */
const charClass = (c: number): number => (c < 128 ? ASCII_CLASS[c]! : c !== c ? 0 : isS(c) ? C_SPACE | C_LEFT : C_PATH);
/** The last characters of the wrappers: a word that ends in another one is none. */
const WRAPPER_LAST = new Set(WRAPPERS.map((w) => w.charCodeAt(w.length - 1)));

/**
 * For each place i, the rules with a tool counted before it in its command segment (see redact.ts,
 * before toolRule), in one pass over the text: the segment (`|`, `;`, `&` out of quotes and line
 * breaks end it), the quotes, the words before (an option, a wrapper such as `sudo`, `NAME=value`
 * or none of these) and the path a name is in. A line break after `\` out of quotes continues the
 * segment, and is marked CONTINUED (a flag may follow it).
 */
function toolsBefore(s: Scan): Int32Array {
  let masks = s.toolMasks;
  if (masks) return masks;
  masks = new Int32Array(s.n + 1);
  let present = 0;
  /** The rules with a tool counted in this segment. */
  let active = 0;
  /** The quote the scan is in (DQ or SQ), or 0. */
  let quote = 0;
  /** The next character is escaped in "…" (`\"`, `\\`). */
  let escaped = false;
  let continuedCR = false;
  /**
   * optionStep's and assignStep's states for the run of non-spaces being read; whether the blanks
   * being read follow an option (not right after a wrapper), and whether the last run was a wrapper
   * or `NAME=value`.
   */
  let option = 0;
  let assign = 2;
  let inWord = false;
  let afterOption = false;
  let lastWrapper = false;
  let lastAssign = false;
  /** Only line blanks since the text's start, a line break, `|`, `;` or `&`. */
  let afterBreak = true;
  let segment = 0;
  /**
   * The word being read (from the segment's start or a space): where it starts, whether it is no
   * option's value there, and the end of its `[A-Za-z_][\w.-]*` start (-1: none). Whether the path
   * being read (a run of PATH_CHAR) is in command position.
   */
  let wordStart = -1;
  let wordNov = false;
  let keyEnd = -1;
  let pathCommand = false;
  /** The character at x and the one before (NaN before the text), and their classes. */
  let c = NaN;
  let k = 0;
  let prev = NaN;
  let prevK = 0;
  for (let x = 0; x < s.n; prev = c, prevK = k, x++) {
    c = s.c(x);
    k = charClass(c);
    const space = (k & C_SPACE) !== 0;
    /** No option and blanks right before x. */
    const nov = !(afterOption && (prevK & C_SPACE) !== 0);
    // A path starts at x: in command position at the segment's start (after blanks), after a quote,
    // `(`, a backtick or `{`, or after a wrapper or `NAME=value`.
    if ((k & C_PATH) !== 0 && (prevK & C_PATH) === 0) {
      pathCommand =
        prevK === 0 || (prevK & C_BREAK) !== 0 || ((prevK & C_LEFT) !== 0 && ((prevK & C_SPACE) === 0 || afterBreak || lastWrapper || lastAssign));
    }
    const tools = c < 128 ? TOOLS_BY_FIRST[lower(c)] : undefined;
    if (tools) {
      // Where a tool's name counts (see redact.ts, before toolRule). In quotes: after
      // TOOL_LEFT_QUOTED, no option's value. Out of quotes: at the segment's start or after
      // TOOL_LEFT, no option's value; after a prefix (`@`, `-`, `@-`, `-@`, `NAME=`, `NAME:`) that
      // starts a word that is no option's value; after a path in command position.
      let counts: boolean;
      if (quote !== 0) counts = nov && ((prevK & C_LEFT) !== 0 || prev === SLASH || prev === BACKSLASH);
      else if (x === segment || (prevK & C_LEFT) !== 0) counts = nov;
      else if (prev === SLASH || prev === BACKSLASH) counts = pathCommand;
      else if (prev === AT || prev === DASH) counts = wordNov && (wordStart === x - 1 || (wordStart === x - 2 && s.c(x - 2) === (prev === AT ? DASH : AT)));
      else counts = (prev === EQ || prev === COLON) && wordNov && keyEnd === x - 1;
      if (counts) {
        for (const t of tools) {
          if (!(t.anyCase ? s.is(x, t.name) : s.has(x, t.name))) continue;
          const end = x + t.name.length;
          if (toolRight(s.c(end)) || (s.is(end, '.exe') && toolRight(s.c(end + 4)))) active |= t.bits;
        }
        present |= active;
      }
    }
    masks[x] = active;
    if (space) {
      if (inWord) {
        afterOption = (option === 2 || option === 4) && !lastWrapper;
        lastWrapper = WRAPPER_LAST.has(prev) && wrapperEndsAt(s, x);
        lastAssign = assign === 1;
      }
      inWord = false;
    } else {
      option = optionStep(inWord ? option : 0, c);
      assign = inWord ? assignStep(assign, c) : (k & C_START) !== 0 ? 0 : 2;
      inWord = true;
      if (x === segment || (prevK & C_SPACE) !== 0) {
        wordStart = x;
        wordNov = nov;
        keyEnd = (k & C_START) !== 0 ? x + 1 : -1;
      } else if (keyEnd === x && (k & C_KEY) !== 0) keyEnd = x + 1;
    }
    if (!space || (k & C_BREAK) !== 0) afterBreak = (k & C_BREAK) !== 0;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === CR || c === LF) {
      const continued: boolean = quote === 0 && (prev === BACKSLASH || (c === LF && prev === CR && continuedCR));
      continuedCR = continued && c === CR;
      if (continued) masks[x] = active | CONTINUED;
      else {
        active = 0;
        segment = x + 1;
        quote = 0;
      }
    } else if (quote === DQ) {
      if (c === BACKSLASH) {
        const d = s.c(x + 1);
        escaped = d === DQ || d === BACKSLASH;
      } else if (c === DQ) quote = 0;
    } else if (quote === SQ) {
      if (c === SQ) quote = 0;
    } else if (c === DQ || c === SQ) quote = c;
    else if (c === PIPE || c === SEMI || c === AMP) {
      active = 0;
      segment = x + 1;
    }
  }
  masks[s.n] = active;
  s.toolMasks = masks;
  s.toolsPresent = present;
  return masks;
}

/** Does one of `rule`'s flags end at f, after a line blank (or a continued line break) in a segment where one of its tools counts? */
function toolFlagEndsAt(s: Scan, f: number, rule: PasswordToolRule, bit: number): boolean {
  for (const flag of rule.flags) {
    const at = f - flag.length;
    if (at <= 0 || !flagAt(s, at, flag, rule)) continue;
    const m = toolsBefore(s)[at - 1]!;
    if ((m & (1 << bit)) !== 0 && (isLineBlank(s.c(at - 1)) || (m & CONTINUED) !== 0)) return true;
  }
  return false;
}

/** Does the flag of `rule` end at f, with the value (or the user part of it) from v on: after blanks, or glued? */
function toolFlagBefore(s: Scan, v: number, rule: PasswordToolRule, bit: number): boolean {
  if (s.blank(s.c(v - 1))) return rule.space === true && toolFlagEndsAt(s, s.blanksBefore(v), rule, bit);
  return rule.glued === true && toolFlagEndsAt(s, v, rule, bit);
}

/** What can come right before a value: a glued flag's last character, a split or a prefix's last one (else a blank). */
const BEFORE_VALUE = new Set(
  PASSWORD_TOOLS.flatMap((r) => [...(r.glued ? r.flags.flatMap((f) => [f.charCodeAt(f.length - 1), f.toUpperCase().charCodeAt(f.length - 1)]) : []), ...(r.split ? [r.split.charCodeAt(0)] : []), ...(r.prefix ? [r.prefix.charCodeAt(r.prefix.length - 1)] : [])]),
);

/** A password given to a tool (PASSWORD_TOOLS): the first rule that matches at p. */
function passwordTool(s: Scan, p: number): number {
  const c = s.c(p);
  if (!flagValueChar(c) && !isQuote(c)) return -1;
  const before = s.c(p - 1);
  if (!s.blank(before) && !BEFORE_VALUE.has(before)) return -1;
  /** The value as secret-flag-value reads it (FLAG_VALUE): no reference. Read once, when a rule needs it. */
  let valueOk: boolean | undefined;
  /** Where the flag ends for a value at p: before the blanks, else at p (glued). */
  const flagEnd = s.blank(before) ? s.blanksBefore(p) : p;
  toolsBefore(s);
  // The rules with a tool in the text, in order (lowest bit first).
  for (let m = s.toolsPresent; m !== 0; m &= m - 1) {
    const bit = 31 - Math.clz32(m & -m);
    const rule = PASSWORD_TOOLS[bit]!;
    if (rule.split !== undefined) {
      // `user<split>PASSWORD`: the user part, then the separator right before p.
      if (s.c(p - 1) !== rule.split.charCodeAt(0)) continue;
      let u = p - 1;
      while (u > 0 && flagValueChar(s.c(u - 1)) && s.c(u - 1) !== s.c(p - 1)) u--;
      if (u === p - 1) continue;
      const q = s.c(u - 1);
      if (isQuote(q)) {
        // In quotes: the flag before the quote, after blanks or glued; the value up to the closing quote.
        if (!toolFlagBefore(s, u - 1, rule, bit)) continue;
        const e = quotedRestEnd(s, p, q);
        if (e >= 0) return e;
        continue;
      }
      if (!flagValueChar(c)) continue;
      // After blanks, the user part is the whole run; glued, the run starts with the flag (a flag
      // follows a `\s`, so it can only start the run) and the user part is the rest.
      const spaced = rule.space === true && s.blank(q) && toolFlagEndsAt(s, s.blanksBefore(u), rule, bit);
      const glued = rule.glued === true && rule.flags.some((f) => u + f.length < p - 1 && flagAt(s, u, f, rule) && toolFlagEndsAt(s, u + f.length, rule, bit));
      if (spaced || glued) return s.runEnd(p, flagValueChar);
      continue;
    }
    if (rule.prefix !== undefined) {
      const at = p - rule.prefix.length;
      if (!s.has(at, rule.prefix)) continue;
      if (flagValueChar(c) && toolFlagBefore(s, at, rule, bit)) return s.runEnd(p, flagValueChar);
      const q = s.c(at - 1);
      if (isQuote(q) && toolFlagBefore(s, at - 1, rule, bit)) {
        const e = quotedRestEnd(s, p, q);
        if (e >= 0) return e;
      }
      continue;
    }
    valueOk ??= !flagValueIsReference(s, p);
    if (!valueOk || !(flagEnd < p ? rule.space === true : rule.glued === true) || !toolFlagEndsAt(s, flagEnd, rule, bit)) continue;
    if (isQuote(c)) {
      const e = s.next(c === DQ ? 'q"' : "q'", (x) => x === c || x === CR || x === LF).find(p + 1);
      if (s.c(e) === c) return e + 1;
      continue;
    }
    return s.runEnd(p, flagValueChar);
  }
  return htpasswdBatch(s, p);
}

/**
 * `htpasswd -b FILE USER PASSWORD` and `htpasswd -nb USER PASSWORD` (the options in one word with
 * `b`, and `n` or not): read back over the words before p to the options and `htpasswd`. Options in
 * several words (`-c -b`) are not read.
 */
function htpasswdBatch(s: Scan, p: number): number {
  const c = s.c(p);
  if (!flagValueChar(c) || c === DASH || c === DOLLAR || !s.blank(s.c(p - 1))) return -1;
  // htpasswd on the line before p (the words and blanks between hold no line break).
  if (s.wordEndOnLine('htpasswd', p) < 0) return -1;
  let end = s.blanksBefore(p);
  for (let n = 0; n < 3; n++) {
    let start = end;
    while (start > 0 && flagValueChar(s.c(start - 1))) start--;
    if (start === end || !s.blank(s.c(start - 1))) return -1;
    // `-[A-Za-z]+` with `b`: the password is the third word after it, or the second with `n`.
    let b = false;
    let nOption = false;
    let letters = s.c(start) === DASH && end - start >= 2;
    for (let i = start + 1; letters && i < end; i++) {
      const x = s.c(i);
      letters = isAlpha(x);
      if (x === 98) b = true;
      if (x === 110) nOption = true;
    }
    if (letters && b && n === (nOption ? 1 : 2)) {
      const h = s.blanksBefore(start);
      if (s.has(h - 8, 'htpasswd') && !isWord(s.c(h - 9))) return isReference(s, p) ? -1 : s.runEnd(p, flagValueChar);
    }
    end = s.blanksBefore(start);
  }
  return -1;
}

/** The first words of two-word key names whose second word (`key`) no SECRET_KEYS name holds: `api key`, `secret key`… */
export const SPACED_KEY_WORDS = ['api', 'access', 'secret', 'private', 'client', 'app', 'master', 'account', 'encryption', 'signing'];

/** Does `\b(?:WORDS)WS+key` or `\bpassWS*phrase` end at k? */
function spacedKeyEndsAt(s: Scan, k: number): boolean {
  if (s.is(k - 3, 'key')) {
    const j = s.blanksBefore(k - 3);
    if (j === k - 3) return false;
    for (const w of SPACED_KEY_WORDS) if (s.is(j - w.length, w) && !isWord(s.c(j - w.length - 1))) return true;
    return false;
  }
  if (!s.is(k - 6, 'phrase')) return false;
  const j = s.blanksBefore(k - 6);
  return s.is(j - 4, 'pass') && !isWord(s.c(j - 5));
}

/** A spaced key name's value: in quotes (all of it), else a word as secret-key-value reads it. */
function spacedKeyValue(s: Scan, p: number): number {
  const o = quoteOpen(s, p);
  if (o >= 0) {
    const k = keyEnd(s, o);
    if (k >= 0 && spacedKeyEndsAt(s, k) && notAValue(s, p)) {
      const e = quotedValueEnd(s, p);
      if (e >= 0) return e;
    }
  }
  return keyValue(s, p, spacedKeyEndsAt);
}

/** The built-in patterns (by name) that have a linear matcher. redact.ts uses one only for that exact pattern. */
export const LINEAR_FINDERS: ReadonlyMap<string, SpanFinder> = new Map([
  ['authorization-header', finder(authHeader, /authorization/i)],
  ['cookie-header', finder(cookieHeader, /cookie/i)],
  ['bearer-token', finder(bearer, /bearer/i)],
  ['jwt', finder(jwt, /eyJ/)],
  ['secret-key-value-quoted', finder(quotedKeyValue, /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|credential|\.key|rediscli_auth/i)],
  ['secret-key-value', finder(secretKeyValue, /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|credential|\.key|rediscli_auth/i)],
  ['pass-key-value', finder(passKeyValue, /pass/i)],
  ['secret-flag-value', finder(secretFlag, /-|requirepass|masterauth/i)],
  ['keycloak-client-secret', finder(keycloakSecret, /secret/i)],
  // The widened ones (they read Unicode spaces as blanks).
  ['authorization-header-quoted', finder((s, p) => quotedHeader(s, p, 'authorization'), /authorization/i, isWideBlank)],
  ['cookie-header-quoted', finder((s, p) => quotedHeader(s, p, 'cookie'), /cookie/i, isWideBlank)],
  ['secret-after-unicode-space', finder(separatedWide, undefined, isWideBlank)],
  ['password-flag-tool', finder(passwordTool, TOOLS_RE, isWideBlank)],
  ['secret-key-value-spaced', finder(spacedKeyValue, /key|phrase/i, isWideBlank)],
]);

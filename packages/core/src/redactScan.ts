/**
 * Linear-time matchers for the built-in redaction patterns whose regular expressions backtracked
 * quadratically: a look-behind over a run of blanks (20,000 blanks took 6 s to redact, 200,000
 * about ten minutes), a look-behind back to the start of the line (`login … -p`), or a retry from
 * each start inside one run (`eyJ-eyJ-…`, `password="${…`); and keycloak-client-secret, linear
 * but the slowest (a 40-character look-behind at every position). Each matcher finds exactly what
 * its regular expression in redact.ts finds with the g flag (same starts, same ends): the regular
 * expressions stay the definition, and test/redactScan.test.ts compares the two on a large random
 * corpus. A pattern found in parts (redact.ts SPLIT_PATTERNS) has a matcher for each part
 * (LINEAR_PARTS), each the same as that part's regular expression.
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
const BANG = 33;
const DQ = 34;
const HASH = 35;
const DOLLAR = 36;
const PCT = 37;
const AMP = 38;
const SQ = 39;
const LPAREN = 40;
const RPAREN = 41;
const STAR = 42;
const PLUS = 43;
const COMMA = 44;
const DASH = 45;
const DOT = 46;
const SLASH = 47;
const COLON = 58;
const SEMI = 59;
const LT = 60;
const EQ = 61;
const GT = 62;
const QUESTION = 63;
const AT = 64;
const BACKSLASH = 92;
const LBRACKET = 91;
const RBRACKET = 93;
const CARET = 94;
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
  /** password-flag-tool: where a rule with `ownOptions` may have its flag (ownOptionStarts). */
  ownStarts: Int32Array | undefined;
  /** password-flag-tool: where htpasswd's password starts (htpasswdStarts). */
  htpasswd: Uint8Array | undefined;
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

/**
 * The union of `spans` (any order; empty ones dropped): sorted, and those that overlap or touch
 * merged into one.
 */
export function mergeSpans(spans: Spans): Spans {
  const sorted = spans.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Spans = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
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
  'sshpass',
];
const KEY_FIRST = new Set(KEY_NAMES.map((k) => k.charCodeAt(0)));
/** `[\w.-]` */
const keyChar = (c: number): boolean => isWord(c) || c === DOT || c === DASH;

/** Is the separator after the key that ends at k (`(?:\\?["'])?[ \t]*`, then it) a `=`? */
function equalsAfterKey(s: Scan, k: number): boolean {
  let j = k;
  if (s.c(j) === BACKSLASH && isQuote(s.c(j + 1))) j += 2;
  else if (isQuote(s.c(j))) j++;
  return s.c(s.runEnd(j, s.blank)) === EQ;
}

/**
 * Does `\b[\w.-]*(?:SECRET_KEYS)[\w.-]*` end at k? The run of `[\w.-]` that ends at k must hold a
 * key name, with a word boundary at or before the last one's start (`sshpass` only before `=`).
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
        if (name === 'sshpass' && !equalsAfterKey(s, k)) continue;
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
      const e = s.next('ref{', (x) => x === RBRACE || isS(x) || isQuote(x)).find(p + 2);
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

/**
 * `(?<=KEY(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?)NOT_A_VALUE(?!\$'…')(?:[^\s"',;&}\\]|\\(?!["']))+`
 * and what is glued to it (bareAfter in redact.ts).
 */
function keyValue(s: Scan, p: number, keyEndsAt: (s: Scan, k: number) => boolean): number {
  const c = s.c(p);
  if (c === BACKSLASH ? isQuote(s.c(p + 1)) : !keyValueChar(c)) return -1;
  // A quote right before p is the optional one: without it, `[:=]` would have to be that quote.
  const o = quoteOpen(s, p);
  const k = keyEnd(s, o >= 0 ? o : p);
  if (k < 0 || !keyEndsAt(s, k) || !notAValue(s, p)) return -1;
  // A value in $'…' is read in its quotes (quotedValueEnd).
  if (c === DOLLAR && s.c(p + 1) === SQ && ansiEnd(s, p + 2) > p + 2) return -1;
  return bareGlueEnd(s, keyValueEnd(s, p), keyOpener(keyEndsAt));
}

/** GLUE_START (redact.ts): `[\w$@!%~^*=?/-]` */
const glueStart = (c: number): boolean =>
  isWord(c) || c === DOLLAR || c === AT || c === BANG || c === PCT || c === TILDE || c === CARET || c === STAR || c === EQ || c === QUESTION || c === SLASH || c === DASH;
/** GLUE_CHAR (redact.ts): `[^\s"'\\|&;()<>,}\]`]` */
const glueChar = (c: number): boolean =>
  c === c &&
  !isS(c) &&
  !isQuote(c) &&
  c !== BACKSLASH &&
  c !== PIPE &&
  c !== AMP &&
  c !== SEMI &&
  c !== LPAREN &&
  c !== RPAREN &&
  c !== LT &&
  c !== GT &&
  c !== COMMA &&
  c !== RBRACE &&
  c !== RBRACKET &&
  c !== BACKTICK;

/**
 * Does the reading's next value open at the quote at o (at its backslash for `\"`): does its
 * opener (a key and separator, a flag and blanks) end there? Then nothing is glued over that quote
 * (notAfter in redact.ts), so the same reading still finds that value from its start.
 */
export type OpensAt = (s: Scan, o: number) => boolean;

/** A glued segment from its opening quote at e: its closing quote, or -1 (glueSegment in redact.ts). */
function segmentEnd(s: Scan, e: number): number {
  const q = s.c(e);
  let f: number;
  // Right after a quote of its kind: anything but a line end. Else GLUE_CHAR only.
  if (s.c(e - 1) === q) f = s.next(q === DQ ? 'q"' : "q'", (x) => x === q || x === CR || x === LF).find(e + 1);
  else f = s.runEnd(e + 1, glueChar);
  return s.c(f) === q ? f : -1;
}

/**
 * The end of the text glued to the closing quote at i - 1 (glued in redact.ts), or i if there is
 * none: GLUE_START, a segment or `\'`, then GLUE_CHAR, segments and `\X` pairs. Nothing when a
 * value opens at that quote (`opensAt`); a segment whose closing quote opens one ends it before.
 * Read once, up to the first character that doesn't go on.
 */
function glueEnd(s: Scan, i: number, opensAt: OpensAt): number {
  const first = s.c(i);
  if (opensAt(s, i - 1) || !(glueStart(first) || isQuote(first) || (first === BACKSLASH && s.c(i + 1) === SQ))) return i;
  return glueRun(s, i, opensAt);
}

/**
 * The end of the text glued to a bare word that ends at e (bareGlued in redact.ts), or e: it starts
 * with a segment (`--password abc'def'`), not with `\'` (in `'C:\keys\'` that is no escape), and
 * not after `[ ( { : = <` (`["a", "b"]`, `os.environ["KEY"]`).
 */
function bareGlueEnd(s: Scan, e: number, opensAt: OpensAt): number {
  const b = s.c(e - 1);
  if (!isQuote(s.c(e)) || b === LBRACKET || b === LPAREN || b === LBRACE || b === COLON || b === EQ || b === LT) return e;
  return glueRun(s, e, opensAt);
}

/** glueEnd's reading from i: GLUE_CHAR, segments and `\X` pairs, up to the first character that doesn't go on. */
function glueRun(s: Scan, i: number, opensAt: OpensAt): number {
  for (let e = i; ; ) {
    const c = s.c(e);
    if (glueChar(c)) e++;
    else if (c === BACKSLASH) {
      const d = s.c(e + 1);
      if (d !== d || d === CR || d === LF) return e;
      e += 2;
    } else if (isQuote(c)) {
      const f = segmentEnd(s, e);
      if (f < 0 || opensAt(s, f)) return e;
      e = f + 1;
    } else return e;
  }
}

/** The end of a value whose closing quote is at e: after the text glued to it, if any (else e, the quote left out). */
function glued(s: Scan, e: number, opensAt: OpensAt): number {
  const g = glueEnd(s, e + 1, opensAt);
  return g > e + 1 ? g : e;
}

/**
 * The end of what is glued to an escaped value's closing `\q` (escGlued in redact.ts), from i right
 * after it, or -1 if it doesn't start with GLUE_START: then GLUE_CHAR, segments in `\q…\q` and in
 * the other quote, each up to a closing quote that no value opens (`opensAt`).
 */
function escGlueEnd(s: Scan, i: number, q: number, opensAt: OpensAt): number {
  if (!glueStart(s.c(i))) return -1;
  const other = q === DQ ? SQ : DQ;
  for (let e = i + 1; ; ) {
    const c = s.c(e);
    if (glueChar(c)) e++;
    else if (c === BACKSLASH && s.c(e + 1) === q) {
      const f = s.runEnd(e + 2, glueChar);
      if (s.c(f) !== BACKSLASH || s.c(f + 1) !== q || opensAt(s, f)) return e;
      e = f + 2;
    } else if (c === other) {
      const f = s.runEnd(e + 1, glueChar);
      if (s.c(f) !== other || opensAt(s, f)) return e;
      e = f + 1;
    } else return e;
  }
}

/**
 * The end of the quoted value that starts at p (quotedAfter in redact.ts), or -1. After `"` or
 * `'`: quoteRestEnd. After `\"` or `\'` (escaped JSON): up to `\"` or `\'`. `opensAt`: where the
 * reading's next value opens (OpensAt).
 */
export function quotedValueEnd(s: Scan, p: number, opensAt: OpensAt): number {
  const q = s.c(p - 1);
  if (!isQuote(q)) return -1;
  if (s.c(p - 2) === BACKSLASH) return escapedValueEnd(s, p, q, opensAt, false);
  if (q === SQ && s.c(p - 2) === DOLLAR) {
    // $'…' (ANSI_REST in redact.ts): one character or more.
    const e = ansiEnd(s, p);
    return e > p ? glued(s, e, opensAt) : -1;
  }
  return quoteRestEnd(s, p, q, opensAt);
}

/**
 * Where the quote a value opens with starts, for the value at p: at the backslash of `\"` or `\'`,
 * at the `$` of `$'`, else at the quote (-1 if there is none). quotedAfter's openings in redact.ts.
 */
function valueOpen(s: Scan, p: number): number {
  const q = s.c(p - 1);
  if (!isQuote(q)) return -1;
  const b = s.c(p - 2);
  return b === BACKSLASH || (q === SQ && b === DOLLAR) ? p - 2 : p - 1;
}

/**
 * In $'…' from i: the `'` that closes it, or -1 (ANSI_CHAR in redact.ts: a backslash escapes the
 * next character, `\'` and `\\` too). The next unescaped `'` ends each reading, so the text is
 * read about once.
 */
function ansiEnd(s: Scan, i: number): number {
  for (let e = i; ; ) {
    const c = s.c(e);
    if (c === SQ) return e;
    if (c !== c || c === CR || c === LF) return -1;
    if (c === BACKSLASH) {
      const d = s.c(e + 1);
      if (d !== d || d === CR || d === LF) return -1;
      e += 2;
    } else e++;
  }
}

/** CLOSES (redact.ts) at i: `;`, `&`, `|`, a space or the text's end, after a `\"` that closes its quote. */
export function closesAt(s: Scan, i: number): boolean {
  const c = s.c(i);
  return c !== c || c === SEMI || c === AMP || c === PIPE || isS(c);
}

/**
 * From p in a quote q opened before it, the closing quote (DQ_REST and SQ_REST in redact.ts), or
 * -1 if there is no value. In '…' the next `'` (no escapes, as in sh and PowerShell). In "…" read
 * with backslash escapes, but a `\"` before CLOSES closes it (`"C:\secrets\"; …`); else (a
 * backslash before the line's end) up to the next `"`. Text glued to the closing quote is in the
 * value too (glued: the end is after it). An empty value counts only with glued text (emptyGlued).
 */
function quoteRestEnd(s: Scan, p: number, q: number, opensAt: OpensAt): number {
  if (s.c(p) === q) return emptyGlued(s, p, opensAt);
  if (q === DQ) {
    let e = p;
    for (;;) {
      const c = s.c(e);
      if (c !== c || c === CR || c === LF || c === DQ) break;
      if (c !== BACKSLASH) {
        e++;
        continue;
      }
      const d = s.c(e + 1);
      if (d !== d || d === CR || d === LF) break;
      if (d === DQ && closesAt(s, e + 2)) {
        e++;
        break;
      }
      e += 2;
    }
    if (e > p && s.c(e) === DQ) return glued(s, e, opensAt);
  }
  const f = s.next(q === DQ ? 'q"' : "q'", (c) => c === q || c === CR || c === LF).find(p);
  return f > p && s.c(f) === q ? glued(s, f, opensAt) : -1;
}

/**
 * An empty value whose closing quote is at e: the end of the text glued to it, or -1 if there is
 * none (`''abc`; emptyGlued in redact.ts). That text starts with GLUE_START but not `-` (the next
 * option), `$` or a reference (`""${PW}`).
 */
function emptyGlued(s: Scan, e: number, opensAt: OpensAt): number {
  const c = s.c(e + 1);
  if (!glueStart(c) || c === DASH || c === DOLLAR || isReference(s, e + 1)) return -1;
  const g = glueEnd(s, e + 1, opensAt);
  return g > e + 1 ? g : -1;
}

/**
 * The end of a value after `\"` or `\'` (escaped JSON, ESCAPED_VALUE in redact.ts): up to the `\"`
 * that closes it, or -1. A run of k backslashes before the quote: k = 1, 5, 9… is a closing `\"`
 * (after (k-1)/2 escaped backslashes, an even number), k = 3, 7… an escaped quote in the value
 * (`s3c\\\"ret`), an even k a bare quote (the string around ends: no value). The closing `\"` must
 * be followed by ESC_CLOSES (escClosesAt), or by glued text (escGlueEnd: the end is after it), else
 * there is no value. `withClose`: before ESC_CLOSES the end is after the closing `\"` (a flag's
 * value, FLAG_VALUE in redact.ts), else before it. `gluedOnly`: a value only with glued text.
 */
function escapedValueEnd(s: Scan, p: number, q: number, opensAt: OpensAt, withClose: boolean, gluedOnly = false): number {
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
    else if ((r - e) % 4 === 1) {
      if (r - 1 <= p) return -1;
      if (escClosesAt(s, r + 1)) return gluedOnly ? -1 : withClose ? r + 1 : r - 1;
      // Text after the `\"`. If the next value opens there, no value: one with this text would
      // hide that value's start, and one without it ends before a word, which is no escaped JSON
      // (ESC_CLOSES): as before glued text was read.
      if (opensAt(s, r - 1)) return -1;
      return escGlueEnd(s, r + 1, q, opensAt);
    } else return -1;
  }
}

/** ESC_CLOSES (redact.ts) at i: `, : } ] ) ; & |`, a space, a quote, a backslash or the text's end. */
function escClosesAt(s: Scan, i: number): boolean {
  const c = s.c(i);
  return c !== c || isS(c) || isQuote(c) || c === BACKSLASH || c === COMMA || c === COLON || c === RBRACE || c === RBRACKET || c === RPAREN || c === SEMI || c === AMP || c === PIPE;
}

/** `(?<=KEY(?:\\?["'])?[ \t]*[:=][ \t]*)NOT_A_VALUE` then QUOTED_VALUE (redact.ts), for the quote before p. */
function quotedValueAfterKey(s: Scan, p: number, keyEndsAt: (s: Scan, k: number) => boolean): number {
  const o = valueOpen(s, p);
  if (o < 0) return -1;
  const k = keyEnd(s, o);
  if (k < 0 || !keyEndsAt(s, k) || !notAValue(s, p)) return -1;
  return quotedValueEnd(s, p, keyOpener(keyEndsAt));
}

/** OpensAt for a key's value: the key and its separator end at the quote. Made once for each kind of key. */
const KEY_OPENERS = new Map<(s: Scan, k: number) => boolean, OpensAt>();
function keyOpener(keyEndsAt: (s: Scan, k: number) => boolean): OpensAt {
  let o = KEY_OPENERS.get(keyEndsAt);
  if (!o) {
    o = (s, i) => {
      const k = keyEnd(s, i);
      return k >= 0 && keyEndsAt(s, k);
    };
    KEY_OPENERS.set(keyEndsAt, o);
  }
  return o;
}

const quotedKeyValue = (s: Scan, p: number): number => quotedValueAfterKey(s, p, secretKeyEndsAt);

/** The quotes a value opens with, in quotedAfter's order (redact.ts quotedAlternatives): `"`, `\"`, `'`, `\'`, `$'`. */
const QUOTE_OPENINGS = ['"', '\\"', "'", "\\'", "$'"];
/** `m` only where the value at p opens with `open` (one of QUOTE_OPENINGS, valueOpen): one alternative of quotedAfter. */
const opensWith =
  (open: string, m: (s: Scan, p: number) => number) =>
  (s: Scan, p: number): number =>
    s.c(p - 1) === open.charCodeAt(open.length - 1) && valueOpen(s, p) === p - open.length && s.has(p - open.length, open) ? m(s, p) : -1;
/** `m` (a quoted value after a key) as quotedAfter's four alternatives, one for each opening quote. */
const byOpening = (m: (s: Scan, p: number) => number): Array<(s: Scan, p: number) => number> => QUOTE_OPENINGS.map((o) => opensWith(o, m));

// --- secret-flag-value ---------------------------------------------------------------------------

export const FLAG_NAMES = ['password', 'passwd', 'pass', 'secret', 'client-secret', 'token', 'api-key', 'apikey', 'access-key', 'secret-key', 'requirepass', 'masterauth'];
/**
 * Redis's password settings count without dashes too, where a line starts (after blanks, `#` or `;`
 * comment marks, or a YAML `- `: `requirepass …` in redis.conf) and after `config set` (`CONFIG SET
 * requirepass …`), not elsewhere (`grep requirepass redis.conf`).
 */
export const BARE_FLAG_NAMES = ['requirepass', 'masterauth'];

/** Does `(?:(?:^|[\r\n])[ \t]*(?:[#;]+[ \t]*|-[ \t]+)?|\bconfig[ \t]+set[ \t]+)` (BARE_FLAG_START in redact.ts) end at d? */
function bareFlagStartsAt(s: Scan, d: number): boolean {
  let i = s.blanksBefore(d);
  if (i < d && s.is(i - 3, 'set')) {
    const j = s.blanksBefore(i - 3);
    if (j < i - 3 && s.is(j - 6, 'config') && !isWord(s.c(j - 7))) return true;
  }
  const c = s.c(i - 1);
  if (c === DASH) {
    if (i === d) return false;
    i = s.blanksBefore(i - 1);
  } else if (c === HASH || c === SEMI) {
    while (s.c(i - 1) === HASH || s.c(i - 1) === SEMI) i--;
    i = s.blanksBefore(i);
  }
  return i === 0 || s.c(i - 1) === CR || s.c(i - 1) === LF;
}

/** Does `(?:^|\s)--?(?:FLAG_NAMES)` or BARE_FLAG_START then BARE_FLAG_NAMES end at j? */
function secretFlagEndsAt(s: Scan, j: number): boolean {
  for (const name of FLAG_NAMES) {
    const d = j - name.length - 1;
    if (s.c(d) !== DASH || !s.is(d + 1, name)) continue;
    if (d === 0 || isS(s.c(d - 1))) return true;
    if (s.c(d - 1) === DASH && (d === 1 || isS(s.c(d - 2)))) return true;
  }
  for (const name of BARE_FLAG_NAMES) {
    const d = j - name.length;
    if (s.is(d, name) && bareFlagStartsAt(s, d)) return true;
  }
  return false;
}

/** Does SECRET_FLAG (redact.ts) end at o: a secret flag, then blanks? */
const secretFlagOpensAt: OpensAt = (s, o) => s.blank(s.c(o - 1)) && secretFlagEndsAt(s, s.blanksBefore(o));

/**
 * FLAG_VALUE (redact.ts) at p, a value opening there (`opensAt`), or -1. In "…" (not a reference:
 * starting with `$`, the shell expands it, or REFERENCE), '…' or $'…' (not REFERENCE: `'$3cret'`
 * is literal), with what is glued to its closing quote, then a value anyway; in `\"…\"` as
 * escapedValueEnd reads it, not a reference as in "…" unless glued text follows; else a word not
 * starting with `-`, `$` or REFERENCE (`%3cret` is a value, `%PW%` not), and what is glued to it.
 */
function flagValueEnd(s: Scan, p: number, opensAt: OpensAt): number {
  const c = s.c(p);
  if (isQuote(c) || (c === DOLLAR && s.c(p + 1) === SQ)) {
    const ansi = c === DOLLAR;
    const i = ansi ? p + 2 : p + 1;
    const e = ansi ? ansiEnd(s, i) : s.next(c === DQ ? 'q"' : "q'", (x) => x === c || x === CR || x === LF).find(i);
    if (e < 0 || s.c(e) !== (ansi ? SQ : c)) return -1;
    const g = glueEnd(s, e + 1, opensAt);
    if (g > e + 1) return g;
    return (c === DQ && s.c(i) === DOLLAR) || isReference(s, i) ? -1 : e + 1;
  }
  if (c === BACKSLASH && s.c(p + 1) === DQ) {
    const e = escapedValueEnd(s, p + 2, DQ, opensAt, true, s.c(p + 2) === DOLLAR || isReference(s, p + 2));
    if (e >= 0) return e;
  }
  if (!flagValueChar(c) || c === DASH || c === DOLLAR || isReference(s, p)) return -1;
  return bareGlueEnd(s, s.runEnd(p, flagValueChar), opensAt);
}

/** `(?<=SECRET_FLAG)FLAG_VALUE` */
function flagValue(s: Scan, p: number): number {
  const c = s.c(p);
  // Every value starts with no blank: inside a run of blanks, nothing is read back.
  if (!flagValueChar(c) && !isQuote(c)) return -1;
  if (!secretFlagOpensAt(s, p)) return -1;
  return flagValueEnd(s, p, secretOpensAt);
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
 * to the next `'`. It doesn't start with a space, nor with a reference as FLAG_VALUE reads one (in
 * "…" `$` too: `-u "admin:$PW"`). `opensAt`: where the flag and blanks before such a quote end.
 */
function quotedRestEnd(s: Scan, p: number, q: number, opensAt: OpensAt): number {
  const c = s.c(p);
  if (c !== c || isS(c)) return -1;
  if ((q === DQ && c === DOLLAR) || isReference(s, p)) return -1;
  if (q === DQ) return quoteRestEnd(s, p, q, opensAt);
  if (c === SQ) return emptyGlued(s, p, opensAt);
  const e = s.next("q'", (x) => x === SQ || x === CR || x === LF).find(p);
  return e > p && s.c(e) === SQ ? glued(s, e, opensAt) : -1;
}

/** Does USER_FLAG (redact.ts) end at o: `-u` or `--user` after a space or the text's start, then blanks? */
const userFlagOpensAt: OpensAt = (s, o) => {
  if (!s.blank(s.c(o - 1))) return false;
  const v = s.blanksBefore(o);
  const dashU = s.c(v - 2) === DASH && lower(s.c(v - 1)) === 117 && (v === 2 || isS(s.c(v - 3)));
  return dashU || (s.is(v - 6, '--user') && (v === 6 || isS(s.c(v - 7))));
};

/** USER_OPENER (redact.ts) ends at o: USER_FLAG, or USER_FLAG then `user:` (`-u a:'pw'`). */
const userOpensAt: OpensAt = (s, o) => {
  if (userFlagOpensAt(s, o)) return true;
  if (s.c(o - 1) !== COLON) return false;
  let u = o - 1;
  while (u > 0 && userChar(s.c(u - 1))) u--;
  return u < o - 1 && userFlagOpensAt(s, u);
};

/** SECRET_OPENER (redact.ts): any of secret-flag-value's values opens at o (a secret flag, or `-u`). */
const secretOpensAt: OpensAt = (s, o) => secretFlagOpensAt(s, o) || userOpensAt(s, o);

/** `[^}\s"']`: a character of a `${…}` user part (QUOTED_USER in redact.ts). */
const refUserChar = (c: number): boolean => flagValueChar(c) && c !== RBRACE;

/** Does `\$\{[^}\s"']*\}:` start at u? */
function refUserColonAt(s: Scan, u: number): boolean {
  if (s.c(u) !== DOLLAR || s.c(u + 1) !== LBRACE) return false;
  const r = s.next('refUser', (c) => !refUserChar(c)).find(u + 2);
  return s.c(r) === RBRACE && s.c(r + 1) === COLON;
}

/**
 * `(?<=(?:^|\s)(?:-u|--user)[ \t]+[^\s:"']+:)[^\s"']+` and what is glued to it, or the user part in
 * quotes (QUOTED_USER: a whole `${…}`, or a word with no colon that isn't one) and QUOTED_REST, or
 * the password alone in quotes after `user:` and QUOTED_REST.
 */
function userPassword(s: Scan, p: number): number {
  const q0 = s.c(p - 1);
  if (isQuote(q0) && s.c(p - 2) === COLON) {
    // `-u user:'PASSWORD'`
    let u = p - 2;
    while (u > 0 && userChar(s.c(u - 1))) u--;
    return u < p - 2 && userFlagOpensAt(s, u) ? quotedRestEnd(s, p, q0, secretOpensAt) : -1;
  }
  if (q0 !== COLON) return -1;
  let u = p - 1;
  while (u > 0 && userChar(s.c(u - 1))) u--;
  // `"${input:USER}:…"`: the colon in the reference is no separator.
  if (u < p - 1 && isQuote(s.c(u - 1)) && refUserColonAt(s, u)) u = p - 1;
  if (s.c(p - 2) === RBRACE) {
    // A whole `${…}` user part in quotes.
    let r = p - 2;
    while (r > 0 && refUserChar(s.c(r - 1))) r--;
    if (isQuote(s.c(r - 1)) && s.c(r) === DOLLAR && s.c(r + 1) === LBRACE) u = r;
  }
  if (u === p - 1) return -1;
  const q = s.c(u - 1);
  const quoted = isQuote(q);
  if (!userFlagOpensAt(s, quoted ? u - 1 : u)) return -1;
  if (quoted) return quotedRestEnd(s, p, q, secretOpensAt);
  return flagValueChar(s.c(p)) ? bareGlueEnd(s, s.runEnd(p, flagValueChar), secretOpensAt) : -1;
}

function secretFlag(s: Scan, p: number): number {
  // Each alternative's look-behind ends in a blank, the `p` of `-p`, a colon or a quote.
  const prev = s.c(p - 1);
  if (!s.blank(prev) && lower(prev) !== 112 && prev !== COLON && !isQuote(prev)) return -1;
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
const passQuoted = (s: Scan, p: number): number => quotedValueAfterKey(s, p, passKeyEndsAt);
const passBare = (s: Scan, p: number): number => keyValue(s, p, passKeyEndsAt);
/** pass-key-value: the whole value in quotes, else a word. */
function passKeyValue(s: Scan, p: number): number {
  const e = passQuoted(s, p);
  return e >= 0 ? e : passBare(s, p);
}

/** `(?<=\b(?:Proxy-|Set-)?NAME(?:\\?["'])?WS*[:=]WS*)` then QUOTED_VALUE: a header's value in quotes, after the quote before p. */
function quotedHeader(s: Scan, p: number, name: string): number {
  const o = valueOpen(s, p);
  if (o < 0) return -1;
  const named = (t: Scan, i: number): boolean => {
    const k = keyEnd(t, i);
    return k >= 0 && t.is(k - name.length, name) && !isWord(t.c(k - name.length - 1));
  };
  return named(s, o) ? quotedValueEnd(s, p, named) : -1;
}

// The patterns that read `[ \t]` around a separator or after a flag, in DEFAULT_PATTERNS order:
// authorization-header, cookie-header, bearer-token, secret-key-value-quoted, secret-key-value,
// pass-key-value, secret-flag-value, keycloak-client-secret.

// The ones that can match, by what comes before the value (the others can't: each needs one of these).
const AFTER_QUOTE = [quotedKeyValue, secretKeyValue, passKeyValue, secretFlag, keycloakSecret];
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
  /**
   * The flag counts only among the tool's own options, right after its name (ownOptionStarts):
   * for a tool that runs a command, whose options are not its own. The letters of its options that
   * take a value (the next word).
   */
  ownOptions?: string;
}

export const PASSWORD_TOOLS: readonly PasswordToolRule[] = [
  // sshpass -p PASSWORD (getopt: -pPASSWORD too), before the command it runs (`ssh -p 2222` is a port)
  { tools: ['sshpass'], flags: ['-p'], space: true, glued: true, ownOptions: 'fdpP' },
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

/**
 * Commands that run a later word as a command: an option after one, or after its options, doesn't
 * take the next word as its value (`sudo -E -H sshpass`), unless it is one of the wrapper's
 * WRAPPER_VALUE_OPTIONS (`sudo -u mongo`): then the next word is that value, and the wrapper's
 * options go on after it (`sudo -u root -E sshpass`).
 */
export const WRAPPERS = ['sudo', 'doas', 'env', 'time', 'xargs', 'nice', 'nohup', 'stdbuf', 'timeout'];
/** The one-letter options that take a value (the next word), by wrapper. */
export const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, string>> = { sudo: 'ugChprtUDRT', env: 'uCS', timeout: 'sk', nice: 'n', stdbuf: 'ioe' };
/** By an option's letter (ASCII): the wrappers (bits, in WRAPPERS order) it takes a value of. */
const VALUE_OPTION_OF = new Int32Array(128);
WRAPPERS.forEach((w, bit) => {
  for (const ch of WRAPPER_VALUE_OPTIONS[w] ?? '') VALUE_OPTION_OF[ch.charCodeAt(0)]! |= 1 << bit;
});

/** The wrappers (bits) whose `(?<![\w.-])NAME` ends at x. */
function wrappersEndingAt(s: Scan, x: number): number {
  let m = 0;
  WRAPPERS.forEach((w, bit) => {
    if (s.has(x - w.length, w) && !keyChar(s.c(x - w.length - 1))) m |= 1 << bit;
  });
  return m;
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
/** The rules (bits) with `ownOptions`. */
const OWN_BITS = PASSWORD_TOOLS.reduce((m, r, bit) => (r.ownOptions !== undefined ? m | (1 << bit) : m), 0);

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
  /** For ownOptionStarts: each counted name of a rule with `ownOptions` (its end, the rules, the quote it is in). */
  const ownRuns: number[] = [];
  /** The rules with a tool counted in this segment. */
  let active = 0;
  /** The quote the scan is in (DQ or SQ), or 0. */
  let quote = 0;
  /** The next character is escaped in "…" (`\"`, `\\`). */
  let escaped = false;
  let continuedCR = false;
  /**
   * optionStep's and assignStep's states for the run of non-spaces being read, whether it is
   * `-[\w-]+` so far (0 nothing read, 1 `-`, 2 yes, 3 no) and its length; whether the blanks being
   * read follow an option's name (one not in a wrapper's options, or one of a wrapper's that takes a
   * value), and whether the last run was `NAME=value`.
   */
  let option = 0;
  let assign = 2;
  let dashWord = 0;
  let wordLength = 0;
  let inWord = false;
  let afterOption = false;
  let lastAssign = false;
  /**
   * The wrappers (bits) whose options the next run may be (WRAPPER in redact.ts: after the wrapper
   * and blanks, and after each of its options or an option's value), and those whose option before
   * takes the next run as its value.
   */
  let wrapped = 0;
  let valueNext = 0;
  /** Only line blanks since the text's start, a line break, `|`, `;` or `&`. */
  let afterBreak = true;
  let segment = 0;
  /**
   * The word being read (from the segment's start or a space): where it starts, whether it is no
   * option's value there, and the end of its `[A-Za-z_][\w.-]*` start (-1: none). Whether the path
   * being read (a run of PATH_CHAR) is in command position, and whether it starts after a space
   * and is no option's value (a tool in it counts in a `bin/` directory, or as `NAME.exe`).
   */
  let wordStart = -1;
  let wordNov = false;
  let keyEnd = -1;
  let pathCommand = false;
  let pathNov = false;
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
    // `(`, a backtick or `{`, or after a wrapper (and its options) or `NAME=value`.
    if ((k & C_PATH) !== 0 && (prevK & C_PATH) === 0) {
      pathCommand =
        prevK === 0 || (prevK & C_BREAK) !== 0 || ((prevK & C_LEFT) !== 0 && ((prevK & C_SPACE) === 0 || afterBreak || wrapped !== 0 || lastAssign));
      pathNov = (prevK & C_SPACE) !== 0 && nov;
    }
    const tools = c < 128 ? TOOLS_BY_FIRST[lower(c)] : undefined;
    if (tools) {
      // Where a tool's name counts (see redact.ts, before toolRule). In quotes: after
      // TOOL_LEFT_QUOTED, no option's value. Out of quotes: at the segment's start or after
      // TOOL_LEFT, no option's value; after a prefix (`@`, `-`, `@-`, `-@`, `NAME=`, `NAME=-`,
      // `NAME=@`, `NAME:`) that starts a word that is no option's value; after a path in command
      // position; after a path that is no option's value, in a `bin/` directory or as `NAME.exe`.
      let counts: boolean;
      let exeOnly = false;
      if (quote !== 0) counts = nov && ((prevK & C_LEFT) !== 0 || prev === SLASH || prev === BACKSLASH);
      else if (x === segment || (prevK & C_LEFT) !== 0) counts = nov;
      else if (prev === SLASH || prev === BACKSLASH) {
        counts = pathCommand || pathNov;
        exeOnly = !pathCommand && !s.has(x - 4, 'bin');
      } else if (prev === AT || prev === DASH)
        counts =
          wordNov && (wordStart === x - 1 || (wordStart === x - 2 && s.c(x - 2) === (prev === AT ? DASH : AT)) || (s.c(x - 2) === EQ && keyEnd === x - 2));
      else counts = (prev === EQ || prev === COLON) && wordNov && keyEnd === x - 1;
      if (counts) {
        for (const t of tools) {
          if (!(t.anyCase ? s.is(x, t.name) : s.has(x, t.name))) continue;
          const end = x + t.name.length;
          const nameEnd = !exeOnly && toolRight(s.c(end)) ? end : s.is(end, '.exe') && toolRight(s.c(end + 4)) ? end + 4 : -1;
          if (nameEnd < 0) continue;
          active |= t.bits;
          if ((t.bits & OWN_BITS) !== 0) ownRuns.push(nameEnd, t.bits & OWN_BITS, quote);
        }
        present |= active;
      }
    }
    masks[x] = active;
    if (space) {
      if (inWord) {
        // A wrapper's option that takes a value: `-X` whole, X one of its WRAPPER_VALUE_OPTIONS.
        const valueOf = wordLength === 2 && dashWord === 2 && prev < 128 ? VALUE_OPTION_OF[prev]! & wrapped : 0;
        afterOption = ((option === 2 || option === 4) && wrapped === 0) || valueOf !== 0;
        wrapped = (dashWord === 2 ? wrapped & ~valueOf : 0) | valueNext | (WRAPPER_LAST.has(prev) ? wrappersEndingAt(s, x) : 0);
        valueNext = valueOf;
        lastAssign = assign === 1;
      }
      inWord = false;
    } else {
      option = optionStep(inWord ? option : 0, c);
      assign = inWord ? assignStep(assign, c) : (k & C_START) !== 0 ? 0 : 2;
      dashWord = !inWord ? (c === DASH ? 1 : 3) : dashWord !== 3 && (isWord(c) || c === DASH) ? 2 : 3;
      wordLength = inWord ? wordLength + 1 : 1;
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
        // `\\`, and `\"` but before CLOSES (DQ_CHAR in redact.ts).
        const d = s.c(x + 1);
        escaped = d === BACKSLASH || (d === DQ && !closesAt(s, x + 2));
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
  if (ownRuns.length > 0) s.ownStarts = ownOptionStarts(s, ownRuns);
  return masks;
}

/** `[^\s|;&]` */
const ownWordStart = (c: number): boolean => c === c && !isS(c) && c !== PIPE && c !== SEMI && c !== AMP;

/** The end of the run of OWN_W (redact.ts) from i: characters of `[^\s|;&]` but quotes, and whole quotes. */
function ownWordEnd(s: Scan, i: number): number {
  for (;;) {
    const c = s.c(i);
    if (isQuote(c)) {
      const e = s.next(c === DQ ? 'q"' : "q'", (x) => x === c || x === CR || x === LF).find(i + 1);
      if (s.c(e) !== c) return i;
      i = e + 1;
    } else if (ownWordStart(c)) i++;
    else return i;
  }
}

/** The end of the blanks from i: line blanks, and (out of the regular expression's reach) a `\` before a line break. */
function ownBlanksEnd(s: Scan, i: number): number {
  for (;;) {
    const c = s.c(i);
    if (isLineBlank(c)) i++;
    else if (c === BACKSLASH && s.c(i + 1) === LF) i += 2;
    else if (c === BACKSLASH && s.c(i + 1) === CR) i += s.c(i + 2) === LF ? 3 : 2;
    else return i;
  }
}

/**
 * For the rules with `ownOptions`, where their flag may start (bits, by place): after the blanks
 * that follow a counted name (and the quote it is in, if that closes right after it), then after
 * each option and its blanks (ownOptionRun in redact.ts). `runs`: the name's end, the rules (bits)
 * and the quote it is in, three numbers each. A place already read for a rule ends that run: what
 * follows it was read too, so the text is read once per rule.
 */
function ownOptionStarts(s: Scan, runs: readonly number[]): Int32Array {
  const starts = new Int32Array(s.n + 1);
  for (let r = 0; r < runs.length; r += 3) {
    for (let m = runs[r + 1]!; m !== 0; m &= m - 1) {
      const bit = m & -m;
      const letters = PASSWORD_TOOLS[31 - Math.clz32(bit)]!.ownOptions!;
      let x = runs[r]!;
      const q = runs[r + 2]!;
      if (q !== 0 && s.c(x) === q) x++;
      for (;;) {
        const b = ownBlanksEnd(s, x);
        if (b === x || (starts[b]! & bit) !== 0) break;
        x = b;
        starts[x]! |= bit;
        if (s.c(x) !== DASH) break;
        const v = s.c(x + 1);
        if (v === v && letters.includes(String.fromCharCode(v)) && !ownWordStart(s.c(x + 2))) {
          // `-X VALUE`
          const b2 = ownBlanksEnd(s, x + 2);
          const e = ownWordEnd(s, b2);
          if (b2 === x + 2 || e === b2) break;
          x = e;
        } else x = ownWordEnd(s, x + 1);
      }
    }
  }
  return starts;
}

/**
 * Does one of `rule`'s flags end at f, after a line blank (or a continued line break) in a segment
 * where one of its tools counts (with `ownOptions`: among that tool's options)?
 */
function toolFlagEndsAt(s: Scan, f: number, rule: PasswordToolRule, bit: number): boolean {
  for (const flag of rule.flags) {
    const at = f - flag.length;
    if (at <= 0 || !flagAt(s, at, flag, rule)) continue;
    const m = toolsBefore(s)[at - 1]!;
    if ((m & (1 << bit)) === 0 || (!isLineBlank(s.c(at - 1)) && (m & CONTINUED) === 0)) continue;
    if (rule.ownOptions === undefined || ((s.ownStarts?.[at] ?? 0) & (1 << bit)) !== 0) return true;
  }
  return false;
}

/** Does the flag of `rule` end at f, with the value (or the user part of it) from v on: after blanks, or glued? */
function toolFlagBefore(s: Scan, v: number, rule: PasswordToolRule, bit: number): boolean {
  if (s.blank(s.c(v - 1))) return rule.space === true && toolFlagEndsAt(s, s.blanksBefore(v), rule, bit);
  return rule.glued === true && toolFlagEndsAt(s, v, rule, bit);
}

/**
 * OpensAt for `rule`'s values (toolRule `opener` in redact.ts): one of its flags after a line
 * blank, then its gap (blanks with `space`, none with `glued`), ends at the quote. Weaker than
 * toolFlagBefore (no tool needed), but every value of the rule opens after one. With `ownOptions`
 * never: its flag counts only at the start of an option word (ownOptionStarts), so no quote glued
 * to a value opens one.
 */
const toolOpensAt =
  (rule: PasswordToolRule): OpensAt =>
  (s, o) => {
    // Where the flag ends: before the blanks (`space`; with `glued` too, there may be none), else at o.
    const b = s.blanksBefore(o);
    let f = o;
    if (rule.space && (b < o || rule.glued)) f = b;
    else if (!rule.glued) return false;
    return rule.flags.some((flag) => {
      const at = f - flag.length;
      if (!flagAt(s, at, flag, rule) || !isLineBlank(s.c(at - 1))) return false;
      if (rule.ownOptions === undefined) return true;
      // With `ownOptions`: not right after `''` or `""` (but `\''`), inside the value's word.
      const q = s.c(at - 2);
      return !(isQuote(q) && s.c(at - 3) === q && s.c(at - 4) !== BACKSLASH);
    });
  };

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
        const e = quotedRestEnd(s, p, q, toolOpensAt(rule));
        if (e >= 0) return e;
        continue;
      }
      if (!flagValueChar(c)) continue;
      // After blanks, the user part is the whole run; glued, the run starts with the flag (a flag
      // follows a `\s`, so it can only start the run) and the user part is the rest.
      const spaced = rule.space === true && s.blank(q) && toolFlagEndsAt(s, s.blanksBefore(u), rule, bit);
      const glued = rule.glued === true && rule.flags.some((f) => u + f.length < p - 1 && flagAt(s, u, f, rule) && toolFlagEndsAt(s, u + f.length, rule, bit));
      if (spaced || glued) return bareGlueEnd(s, s.runEnd(p, flagValueChar), toolOpensAt(rule));
      continue;
    }
    if (rule.prefix !== undefined) {
      const at = p - rule.prefix.length;
      if (!s.has(at, rule.prefix)) continue;
      if (flagValueChar(c) && toolFlagBefore(s, at, rule, bit)) return bareGlueEnd(s, s.runEnd(p, flagValueChar), toolOpensAt(rule));
      const q = s.c(at - 1);
      if (isQuote(q) && toolFlagBefore(s, at - 1, rule, bit)) {
        const e = quotedRestEnd(s, p, q, toolOpensAt(rule));
        if (e >= 0) return e;
      }
      continue;
    }
    if (!(flagEnd < p ? rule.space === true : rule.glued === true) || !toolFlagEndsAt(s, flagEnd, rule, bit)) continue;
    const e = flagValueEnd(s, p, toolOpensAt(rule));
    if (e >= 0) return e;
  }
  return htpasswdBatch(s, p);
}

/** `[0-9A-BD-Za-qs-z]`: an option letter of htpasswd's that takes no value (HT_LETTER in redact.ts). */
const htLetter = (c: number): boolean => isAlnum(c) && c !== 67 && c !== 114;
/** `\S` */
const nonSpace = (c: number): boolean => c === c && !isS(c);
const HT_B = 1;
const HT_N = 2;
const HT_DONE = 4;

/**
 * Where htpasswd's password starts (HTPASSWD in redact.ts): after `\bhtpasswd` and blanks, its
 * options (HT_OPTION: getopt's, in one word or several, `-C` and `-r` with a value), one with `b`,
 * then FILE and USER (USER only with `n`), each in quotes or a word that doesn't start with `-`,
 * and blanks. Each option and each argument is read once, whichever htpasswd reads it.
 */
function htpasswdStarts(s: Scan): Uint8Array {
  if (s.htpasswd) return s.htpasswd;
  const starts = new Uint8Array(s.n + 1);
  /** By an option's start: the start of the first word after the options from there (-2: none), and whether `b` and `n` were among them. */
  const optEnd = new Int32Array(s.n + 1);
  const optHas = new Uint8Array(s.n + 1);
  /** By an argument's start: the start of the next word (-2: no argument, 0: not read yet). */
  const argNext = new Int32Array(s.n + 1);
  const blanksEnd = (i: number): number => s.runEnd(i, s.blank);
  /** HT_OPTION at x: the start of the next word, its letters (HT_B, HT_N), or -1. */
  const option = (x: number): [number, number] | undefined => {
    if (s.c(x) !== DASH || !isAlnum(s.c(x + 1))) return undefined;
    let y = x + 1;
    let has = 0;
    for (; htLetter(s.c(y)); y++) has |= s.c(y) === 98 ? HT_B : s.c(y) === 110 ? HT_N : 0;
    const c = s.c(y);
    if (c === 67 || c === 114) {
      // `-C10` or `-C 10`
      if (nonSpace(s.c(y + 1))) y = s.runEnd(y + 1, nonSpace);
      else {
        const b = blanksEnd(y + 1);
        const e = s.runEnd(b, nonSpace);
        if (b === y + 1 || e === b) return undefined;
        y = e;
      }
    }
    const b = blanksEnd(y);
    return b === y ? undefined : [b, has];
  };
  /** The options from x: fills optEnd and optHas for x and each option after it. */
  const options = (x: number): void => {
    const path: number[] = [];
    let at = x;
    for (;;) {
      if ((optHas[at]! & HT_DONE) !== 0) break;
      const o = option(at);
      if (!o) {
        optEnd[at] = at;
        optHas[at] = HT_DONE;
        break;
      }
      path.push(at, o[1]);
      at = o[0];
    }
    for (let k = path.length - 2; k >= 0; k -= 2) {
      const from = path[k]!;
      const next = k + 2 < path.length ? path[k + 2]! : at;
      optEnd[from] = optEnd[next]!;
      optHas[from] = path[k + 1]! | (optHas[next]! & (HT_B | HT_N)) | HT_DONE;
    }
  };
  /** HT_ARG at a: the start of the next word, or -2. */
  const arg = (a: number): number => {
    if (a > s.n) return -2;
    if (argNext[a] !== 0) return argNext[a]!;
    const c = s.c(a);
    let y = -1;
    if (isQuote(c)) {
      const e = s.next(c === DQ ? 'q"' : "q'", (x) => x === c || x === CR || x === LF).find(a + 1);
      if (s.c(e) === c) y = e + 1;
    } else if (flagValueChar(c) && c !== DASH) y = s.runEnd(a, flagValueChar);
    const b = y < 0 ? y : blanksEnd(y);
    return (argNext[a] = y < 0 || b === y ? -2 : b);
  };
  for (let i = s.t.indexOf('htpasswd'); i >= 0; i = s.t.indexOf('htpasswd', i + 1)) {
    if (isWord(s.c(i - 1))) continue;
    const w = blanksEnd(i + 8);
    if (w === i + 8) continue;
    options(w);
    const end = optEnd[w]!;
    const has = optHas[w]!;
    if (end === w || (has & HT_B) === 0) continue;
    let v = arg(end);
    if ((has & HT_N) === 0 && v >= 0) v = arg(v);
    if (v >= 0) starts[v] = 1;
  }
  return (s.htpasswd = starts);
}

/** OpensAt for htpasswd's password (HTPASSWD in redact.ts): a blank before the quote, as before any password. */
const htpasswdOpensAt: OpensAt = (s, o) => s.blank(s.c(o - 1));

/** HTPASSWD (redact.ts) at p: htpasswd's password, read as FLAG_VALUE. */
function htpasswdBatch(s: Scan, p: number): number {
  if (htpasswdStarts(s)[p] !== 1) return -1;
  return flagValueEnd(s, p, htpasswdOpensAt);
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
const spacedQuoted = (s: Scan, p: number): number => quotedValueAfterKey(s, p, spacedKeyEndsAt);
const spacedBare = (s: Scan, p: number): number => keyValue(s, p, spacedKeyEndsAt);

const SECRET_KEYS_RE = /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|credential|\.key|rediscli_auth|sshpass/i;

type Matcher = (s: Scan, p: number) => number;

/**
 * What a pattern found in parts finds, in one pass: [the whole pattern's spans, then each
 * alternative's], each as its own global regular expression finds them. At each position, an
 * alternative is tried if its own last match ended there or before, and the whole pattern is the
 * first alternative that matches there (a regular expression's `|`): each alternative's matcher
 * runs at most once a position. The first QUOTE_OPENINGS.length alternatives (byOpening) match only
 * after a quote: elsewhere they are not called.
 */
function partSpans(alts: readonly Matcher[], mustHave: RegExp, blank: (c: number) => boolean = isBlank): (text: string) => Spans[] {
  const quoted = QUOTE_OPENINGS.length;
  return (text) => {
    const out: Spans[] = [[], ...alts.map((): Spans => [])];
    if (!mustHave.test(text)) return out;
    const s = new Scan(text, blank);
    // Where each one (the whole pattern, then each alternative) may match next.
    const from = new Array<number>(alts.length + 1).fill(0);
    for (let p = 0; p < s.n; p++) {
      let whole = from[0]! <= p;
      for (let j = isQuote(s.c(p - 1)) ? 0 : quoted; j < alts.length; j++) {
        const own = from[j + 1]! <= p;
        if (!own && !whole) continue;
        const e = alts[j]!(s, p);
        if (e <= p) continue;
        if (own) {
          out[j + 1]!.push([p, e]);
          from[j + 1] = e;
        }
        if (whole) {
          out[0]!.push([p, e]);
          from[0] = e;
          whole = false;
        }
      }
    }
    return out;
  };
}

/** The patterns redact.ts finds in parts (SPLIT_PATTERNS), by name: their alternatives in its order. */
const PART_SPANS = new Map([
  ['secret-key-value-quoted', partSpans(byOpening(quotedKeyValue), SECRET_KEYS_RE)],
  ['pass-key-value', partSpans([...byOpening(passQuoted), passBare], /pass/i)],
  ['secret-key-value-spaced', partSpans([...byOpening(spacedQuoted), spacedBare], /key|phrase/i, isWideBlank)],
]);
/**
 * Each part of those patterns on its own: the whole pattern's matcher, then one for each
 * alternative (in that order), each read on the whole text (test/redactScan.test.ts compares each
 * with its regular expression). Their union is the pattern's (LINEAR_FINDERS).
 */
export const LINEAR_PARTS: ReadonlyMap<string, readonly SpanFinder[]> = new Map(
  [...PART_SPANS].map(([name, spans]) => [name, spans('').map((_, i): SpanFinder => (text) => spans(text)[i]!)]),
);
/** The union of what the parts of `name` find, in order and not overlapping. */
const unionOf =
  (name: string): SpanFinder =>
  (text) =>
    mergeSpans(PART_SPANS.get(name)!(text).flat());

/** The built-in patterns (by name) that have a linear matcher. redact.ts uses one only for that exact pattern. */
export const LINEAR_FINDERS: ReadonlyMap<string, SpanFinder> = new Map([
  ['authorization-header', finder(authHeader, /authorization/i)],
  ['cookie-header', finder(cookieHeader, /cookie/i)],
  ['bearer-token', finder(bearer, /bearer/i)],
  ['jwt', finder(jwt, /eyJ/)],
  ['secret-key-value-quoted', unionOf('secret-key-value-quoted')],
  ['secret-key-value', finder(secretKeyValue, SECRET_KEYS_RE)],
  ['pass-key-value', unionOf('pass-key-value')],
  ['secret-flag-value', finder(secretFlag, /-|requirepass|masterauth/i)],
  ['keycloak-client-secret', finder(keycloakSecret, /secret/i)],
  // The widened ones (they read Unicode spaces as blanks).
  ['authorization-header-quoted', finder((s, p) => quotedHeader(s, p, 'authorization'), /authorization/i, isWideBlank)],
  ['cookie-header-quoted', finder((s, p) => quotedHeader(s, p, 'cookie'), /cookie/i, isWideBlank)],
  ['secret-after-unicode-space', finder(separatedWide, undefined, isWideBlank)],
  ['password-flag-tool', finder(passwordTool, TOOLS_RE, isWideBlank)],
  ['secret-key-value-spaced', unionOf('secret-key-value-spaced')],
]);

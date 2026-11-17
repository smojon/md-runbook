/**
 * Linear-time matchers for the pseudonymizer's namespace and URL patterns (aiContext.ts), which
 * backtracked quadratically: NS_RE's and NS_FLAG_RE's look-behinds over a run of blanks (20,000
 * blanks took 2.5 s), and URL_RE retried from each start inside one run (`a.a.a…`). Each finds
 * exactly what its regular expression finds with the g flag; the regular expressions stay in
 * aiContext.ts as the definition, and test/pseudonymScan.test.ts compares the two.
 */
import { Scan, SpanFinder, finder, isAlnum, isAlpha, isBlank, isQuote, isRegexSpace, isWord, lower } from './redactScan';

const LF = 10;
const CR = 13;
const DQ = 34;
const DOLLAR = 36;
const PLUS = 43;
const DASH = 45;
const DOT = 46;
const SLASH = 47;
const COLON = 58;
const EQ = 61;
const AT = 64;
const US = 95;

/** `^` with the m flag at i. */
const lineStart = (s: Scan, i: number): boolean => {
  const c = s.c(i - 1);
  return i === 0 || c === LF || c === CR || c === 0x2028 || c === 0x2029;
};

/** `[-a-z0-9]` (i flag) */
const nsChar = (c: number): boolean => isAlnum(c) || c === DASH;

/**
 * NS_NAME at p, `[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?![\w.-])`: the run of `[-a-z0-9]` from p, if it
 * ends in a letter or digit and no `_` or `.` follows (a shorter match is always followed by one
 * of the run's own characters).
 */
function nsName(s: Scan, p: number): number {
  const r = s.runEnd(p + 1, nsChar);
  if (!isAlnum(s.c(r - 1))) return -1;
  const after = s.c(r);
  return after === US || after === DOT ? -1 : r;
}

/** Does `(?:^|[ \t])-n` end at e? */
const dashNEndsAt = (s: Scan, e: number): boolean =>
  s.c(e - 2) === DASH && lower(s.c(e - 1)) === 110 && (lineStart(s, e - 2) || isBlank(s.c(e - 3)));

/** NS_FLAG_RE: `(?<=(?:^|[ \t])-n(?:[ \t]+|=)?["']?)NS_NAME` (flags gim) */
function nsFlag(s: Scan, p: number): number {
  if (!isAlnum(s.c(p))) return -1;
  // A quote before p is the optional one: without it, the `-n`, `=` or blanks would end in a quote.
  const q = isQuote(s.c(p - 1)) ? p - 1 : p;
  const flag = dashNEndsAt(s, q) || (s.c(q - 1) === EQ && dashNEndsAt(s, q - 1)) || (isBlank(s.c(q - 1)) && dashNEndsAt(s, s.blanksBefore(q)));
  return flag ? nsName(s, p) : -1;
}

/** `\bWORD` starts at i (WORD starts with a letter). */
const wordAt = (s: Scan, i: number, word: string): boolean => s.is(i, word) && !isWord(s.c(i - 1));

/** `(?:\$|\b)(?:ns|namespace|\w+_ns|\w+_namespace)` ends at k. (`\w+`'s first character always has a word boundary before it.) */
function nsVariableEndsAt(s: Scan, k: number): boolean {
  for (const w of ['ns', 'namespace']) {
    const at = k - w.length;
    if (s.is(at, w) && (s.c(at - 1) === DOLLAR || !isWord(s.c(at - 1)))) return true;
  }
  for (const w of ['_ns', '_namespace']) {
    const at = k - w.length;
    if (s.is(at, w) && isWord(s.c(at - 1))) return true;
  }
  return false;
}

/** NS_RE's look-behind (flags gim) at p: one of its eight forms ends there. */
function nsContext(s: Scan, p: number): boolean {
  const before = s.c(p - 1);
  // The forms that end in `["']?`: a quote before p is theirs (without it, they would end in a quote).
  const q = isQuote(before) ? p - 1 : p;
  const b = s.blanksBefore(q);
  // `--namespace(?:=|[ \t]+)["']?`
  if (s.c(q - 1) === EQ && s.is(q - 12, '--namespace')) return true;
  if (b < q && s.is(b - 11, '--namespace')) return true;
  // `\bnamespace:[ \t]*["']?`
  if (s.c(b - 1) === COLON && wordAt(s, b - 10, 'namespace')) return true;
  // `\boc[ \t]+(?:new-)?project[ \t]+["']?`
  if (b < q && s.is(b - 7, 'project')) {
    let k = b - 7;
    if (s.is(k - 4, 'new-')) k -= 4;
    if (isBlank(s.c(k - 1))) {
      const o = s.blanksBefore(k);
      if (wordAt(s, o - 2, 'oc')) return true;
    }
  }
  // `\bkubens[ \t]+["']?`
  if (b < q && wordAt(s, b - 6, 'kubens')) return true;
  // `(?:\$|\b)(?:ns|namespace|\w+_ns|\w+_namespace)[ \t]*=[ \t]*["']?`
  if (s.c(b - 1) === EQ && nsVariableEndsAt(s, s.blanksBefore(b - 1))) return true;
  if (before === DQ) {
    const j = s.blanksBefore(p - 1);
    // `"namespace"[ \t]*:[ \t]*"`
    if (s.c(j - 1) === COLON && s.is(s.blanksBefore(j - 1) - 11, '"namespace"')) return true;
    // `\b(?:namespaces?|projects?)[ \t]+"`
    if (j < p - 1) for (const w of ['namespace', 'namespaces', 'project', 'projects']) if (wordAt(s, j - w.length, w)) return true;
  }
  // `\bnamespace/`
  return before === SLASH && wordAt(s, p - 10, 'namespace');
}

function ns(s: Scan, p: number): number {
  return isAlnum(s.c(p)) && nsContext(s, p) ? nsName(s, p) : -1;
}

/** Where NS_FLAG_RE matches, in linear time. */
export const findNamespaceFlags: SpanFinder = finder(nsFlag, /-n/i);
/** Where NS_RE matches, in linear time (each of its forms holds `ns`, `namespace` or `project`). */
export const findNamespaces: SpanFinder = finder(ns, /ns|namespace|project/i);

/** `[a-z0-9+.-]` (i flag) */
const schemeChar = (c: number): boolean => isAlnum(c) || c === PLUS || c === DOT || c === DASH;
/** `[a-z0-9-]` (i flag) */
const hostChar = nsChar;
/** `[^\s/@]` */
const userChar = (c: number): boolean => c === c && !isRegexSpace(c) && c !== SLASH && c !== AT;

/**
 * Where URL_RE (`\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)`, gi) matches:
 * [start, end, start of the host (group 1, which ends the match)], in linear time.
 */
export function findUrls(text: string): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  if (!text.includes('://')) return out;
  const s = new Scan(text);
  // Each start inside one run of scheme characters ends its scheme at the same place: found once.
  const scheme = s.next('scheme', (c) => !schemeChar(c));
  for (let p = 0; p < s.n; ) {
    if (isAlpha(s.c(p)) && !isWord(s.c(p - 1))) {
      const r = scheme.find(p + 1);
      if (s.c(r) === COLON && s.c(r + 1) === SLASH && s.c(r + 2) === SLASH) {
        const u = s.runEnd(r + 3, userChar);
        // `user@` is taken when a host follows it; else the host starts after `//`.
        const h = s.c(u) === AT && hostChar(s.c(u + 1)) ? u + 1 : r + 3;
        if (hostChar(s.c(h))) {
          let e = s.runEnd(h, hostChar);
          while (s.c(e) === DOT && hostChar(s.c(e + 1))) e = s.runEnd(e + 1, hostChar);
          out.push([p, e, h]);
          p = e;
          continue;
        }
      }
    }
    p++;
  }
  return out;
}

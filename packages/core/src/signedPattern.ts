/**
 * The patterns a signed runbook gives its parameters: POSIX extended regular expressions, which
 * md-runbook-gate checks each value against (apps/gate/internal/ere) and clients check first.
 *
 * Only a subset both read the same way is accepted (by signing, by parseManifest and by the gate),
 * so a pattern means one thing everywhere and a value can't leave the whole-value anchors:
 *
 * - outside brackets, a backslash only before one of `.[]()*+?{}|^$\` (`\t`, `\x41`, `\d` were
 *   letters to the gate and something else to clients);
 * - parentheses balanced, no `(?`; an `a)|(b` read as `^(a)|(b)$` matched any value starting with
 *   `a` (review of 0.28.0, M1);
 * - a repetition (`* + ? {m,n}`) only after something it repeats, never right after another one
 *   (no `a**`, no lazy `a+?`); `{m}`, `{m,}` and `{m,n}` with m <= n <= 255, no other `{` or `}`,
 *   and no `]` outside brackets;
 * - in brackets: printable ASCII without a backslash (`[a\-z]` held a backslash for the gate and not
 *   for clients, M2), POSIX classes (`[[:alpha:]]`), `[=c=]`, `[.c.]`, ranges low to high; not
 *   `[:alpha:]` alone, which grep refused (it is no class there);
 * - no control character.
 *
 * Values are matched byte for byte (the C locale, as the gate): `.` is one byte of UTF-8.
 */

/** Characters special outside brackets: a backslash may come only before one of these. */
const SPECIAL = '.[]()*+?{}|^$\\';
const POSIX_CLASS: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-/:-@\\[-`{-~',
  space: ' \\t\\n\\v\\f\\r',
  upper: 'A-Z',
  xdigit: '0-9A-Fa-f',
};
/** The largest repetition count ({m,n}). */
export const MAX_REPEAT = 255;

const hex = (code: number): string => '\\x' + code.toString(16).padStart(2, '0');
const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];

interface Parsed {
  problem?: string;
  /** The pattern as a JavaScript regular expression over UTF-8 bytes as characters U+0000 to U+00FF. */
  js?: string;
}

/** One bracket expression at `p[i]` (`[`): its JavaScript form and where it ends, or a problem. */
function bracket(p: string, i: number): { js: string; end: number } | { problem: string } {
  let k = i + 1;
  let neg = false;
  if (p[k] === '^') {
    neg = true;
    k++;
  }
  const start = k;
  const items: ({ c: number } | { cls: string })[] = [];
  for (;;) {
    if (k >= p.length) return { problem: 'a [ without its ]' };
    const ch = p[k]!;
    if (ch === ']' && k > start) {
      k++;
      break;
    }
    if (ch === '\\') return { problem: 'a backslash in brackets (grep and JavaScript read it differently): leave it out, or write \\ outside' };
    if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7e) return { problem: 'only printable ASCII in brackets' };
    if (ch === '[' && (p[k + 1] === ':' || p[k + 1] === '=' || p[k + 1] === '.')) {
      const kind = p[k + 1]!;
      const close = p.indexOf(kind + ']', k + 2);
      if (close < 0) return { problem: `[${kind} without ${kind}]` };
      const name = p.slice(k + 2, close);
      k = close + 2;
      if (kind === ':') {
        if (!Object.prototype.hasOwnProperty.call(POSIX_CLASS, name)) return { problem: `[:${name}:] is no POSIX class` };
        items.push({ cls: name });
      } else {
        if (name.length !== 1 || name === '\\' || name.charCodeAt(0) < 0x20 || name.charCodeAt(0) > 0x7e) return { problem: `[${kind}${name}${kind}] is not one character` };
        items.push({ c: name.charCodeAt(0) });
      }
      continue;
    }
    items.push({ c: ch.charCodeAt(0) });
    k++;
  }
  // `[:alpha:]` alone: grep refused it (the class is written [[:alpha:]]).
  const body = p.slice(start, k - 1);
  if (body.length >= 2 && body.startsWith(':') && body.endsWith(':')) return { problem: `[${neg ? '^' : ''}${body}] is no class: write [[${body}]]` };
  let js = neg ? '[^' : '[';
  for (let n = 0; n < items.length; n++) {
    const it = items[n]!;
    const dash = items[n + 1];
    const hi = items[n + 2];
    if (dash && 'c' in dash && dash.c === 0x2d && hi && n + 2 < items.length) {
      if (!('c' in it) || !('c' in hi)) return { problem: 'a range from or to a class' };
      if (it.c > hi.c) return { problem: `the range ${String.fromCharCode(it.c)}-${String.fromCharCode(hi.c)} is backwards` };
      js += `${hex(it.c)}-${hex(hi.c)}`;
      n += 2;
      continue;
    }
    js += 'cls' in it ? POSIX_CLASS[it.cls]! : hex(it.c);
  }
  return { js: js + ']', end: k };
}

function parse(p: string): Parsed {
  let js = '';
  let depth = 0;
  /** Something a repetition can follow (a character, a set, a group), and whether the last thing was a repetition. */
  let atom = false;
  let repeated = false;
  for (let i = 0; i < p.length; ) {
    const ch = p[i]!;
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return { problem: 'a control character' };
    if (ch === '\\') {
      const d = p[i + 1];
      if (d === undefined || !SPECIAL.includes(d)) {
        return { problem: `\\${d ?? ''}: a backslash only before one of ${SPECIAL} (servers check with grep -E; \\d, \\w, \\t mean other things there)` };
      }
      js += hex(d.charCodeAt(0));
      i += 2;
      atom = true;
      repeated = false;
      continue;
    }
    if (ch === '[') {
      const b = bracket(p, i);
      if ('problem' in b) return { problem: b.problem };
      js += b.js;
      i = b.end;
      atom = true;
      repeated = false;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      let op = ch;
      let next = i + 1;
      if (ch === '{') {
        const m = /^\{(0|[1-9][0-9]{0,2})(,(0|[1-9][0-9]{0,2})?)?\}/.exec(p.slice(i));
        if (!m) return { problem: 'a { that is no {m}, {m,} or {m,n}: write \\{' };
        const lo = Number(m[1]);
        const hi = m[2] === undefined ? lo : m[3] === undefined ? undefined : Number(m[3]);
        if (lo > MAX_REPEAT || (hi !== undefined && (hi > MAX_REPEAT || hi < lo))) return { problem: `${m[0]}: counts from 0 to ${MAX_REPEAT}, the first no larger` };
        op = m[0];
        next = i + m[0].length;
      }
      if (!atom) return { problem: `${op} repeats nothing` };
      if (repeated) return { problem: `${op} right after a repetition (a lazy or doubled one reads otherwise on servers)` };
      js += op;
      i = next;
      repeated = true;
      continue;
    }
    if (ch === '}' || ch === ']') return { problem: `a ${ch} on its own: write \\${ch}` };
    if (ch === '(') {
      if (p[i + 1] === '?') return { problem: '(? groups are JavaScript only' };
      depth++;
      js += '(?:';
      i++;
      atom = false;
      repeated = false;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) return { problem: 'a ) without its (' };
      depth--;
      js += ')';
      i++;
      atom = true;
      repeated = false;
      continue;
    }
    if (ch === '|' || ch === '^' || ch === '$') {
      js += ch;
      i++;
      atom = false;
      repeated = false;
      continue;
    }
    if (ch === '.') {
      js += '.';
      i++;
      atom = true;
      repeated = false;
      continue;
    }
    // A literal character: its UTF-8 bytes (a repetition after it repeats the last byte, as grep in
    // the C locale reads it).
    const cp = p.codePointAt(i)!;
    const s = String.fromCodePoint(cp);
    js += utf8(s).map(hex).join('');
    i += s.length;
    atom = true;
    repeated = false;
  }
  if (depth !== 0) return { problem: 'a ( without its )' };
  return { js };
}

/** Why `pattern` can't be a signed parameter's pattern (the subset above), or undefined. */
export function signedPatternProblem(pattern: string): string | undefined {
  if (pattern === '') return 'empty';
  const r = parse(pattern);
  if (r.problem) return r.problem;
  try {
    new RegExp(`^(?:${r.js!})$`);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return undefined;
}

/** A parameter value a gate takes: one line, no CR, LF or NUL (md-runbook-gate's IsOneLine). */
export const isOneLineValue = (value: string): boolean => !/[\r\n\0]/.test(value);

/**
 * Whether `value` matches the whole of a signed `pattern` as md-runbook-gate checks it (byte for
 * byte, one line); false for a pattern outside the subset, which the gate refuses too.
 */
export function matchesSignedPattern(pattern: string, value: string): boolean {
  if (!isOneLineValue(value) || signedPatternProblem(pattern) !== undefined) return false;
  let bytes = '';
  for (const b of utf8(value)) bytes += String.fromCharCode(b);
  return new RegExp(`^(?:${parse(pattern).js!})$`).test(bytes);
}

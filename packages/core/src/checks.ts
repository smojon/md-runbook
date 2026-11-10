/**
 * Checks on a cell's result (`expect=`, `expect-not=`, `expect-exit=`) and values captured from
 * its output for later cells (`capture=NAME`, `capture=NAME:/regex/`, `capture-secret=NAME`).
 */

import { RE2JS } from 're2js';
import { stripAnsi } from './ansi';
import { VAR_NAME_RE, VarRef, findRefs, replaceRefs } from './secrets';

/** Text the output must contain, or a regular expression it must match. */
export type Matcher = { kind: 'text'; text: string } | { kind: 'regex'; re: SafeRegex };

export interface CaptureSpec {
  name: string;
  /** Without one, the whole trimmed stdout is captured. */
  pattern?: SafeRegex;
  /** Redacted everywhere and never saved. */
  secret: boolean;
}

export interface CellChecks {
  expect?: Matcher;
  expectNot?: Matcher;
  /** Exit code that counts as success instead of 0. */
  expectExit?: number;
  captures: CaptureSpec[];
}

export interface Captured {
  name: string;
  value: string;
  secret: boolean;
  /** Captured by a cell written by an assistant (`by=`): the user's own cells don't use it. */
  fromAssistant?: boolean;
}

export interface CheckOutcome {
  ok: boolean;
  /** Why it failed, one line each (empty when only the exit code was wrong). */
  failures: string[];
  /** Captured values; only when everything else passed. */
  captured: Captured[];
  /** Values of `capture-secret=` that matched, even when the run failed: they are redacted anyway. */
  secretValues: string[];
}

/** Most attempts `retry=` may ask for, and the longest wait between them. */
export const MAX_RETRY = 100;
export const MAX_EVERY_MS = 3_600_000;

/**
 * A regular expression from the runbook. It runs on RE2 (linear time): a pattern with
 * catastrophic backtracking (`/^(\w+\s?)*$/`) can't freeze the process (in VS Code, the
 * extension host), and the same engine works in the app. RE2 has no look-around and no
 * back-references; such a pattern is refused when the cell options are read.
 */
export class SafeRegex {
  private readonly re: RE2JS;

  /** Flags i, m, s; u is accepted (RE2 always matches Unicode code points). Throws on an invalid pattern. */
  constructor(
    readonly source: string,
    readonly flags: string,
  ) {
    let f = 0;
    if (flags.includes('i')) f |= RE2JS.CASE_INSENSITIVE;
    if (flags.includes('m')) f |= RE2JS.MULTILINE;
    if (flags.includes('s')) f |= RE2JS.DOTALL;
    try {
      this.re = RE2JS.compile(source, f);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`invalid regular expression /${source}/${flags}: ${why} (look-around and back-references are not supported)`);
    }
  }

  /** The first match: whole match then groups (undefined when a group didn't take part), or null. */
  exec(text: string): (string | undefined)[] | null {
    const m = this.re.matcher(text);
    if (!m.find()) return null;
    const groups: (string | undefined)[] = [];
    for (let g = 0; g <= m.groupCount(); g++) groups.push(m.group(g) ?? undefined);
    return groups;
  }

  toString(): string {
    return `/${this.source}/${this.flags}`;
  }
}

const REGEX_RE = /^\/([\s\S]*)\/([imsu]*)$/;

/**
 * `/regex/flags` (flags i, m, s, u) or plain text. Throws on an invalid regular expression, and
 * on a secret reference: `${param:NAME}`, `${input:NAME}` and `${out:NAME}` are filled in before
 * the check (resolveChecks), but a check's text is shown when it fails, so no secret goes there.
 */
export function parseMatcher(value: string): Matcher {
  const secret = findRefs(value).find((r) => r.secret);
  if (secret) {
    throw new Error(`a check can't use the secret ${secret.kind === 'secret' ? `\${secret:${secret.name}}` : `\${input:${secret.name}}`}: its text is shown when it fails`);
  }
  const m = REGEX_RE.exec(value);
  if (!m) return { kind: 'text', text: value };
  // With references, also check the pattern as it will be: each value is one literal atom.
  if (findRefs(m[1]!).length > 0) new SafeRegex(replaceRefs(m[1]!, () => '(?:x)'), m[2]!);
  return { kind: 'regex', re: new SafeRegex(m[1]!, m[2]!) };
}

/** The text of a cell's checks that may hold references (expect=, expect-not=), one per line. */
export function checkRefText(c: CellChecks | undefined): string {
  return [c?.expect, c?.expectNot]
    .filter((m): m is Matcher => m !== undefined)
    .map((m) => (m.kind === 'text' ? m.text : m.re.source))
    .join('\n');
}

/** The `${…}` references a cell's checks use. Throws as findRefs does. */
export function checkRefs(c: CellChecks | undefined): VarRef[] {
  return findRefs(checkRefText(c));
}

/**
 * The checks with their references filled in from `values` (by name): as text in plain text, as
 * a literal (quoted) part of a regular expression. Throws when a value is missing, or secret
 * (`secret(name)`: a value captured with capture-secret=), since the check's text is shown.
 */
export function resolveChecks(c: CellChecks, values: Readonly<Record<string, string>>, secret: (name: string) => boolean = () => false): CellChecks {
  const fill = (kind: string, name: string, quote: (v: string) => string): string => {
    const v = values[name];
    if (v === undefined) throw new Error(`\${${kind}:${name}} in a check has no value`);
    if (secret(name)) throw new Error(`a check can't use \${${kind}:${name}}: it is a secret value, and a check's text is shown when it fails`);
    return quote(v);
  };
  const resolve = (m: Matcher | undefined): Matcher | undefined => {
    if (m === undefined) return undefined;
    if (m.kind === 'text') return { kind: 'text', text: replaceRefs(m.text, (k, n) => fill(k, n, (v) => v)) };
    const source = replaceRefs(m.re.source, (k, n) => fill(k, n, (v) => `(?:${RE2JS.quote(v)})`));
    return source === m.re.source ? m : { kind: 'regex', re: new SafeRegex(source, m.re.flags) };
  };
  if (checkRefs(c).length === 0) return c;
  const expect = resolve(c.expect);
  const expectNot = resolve(c.expectNot);
  return { ...c, ...(expect ? { expect } : {}), ...(expectNot ? { expectNot } : {}) };
}

export function describeMatcher(m: Matcher): string {
  return m.kind === 'text' ? JSON.stringify(m.text) : String(m.re);
}

/** `NAME` or `NAME:/regex/flags`. Throws with a message for the cell options error list. */
export function parseCapture(value: string, secret: boolean): CaptureSpec {
  const colon = value.indexOf(':');
  const name = colon < 0 ? value : value.slice(0, colon);
  if (!VAR_NAME_RE.test(name)) throw new Error('expected a variable name (letters, digits, _)');
  if (colon < 0) return { name, secret };
  const m = parseMatcher(value.slice(colon + 1));
  if (m.kind !== 'regex') throw new Error('expected NAME or NAME:/regex/');
  return { name, pattern: m.re, secret };
}

export function hasChecks(c: CellChecks | undefined): c is CellChecks {
  return !!c && (c.expect !== undefined || c.expectNot !== undefined || c.expectExit !== undefined || c.captures.length > 0);
}

/** Output as matched: without colour codes, with LF line endings. */
const clean = (s: string): string => stripAnsi(s).replace(/\r\n?/g, '\n');

function matches(m: Matcher, text: string): boolean {
  return m.kind === 'text' ? text.includes(m.text) : m.re.exec(text) !== null;
}

/**
 * Judge a finished run. `output` is everything the cell printed (stdout and stderr), `stdout`
 * only its standard output (what captures read).
 */
export function evaluateChecks(c: CellChecks, exitCode: number, output: string, stdout: string): CheckOutcome {
  const failures: string[] = [];
  const expected = c.expectExit ?? 0;
  let ok = exitCode === expected;
  if (!ok && c.expectExit !== undefined) failures.push(`exit code ${exitCode}, expected ${expected}`);
  const text = clean(output);
  if (c.expect && !matches(c.expect, text)) {
    ok = false;
    failures.push(c.expect.kind === 'text' ? `the output does not contain ${describeMatcher(c.expect)}` : `the output does not match ${describeMatcher(c.expect)}`);
  }
  if (c.expectNot && matches(c.expectNot, text)) {
    ok = false;
    failures.push(c.expectNot.kind === 'text' ? `the output contains ${describeMatcher(c.expectNot)}` : `the output matches ${describeMatcher(c.expectNot)}`);
  }
  const captured: Captured[] = [];
  const secretValues: string[] = [];
  if (ok) {
    const out = clean(stdout);
    for (const cap of c.captures) {
      let value: string | undefined;
      if (cap.pattern) {
        const m = cap.pattern.exec(out);
        value = m ? (m[1] ?? m[0]) : undefined;
        if (value === undefined) failures.push(`capture ${cap.name}: nothing in the output matches ${String(cap.pattern)}`);
      } else {
        value = out.trim();
        if (value === '') {
          failures.push(`capture ${cap.name}: the cell printed nothing`);
          value = undefined;
        }
      }
      if (value !== undefined) captured.push({ name: cap.name, value, secret: cap.secret });
      if (value !== undefined && cap.secret) secretValues.push(value);
    }
    if (captured.length < c.captures.length) {
      ok = false;
      captured.length = 0;
    }
  }
  return { ok, failures, captured, secretValues };
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

/**
 * A duration → milliseconds, or undefined if invalid: `15` (seconds), `15s`, `500ms`, `2m`,
 * and units in a row from the largest down, `2m30s`, `1h5m` (every=, estimate=).
 */
export function parseInterval(value: string): number | undefined {
  const v = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/i.test(v)) return undefined;
  let total = 0;
  let last = Infinity;
  for (const [, n, u] of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)) {
    const unit = UNIT_MS[u!.toLowerCase()]!;
    // Each unit once and from the largest down: `30s2m` or `1m1m` is a typo, not a duration.
    if (unit >= last) return undefined;
    last = unit;
    total += Number(n) * unit;
  }
  return Math.round(total);
}

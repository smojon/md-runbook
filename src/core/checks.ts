/**
 * Checks on a cell's result (`expect=`, `expect-not=`, `expect-exit=`) and values captured from
 * its output for later cells (`capture=NAME`, `capture=NAME:/regex/`, `capture-secret=NAME`).
 */

import { stripAnsi } from './ansi';
import { VAR_NAME_RE } from './secrets';

/** Text the output must contain, or a regular expression it must match. */
export type Matcher = { kind: 'text'; text: string } | { kind: 'regex'; re: RegExp };

export interface CaptureSpec {
  name: string;
  /** Without one, the whole trimmed stdout is captured. */
  pattern?: RegExp;
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
}

export interface CheckOutcome {
  ok: boolean;
  /** Why it failed, one line each (empty when only the exit code was wrong). */
  failures: string[];
  /** Captured values; only when everything else passed. */
  captured: Captured[];
}

const REGEX_RE = /^\/([\s\S]*)\/([imsu]*)$/;

/** `/regex/flags` (flags i, m, s, u) or plain text. Throws on an invalid regular expression. */
export function parseMatcher(value: string): Matcher {
  const m = REGEX_RE.exec(value);
  if (!m) return { kind: 'text', text: value };
  return { kind: 'regex', re: new RegExp(m[1]!, m[2]) };
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
  return m.kind === 'text' ? text.includes(m.text) : new RegExp(m.re.source, m.re.flags.replace('g', '')).test(text);
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
  if (ok) {
    const out = clean(stdout);
    for (const cap of c.captures) {
      let value: string | undefined;
      if (cap.pattern) {
        const m = new RegExp(cap.pattern.source, cap.pattern.flags.replace('g', '')).exec(out);
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
    }
    if (captured.length < c.captures.length) {
      ok = false;
      captured.length = 0;
    }
  }
  return { ok, failures, captured };
}

/** `15`, `15s`, `500ms`, `2m` → milliseconds, or undefined if invalid. */
export function parseInterval(value: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  return Math.round(unit === 'ms' ? n : unit === 'm' ? n * 60_000 : n * 1000);
}

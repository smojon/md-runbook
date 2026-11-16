/**
 * The safety settings as the runs use them, as the extension's (src/safety.ts, src/config.ts): the
 * risky-command patterns compiled once per change (core/confirm.ts), the output redactor with the
 * built-in patterns and the user's own (core/redact.ts), and a cell's timeout when it has none.
 *
 * The built-in patterns are JavaScript regular expressions, as in VS Code (the risky ones use
 * look-behind). A pattern you add runs over every output, the live window included, so it
 * compiles with RE2 first (re2js: linear time, no catastrophic backtracking). Only a pattern RE2
 * can't read (look-around, back-references) falls back to a JavaScript one, and then only when it
 * is at most MAX_JS_PATTERN characters and has no nested quantifier (`(a+)+`, `(\w*)*`): those are
 * the ones that can take exponential time. A pattern that is refused is refused when it is added,
 * and left out (as one that doesn't compile) if it was saved before.
 */
import { DEFAULT_PATTERNS, REDACTED, Redactor, createRedactor } from '@md-runbook/core';
import { DEFAULT_CONFIRM_PATTERNS, compileConfirmPatterns } from '@md-runbook/core/confirm';
import { RE2JS } from 're2js';
import { confirmPatterns, redactionPatterns, timeoutSeconds } from './store';

export type PatternKind = 'confirm' | 'redaction';

/** A cell proposed by an assistant runs at most this long without a timeout of its own (mdRunbook.approval.aiTimeoutSeconds). */
export const ASSISTANT_TIMEOUT_SECONDS = 120;

/** The longest pattern of yours that may run as a JavaScript regular expression (RE2 ones have no limit). */
export const MAX_JS_PATTERN = 200;

/**
 * A quantified group that has a quantifier inside: `(a+)+`, `(?:\w+\s?)*`, `(x*){2,}`. The shape
 * of catastrophic backtracking in a backtracking engine.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;

/** A pattern of yours, compiled: by RE2, or (look-around) as a JavaScript regular expression within the limits. */
export type UserPattern = { kind: 're2'; re: RE2JS } | { kind: 'js'; re: RegExp };

/** `pattern` compiled for `kind` (confirm: case-insensitive), or why it can't be used. */
export function compileUserPattern(kind: PatternKind, pattern: string): UserPattern | { why: string } {
  try {
    return { kind: 're2', re: RE2JS.compile(pattern, kind === 'confirm' ? RE2JS.CASE_INSENSITIVE : 0) };
  } catch {
    // Not RE2 (look-around, back-references, or not a regular expression): JavaScript, within limits.
  }
  if (pattern.length > MAX_JS_PATTERN) return { why: `longer than ${MAX_JS_PATTERN} characters, and RE2 can’t read it` };
  if (NESTED_QUANTIFIER.test(pattern)) return { why: 'a quantifier inside a quantified group, and RE2 can’t read it' };
  try {
    return { kind: 'js', re: new RegExp(pattern, kind === 'confirm' ? 'i' : 'g') };
  } catch (e) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
}

/** Why `pattern` can't be added to the list (empty, already there, not a regular expression, or unsafe), else undefined. */
export function patternProblem(
  kind: PatternKind,
  pattern: string,
  list: readonly string[],
): { kind: 'empty' } | { kind: 'duplicate' } | { kind: 'invalid'; why: string } | undefined {
  if (pattern.trim() === '') return { kind: 'empty' };
  if (list.includes(pattern)) return { kind: 'duplicate' };
  // A built-in risky pattern put back: as the extension's own.
  if (kind === 'confirm' && DEFAULT_CONFIRM_PATTERNS.includes(pattern)) return undefined;
  const c = compileUserPattern(kind, pattern);
  return 'why' in c ? { kind: 'invalid', why: c.why } : undefined;
}

/** An RE2 pattern as the confirm check reads one (core findRisky: `exec`, its `index` and `[0]`). */
function re2AsRegExp(re: RE2JS, source: string): RegExp {
  const like = {
    source,
    flags: 'i',
    lastIndex: 0,
    exec(text: string): RegExpExecArray | null {
      const m = re.matcher(text);
      if (!m.find()) return null;
      const out = [m.group(0) ?? ''] as unknown as RegExpExecArray;
      out.index = m.start();
      out.input = text;
      return out;
    },
    test(text: string): boolean {
      return like.exec(text) !== null;
    },
  };
  return like as unknown as RegExp;
}

let confirmCache: { from: readonly string[]; regexes: RegExp[] } | undefined;

/** The risky-command patterns, compiled (one that doesn't compile, or is refused, is left out, as VS Code does). */
export function confirmRegexes(): RegExp[] {
  const from = confirmPatterns();
  if (confirmCache?.from !== from) {
    const builtIn = from.filter((p) => DEFAULT_CONFIRM_PATTERNS.includes(p));
    const regexes = compileConfirmPatterns(builtIn).regexes;
    for (const p of from) {
      if (builtIn.includes(p)) continue;
      const c = compileUserPattern('confirm', p);
      if ('why' in c) continue;
      regexes.push(c.kind === 're2' ? re2AsRegExp(c.re, p) : c.re);
    }
    confirmCache = { from, regexes };
  }
  return confirmCache.regexes;
}

/** Every match of `re` in `text` replaced by REDACTED (empty matches left alone, as core's redactor does). */
function redactRe2(re: RE2JS, text: string): string {
  const m = re.matcher(text);
  let out = '';
  let at = 0;
  while (m.find()) {
    const start = m.start();
    const end = m.end();
    if (end === start) continue;
    out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return at === 0 ? text : out + text.slice(at);
}

let redactorCache: { from: readonly string[]; redactor: Redactor } | undefined;

/** The built-in redaction patterns and the user's own, for live output, the file and reports. */
export function outputRedactor(): Redactor {
  const from = redactionPatterns();
  if (redactorCache?.from !== from) {
    const compiled = from.map((p) => ({ p, c: compileUserPattern('redaction', p) }));
    const re2 = compiled.flatMap(({ c }) => ('re' in c && c.kind === 're2' ? [c.re] : []));
    const js = compiled.flatMap(({ p, c }) => ('re' in c && c.kind === 'js' ? [p] : []));
    const base = createRedactor([...DEFAULT_PATTERNS, ...js]);
    const refused = compiled.flatMap(({ p, c }) => ('why' in c ? [`${p}: ${c.why}`] : []));
    redactorCache = {
      from,
      redactor: {
        errors: [...base.errors, ...refused],
        redact: (text) => re2.reduce((s, re) => redactRe2(re, s), base.redact(text)),
      },
    };
  }
  return redactorCache.redactor;
}

/**
 * The live output on screen once `text` arrived after `shown` (itself redacted): redacted first,
 * then cut to its last `max` characters, at a line's start when one is near. Cutting first could
 * leave the end of a token whose start was cut off, which no pattern then matches.
 */
export function liveWindow(shown: string, text: string, max: number): string {
  const all = outputRedactor().redact(shown + text);
  if (all.length <= max) return all;
  const tail = all.slice(-max);
  const nl = tail.indexOf('\n');
  return nl >= 0 && nl < 200 ? tail.slice(nl + 1) : tail;
}

/**
 * How long a cell may run, in seconds (0: no limit): its `timeout=`, else the setting. An
 * assistant's cell without either (or with timeout=0) gets ASSISTANT_TIMEOUT_SECONDS, as in VS Code.
 */
export function cellTimeoutSeconds(own: number | undefined, byAssistant: boolean): number {
  if (own !== undefined && own > 0) return own;
  const set = own ?? timeoutSeconds();
  return set === 0 && byAssistant ? ASSISTANT_TIMEOUT_SECONDS : set;
}

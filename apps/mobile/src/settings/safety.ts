/**
 * The safety settings as the runs use them, as the extension's (src/safety.ts, src/config.ts): the
 * risky-command patterns compiled once per change (core/confirm.ts), the output redactor with the
 * built-in patterns and the user's own (core/redact.ts), and a cell's timeout when it has none.
 * Patterns are JavaScript regular expressions, as in VS Code: the built-in risky ones use
 * look-behind, which RE2 lacks. A pattern that doesn't compile is refused when it is added.
 */
import { DEFAULT_PATTERNS, Redactor, createRedactor } from '@md-runbook/core';
import { compileConfirmPatterns } from '@md-runbook/core/confirm';
import { confirmPatterns, redactionPatterns, timeoutSeconds } from './store';

export type PatternKind = 'confirm' | 'redaction';

/** A cell proposed by an assistant runs at most this long without a timeout of its own (mdRunbook.approval.aiTimeoutSeconds). */
export const ASSISTANT_TIMEOUT_SECONDS = 120;

/** Why `pattern` can't be added to the list (empty, already there, or not a regular expression), else undefined. */
export function patternProblem(
  kind: PatternKind,
  pattern: string,
  list: readonly string[],
): { kind: 'empty' } | { kind: 'duplicate' } | { kind: 'invalid'; why: string } | undefined {
  if (pattern.trim() === '') return { kind: 'empty' };
  if (list.includes(pattern)) return { kind: 'duplicate' };
  try {
    // As each list compiles its patterns: confirm ones case-insensitive, redaction ones global.
    new RegExp(pattern, kind === 'confirm' ? 'i' : 'g');
  } catch (e) {
    return { kind: 'invalid', why: e instanceof Error ? e.message : String(e) };
  }
  return undefined;
}

let confirmCache: { from: readonly string[]; regexes: RegExp[] } | undefined;

/** The risky-command patterns, compiled (one that doesn't compile is left out, as VS Code does). */
export function confirmRegexes(): RegExp[] {
  const from = confirmPatterns();
  if (confirmCache?.from !== from) confirmCache = { from, regexes: compileConfirmPatterns(from).regexes };
  return confirmCache.regexes;
}

let redactorCache: { from: readonly string[]; redactor: Redactor } | undefined;

/** The built-in redaction patterns and the user's own, for live output, the file and reports. */
export function outputRedactor(): Redactor {
  const from = redactionPatterns();
  if (redactorCache?.from !== from) redactorCache = { from, redactor: createRedactor([...DEFAULT_PATTERNS, ...from]) };
  return redactorCache.redactor;
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

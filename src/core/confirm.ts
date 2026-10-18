/** Which cells need a confirmation before they run. */

export type ConfirmMode = 'patterns' | 'always' | 'never';

export const DEFAULT_CONFIRM_PATTERNS = [
  '\\b(delete|drain|cordon|scale\\s+.*--replicas=0)\\b',
  '\\brm\\s+-[a-z]*r[a-z]*f',
  '--force\\b',
  '\\bRemove-Item\\b.*-Recurse',
  '\\bdrop\\s+(table|database)\\b',
];

/** Patterns are case-insensitive JavaScript regular expressions. */
export function compileConfirmPatterns(patterns: readonly string[]): { regexes: RegExp[]; errors: string[] } {
  const regexes: RegExp[] = [];
  const errors: string[] = [];
  for (const p of patterns) {
    try {
      regexes.push(new RegExp(p, 'i'));
    } catch (e) {
      errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { regexes, errors };
}

/** The earliest risky match in the source, as written. */
export function findRisky(source: string, regexes: readonly RegExp[]): string | undefined {
  let best: RegExpExecArray | undefined;
  for (const re of regexes) {
    const m = re.exec(source);
    if (m && (!best || m.index < best.index)) best = m;
  }
  return best?.[0];
}

/**
 * undefined if the cell may run without asking; otherwise the text to name in the prompt
 * (the risky match, or '' when confirmation is unconditional).
 * `cellConfirm` is the cell's own `confirm` / `no-confirm` option and wins over `mode`.
 */
export function confirmationFor(source: string, mode: ConfirmMode, regexes: readonly RegExp[], cellConfirm?: boolean): string | undefined {
  if (cellConfirm === false || (cellConfirm === undefined && mode === 'never')) return undefined;
  const match = findRisky(source, regexes);
  if (match !== undefined) return match;
  return cellConfirm === true || mode === 'always' ? '' : undefined;
}

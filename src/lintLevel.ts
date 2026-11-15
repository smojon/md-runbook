/**
 * How a lint problem shows in VS Code (lint.ts), without vscode so it can be tested: errors and
 * warnings as they are; prose findings (info) as the `mdRunbook.lint.prose` setting says.
 */
import type { LintProblem } from '@md-runbook/core/lint';

/** `mdRunbook.lint.prose`: information (in the Problems panel), hint (faint dots only) or off. */
export type ProseSetting = 'information' | 'hint' | 'off';
export type MarkerLevel = 'error' | 'warning' | 'information' | 'hint';

export const proseSetting = (value: unknown): ProseSetting => (value === 'hint' || value === 'off' ? value : 'information');

/**
 * The marker level of a problem, undefined when it isn't shown. `off` hides every prose finding,
 * also those a runbook's `prose: strict` made warnings (the command line still reports them).
 */
export function markerLevel(p: Pick<LintProblem, 'severity' | 'code'>, prose: ProseSetting): MarkerLevel | undefined {
  if (prose === 'off' && p.code?.startsWith('prose-')) return undefined;
  if (p.severity === 'error' || p.severity === 'warning') return p.severity;
  return prose === 'hint' ? 'hint' : 'information';
}

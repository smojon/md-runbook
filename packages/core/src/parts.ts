/**
 * Setup and teardown: the parts of a runbook that bring something up before its own steps and
 * take it down after them, and the check whether it is up already.
 *
 *   ```bash ready name="Lab answers"        the ready check: exit 0 = up (never fails a run)
 *   ```runbook src=../lab/ka4.md section="Start the lab" setup
 *   …the runbook's own steps (its body)…
 *   ```runbook src=../lab/ka4.md section="Stop the lab" teardown
 *
 * Setup steps (`setup`) are skipped when the ready check of the runbook their commands are in
 * passes: a plain block's own runbook, a call's runbook called. Teardown steps (`teardown`) are
 * offered at the end, never run unasked: the reader may go straight on to the next runbook.
 * This module is the platform-neutral part: which part each block is in, and lint.
 */

import { parseCellOptions } from './cellOptions';
import { isCallLanguage } from './call';
import { CodeCellLocation } from './locate';
import { shellKindForLanguage } from './shellKind';

export type RunbookPart = 'ready' | 'setup' | 'body' | 'teardown';

/** A block's part from its fence info string: `body` unless it says setup, teardown or ready. */
export function partOf(info: string): RunbookPart {
  return parseCellOptions(info).part ?? 'body';
}

/** A step of the runbook: a shell block or a runbook call (other code blocks never run). */
function isStep(loc: CodeCellLocation): boolean {
  return isCallLanguage(loc.language) || shellKindForLanguage(loc.language) !== undefined;
}

export interface RunbookParts {
  /** Per located cell (the same order as `locs`): its part; undefined for a block that isn't a step. */
  parts: (RunbookPart | undefined)[];
  /** Index into `locs` of the ready check (the first one). */
  ready?: number;
  /** The runbook has setup or teardown steps, or a ready check. */
  any: boolean;
}

export function runbookParts(locs: readonly CodeCellLocation[]): RunbookParts {
  const parts = locs.map((l) => (isStep(l) ? partOf(l.info) : undefined));
  const ready = parts.indexOf('ready');
  return { parts, ...(ready >= 0 ? { ready } : {}), any: parts.some((p) => p !== undefined && p !== 'body') };
}

export interface PartProblem {
  /** Index into `locs`. */
  at: number;
  message: string;
}

/**
 * The order of the parts: one ready check, before the setup steps it guards; setup steps before
 * the runbook's own steps, teardown steps after them. A ready check is a shell block.
 */
export function partProblems(locs: readonly CodeCellLocation[]): PartProblem[] {
  const problems: PartProblem[] = [];
  const { parts } = runbookParts(locs);
  const line = (i: number): number => locs[i]!.line + 1;
  let firstReady: number | undefined;
  let firstBody: number | undefined;
  let firstTeardown: number | undefined;
  let firstSetup: number | undefined;
  parts.forEach((p, i) => {
    if (p === undefined) return;
    if (p === 'ready') {
      if (isCallLanguage(locs[i]!.language)) problems.push({ at: i, message: 'ready: the ready check is a shell block (exit 0 = up), not a runbook call' });
      else if (firstReady !== undefined) problems.push({ at: i, message: `ready: a runbook has one ready check (the first one is on line ${line(firstReady)})` });
      else if (firstSetup !== undefined) problems.push({ at: i, message: `ready: the ready check comes before the setup steps it guards (a setup step is on line ${line(firstSetup)})` });
      firstReady ??= i;
      return;
    }
    if (p === 'setup') {
      firstSetup ??= i;
      const after = firstBody ?? firstTeardown;
      if (after !== undefined) problems.push({ at: i, message: `setup: setup steps come before the runbook's own steps (one is on line ${line(after)})` });
      return;
    }
    if (p === 'body') {
      firstBody ??= i;
      if (firstTeardown !== undefined) problems.push({ at: i, message: `a step after the teardown (line ${line(firstTeardown)}): teardown steps come last; mark this one teardown, or move it up` });
      return;
    }
    firstTeardown ??= i;
  });
  return problems;
}

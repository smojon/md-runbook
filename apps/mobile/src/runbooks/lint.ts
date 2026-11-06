/**
 * The checks of `md-runbook lint` and the extension's problem markers, for the app: problems by
 * code cell, the rest (front matter, signature) for the runbook, and the "did you mean" fix of a
 * misspelled cell option, as the extension's Quick Fix makes it.
 */
import { DEFAULT_WRITE_OPTIONS, isCodeMeta, parse, serialize, toCellInputs } from '@md-runbook/core';
import { renameInfoOption } from '@md-runbook/core/cellOptions';
import { LintProblem, lintRunbook, suggestOption } from '@md-runbook/core/lint';
import { withInfo } from '@md-runbook/core/proposal';

export type { LintProblem };

export interface RunbookProblems {
  /** Every problem, in file order. */
  all: readonly LintProblem[];
  /** Problems in a code block, by its cell index. */
  byCell: ReadonlyMap<number, readonly LintProblem[]>;
  /** Problems outside the code blocks: the front matter, the signature. */
  runbook: readonly LintProblem[];
}

export function runbookProblems(text: string): RunbookProblems {
  const all = lintRunbook(text);
  const byCell = new Map<number, LintProblem[]>();
  const runbook: LintProblem[] = [];
  for (const p of all) {
    if (p.cell === undefined) runbook.push(p);
    else byCell.set(p.cell.index, [...(byCell.get(p.cell.index) ?? []), p]);
  }
  return { all, byCell, runbook };
}

/**
 * The runbook with option `from` of cell `index` renamed to `to`, keeping its value. Only a typo's
 * fix: `to` must be lint's suggestion for `from` (so it can't turn off an option such as confirm).
 * Undefined when that doesn't hold or the cell has no such option.
 */
export function fixCellOption(text: string, index: number, from: string, to: string): string | undefined {
  if (to === from.toLowerCase() || suggestOption(from) !== to) return undefined;
  const doc = parse(text);
  const cell = doc.cells[index];
  if (!cell || cell.kind !== 'code' || !isCodeMeta(cell.meta)) return undefined;
  const info = renameInfoOption(cell.meta.info, from, to);
  if (info === undefined) return undefined;
  const cells = toCellInputs(doc);
  cells[index] = { ...cells[index]!, meta: withInfo(cell.meta, info) };
  return serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
}

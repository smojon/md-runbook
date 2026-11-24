/**
 * The checks of `md-runbook lint` and the extension's problem markers, for the app: problems by
 * code cell, the rest (front matter, signature) for the runbook, and the "did you mean" fix of a
 * misspelled cell option, as the extension's Quick Fix makes it (and the comment an empty runbook
 * call gets). Prose notes (info: a long sentence, a padding word) are kept apart: a subtle mark
 * under their Markdown cell, not counted as problems.
 */
import { DEFAULT_WRITE_OPTIONS, isCodeMeta, parse, serialize, toCellInputs } from '@md-runbook/core';
import { callBodyComment, isCallLanguage, isEmptyCallBody } from '@md-runbook/core/call';
import { renameInfoOption } from '@md-runbook/core/cellOptions';
import { LintOptions, LintProblem, lintRunbook, suggestOption } from '@md-runbook/core/lint';
import { withInfo } from '@md-runbook/core/proposal';

export type { LintProblem };

export interface RunbookProblems {
  /** Every problem, in file order. */
  all: readonly LintProblem[];
  /** Problems in a code block, by its cell index. */
  byCell: ReadonlyMap<number, readonly LintProblem[]>;
  /** Problems outside the code blocks: the front matter, the signature. */
  runbook: readonly LintProblem[];
  /** Prose notes (severity info), by their Markdown cell's index. Not in `all`. */
  notes: ReadonlyMap<number, readonly LintProblem[]>;
  /** Other info (a runbook call with an empty body), by its code cell's index: shown under it, not counted. */
  hints: ReadonlyMap<number, readonly LintProblem[]>;
  /** What a code cell shows under it: its problems, then its hints. */
  underCell: ReadonlyMap<number, readonly LintProblem[]>;
}

export function runbookProblems(text: string, options: LintOptions = {}): RunbookProblems {
  const found = lintRunbook(text, options);
  const all = found.filter((p) => p.severity !== 'info');
  const byCell = new Map<number, LintProblem[]>();
  const runbook: LintProblem[] = [];
  const notes = new Map<number, LintProblem[]>();
  const hints = new Map<number, LintProblem[]>();
  for (const p of all) {
    if (p.cell === undefined) runbook.push(p);
    else byCell.set(p.cell.index, [...(byCell.get(p.cell.index) ?? []), p]);
  }
  for (const p of found) {
    if (p.severity !== 'info' || !p.cell) continue;
    const into = p.code?.startsWith('prose-') ? notes : hints;
    into.set(p.cell.index, [...(into.get(p.cell.index) ?? []), p]);
  }
  const underCell = new Map<number, LintProblem[]>(byCell);
  for (const [i, ps] of hints) underCell.set(i, [...(underCell.get(i) ?? []), ...ps]);
  return { all, byCell, runbook, notes, hints, underCell };
}

/**
 * The runbook with a comment naming what call `index` runs as its body (`# Runs the runbook …`),
 * as the extension's Quick Fix adds it. Undefined unless that cell is a call with an empty body.
 */
export function addCallComment(text: string, index: number): string | undefined {
  const doc = parse(text);
  const cell = doc.cells[index];
  if (!cell || cell.kind !== 'code' || !isCodeMeta(cell.meta) || !isCallLanguage(cell.languageId) || !isEmptyCallBody(cell.value))
    return undefined;
  const comment = callBodyComment(cell.meta.info);
  if (comment === undefined) return undefined;
  const cells = toCellInputs(doc);
  cells[index] = { ...cells[index]!, value: comment };
  return serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
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

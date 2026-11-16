/**
 * Marks a reader puts on a step for this session, as VS Code's (stepMarks.ts), from the cell's ⋯
 * or a step's row in Steps: **Pause Before This Step** (Run All stops there and asks Continue /
 * Stop) and **Notify Me When It Starts** (once: the mark goes when the step starts). They live
 * while the runbook is open, per cell; the file never changes.
 *
 * They are kept by cell index, so each text change moves them with their cells (remapByCell): a
 * proposal, a note or an edit that adds cells above never leaves a pause on another step.
 */
import { isCodeMeta, type ParsedCell } from '@md-runbook/core';

export interface StepMarks {
  pause?: boolean;
  notify?: boolean;
}

export type MarksByCell = ReadonlyMap<number, StepMarks>;

export const NO_MARKS: MarksByCell = new Map();

/** `marks` with `which` turned on or off for cell `index` (a cell without marks is dropped). */
export function toggleMark(marks: MarksByCell, index: number, which: keyof StepMarks, on?: boolean): MarksByCell {
  const now = { ...(marks.get(index) ?? {}) };
  const value = on ?? !now[which];
  if (value) now[which] = true;
  else delete now[which];
  const next = new Map(marks);
  if (!now.pause && !now.notify) next.delete(index);
  else next.set(index, now);
  return next;
}

/**
 * Each cell's identity across edits: its kind, fence options and code (Markdown: its text), and
 * which of the cells alike it is. Outputs are no part of it: running a cell keeps it. Nor are a
 * Markdown cell's ticks (`- [x]`): ticking a step done by hand keeps it.
 */
export function cellIdentities(cells: readonly Pick<ParsedCell, 'kind' | 'value' | 'meta'>[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((c) => {
    const value = c.kind === 'code' ? c.value : c.value.replace(/^(\s*(?:>\s*)*[-*+]\s+)\[[ xX]\]/gm, '$1[ ]');
    const base = `${c.kind}\u0000${c.kind === 'code' && isCodeMeta(c.meta) ? c.meta.info.trim() : ''}\u0000${value}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}\u0000${n}`;
  });
}

/** Where cell `i` of `before` is in `after` (cellIdentities), or undefined when it changed or went. */
export function cellMover(before: readonly string[], after: readonly string[]): (i: number) => number | undefined {
  const at = new Map(after.map((id, i) => [id, i]));
  return (i) => (before[i] === undefined ? undefined : at.get(before[i]!));
}

/**
 * `byCell` (keyed by cell index in `before`) keyed by where the same cells are in `after`. An
 * entry whose cell changed or went is dropped, and counted.
 */
export function remapByCell<T>(
  byCell: ReadonlyMap<number, T>,
  before: readonly string[],
  after: readonly string[],
): { map: ReadonlyMap<number, T>; dropped: number } {
  const move = cellMover(before, after);
  const map = new Map<number, T>();
  let dropped = 0;
  for (const [i, v] of byCell) {
    const j = move(i);
    if (j === undefined) dropped++;
    else map.set(j, v);
  }
  return { map, dropped };
}

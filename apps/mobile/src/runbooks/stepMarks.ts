/**
 * Marks a reader puts on a step for this session, as VS Code's (stepMarks.ts), from the cell's ⋯
 * or a step's row in Steps: **Pause Before This Step** (Run All stops there and asks Continue /
 * Stop) and **Notify Me When It Starts** (once: the mark goes when the step starts). They live
 * while the runbook is open, per cell; the file never changes.
 */

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

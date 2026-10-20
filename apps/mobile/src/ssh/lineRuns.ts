/**
 * Which commands of a cell a line action runs, with the extension's rules (src/lineRuns.ts):
 * Run line (the command on that line), Run lines 1-N (every command up to and including it),
 * Run lines N-end (it and the ones after it), Run checked lines (the ticked commands, in order).
 * A command spans several lines when it continues (`\`, open quotes, `if … fi`, here-docs).
 */
import { LineStep, formatLineRange, splitSteps, stepAtLine } from '@md-runbook/core/steps';

export interface LinePlan {
  steps: readonly LineStep[];
  /** Every command of the cell: a full run, written without `lines=`. */
  coversCell: boolean;
}

export type LineMode = 'at' | 'to' | 'from' | 'checked';

/** The commands of a bash cell (blank and comment lines are not commands). */
export function cellSteps(source: string): LineStep[] {
  return splitSteps(source, 'bash');
}

/** `checked` holds the texts of the ticked commands (a check follows its command's text). */
export function planLines(source: string, mode: LineMode, line: number, checked: ReadonlySet<string> = new Set()): LinePlan | undefined {
  const all = cellSteps(source);
  if (all.length === 0) return undefined;
  if (mode === 'at') {
    const step = stepAtLine(all, line);
    return step && { steps: [step], coversCell: all.length === 1 };
  }
  if (mode === 'to') {
    const to = all.findIndex((s) => s.end >= line);
    const end = to < 0 ? all.length - 1 : all[to]!.start <= line ? to : to - 1;
    if (end < 0) return undefined;
    return { steps: all.slice(0, end + 1), coversCell: end === all.length - 1 };
  }
  if (mode === 'from') {
    const from = all.findIndex((s) => s.end >= line);
    if (from < 0) return undefined;
    return { steps: all.slice(from), coversCell: from === 0 };
  }
  const steps = all.filter((s) => checked.has(s.text));
  return steps.length === 0 ? undefined : { steps, coversCell: steps.length === all.length };
}

/** "3" or "3-5": the 1-based lines of a command, as menus show them. */
export function lineLabel(step: { start: number; end: number }): string {
  return formatLineRange(step.start, step.end);
}

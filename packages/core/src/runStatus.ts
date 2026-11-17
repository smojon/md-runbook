/**
 * The words of a run's progress, the same in every client: the CLI's pinned line, VS Code's
 * running cell and status bar, the app's run bar and running cell. Each client draws its own bar
 * (text in a terminal, a graphical one in VS Code and the app); the strings come from here.
 */

import { blockProgress, formatEstimate, remaining } from './estimate';

/** `Step 3/7`. */
export function stepOfTotal(step: number, total: number): string {
  return `Step ${step}/${total}`;
}

/** `Step 4/7 failed`. */
export function stepFailed(step: number, total: number): string {
  return `${stepOfTotal(step, total)} failed`;
}

/** For a screen reader: `Step 3 of 7` instead of `Step 3/7`. */
export function spokenSteps(text: string): string {
  return text.replace(/(\d+)\/(\d+)/g, '$1 of $2');
}

export interface CellRunInput {
  /** Since the cell started (all its attempts). */
  elapsedSeconds: number;
  /** Its estimate= or learned time; undefined: none (no bar, only the time so far). */
  estimateSeconds?: number;
  /** retry=: the attempt running and how many it may take. */
  attempt?: number;
  attempts?: number;
}

export interface CellRunStatus {
  /** `running · 12s of about 30s`, `running · 45s · 15s over about 30s`, or `running · 12s`. */
  text: string;
  /** `attempt 2/5`, for a block with retry=. */
  attempt?: string;
  /** Both in one line: `running · 12s of about 30s · attempt 2/5`. */
  line: string;
  /** How full the bar is, 0 to 1 (full at the estimate); undefined without an estimate. */
  fraction?: number;
  /** Past the estimate (the bar in the warning colour). */
  over: boolean;
}

/** A running cell's status line, under its output while it runs. */
export function cellRunStatus(p: CellRunInput): CellRunStatus {
  // Whole seconds: `0.4s` then `1.2s` would flicker on a line redrawn every second.
  const elapsed = Math.floor(Math.max(0, Number.isFinite(p.elapsedSeconds) ? p.elapsedSeconds : 0));
  const attempt = p.attempts !== undefined && p.attempts > 1 && p.attempt !== undefined ? `attempt ${p.attempt}/${p.attempts}` : undefined;
  const est = p.estimateSeconds;
  let text = `running · ${formatEstimate(elapsed)}`;
  let fraction: number | undefined;
  let over = false;
  if (est !== undefined && est > 0) {
    const b = blockProgress(p.elapsedSeconds, est);
    fraction = b.fraction;
    over = b.overSeconds >= 1;
    text = over
      ? `running · ${formatEstimate(elapsed)} · ${formatEstimate(Math.floor(b.overSeconds))} over about ${formatEstimate(est)}`
      : `running · ${formatEstimate(elapsed)} of about ${formatEstimate(est)}`;
  }
  return { text, ...(attempt ? { attempt } : {}), line: attempt ? `${text} · ${attempt}` : text, ...(fraction !== undefined ? { fraction } : {}), over };
}

export interface RunLineInput {
  /** The step running: `Step 3/7`. */
  step?: number;
  /** Instead of `Step N/M` (the ready check, a teardown step, `Cell 4`). */
  where?: string;
  total: number;
  /** The step's name (`Push image`). */
  label?: string;
  /** By the blocks' estimates (core runbookEstimate); without a fraction, no estimate. */
  estimate?: { fraction?: number; leftSeconds: number; unestimatedLeft?: number };
  /** Steps still to do, the running one included (never `100%` while one is open). */
  open: number;
  /** Show the share done by the estimates (`54%`). */
  percent?: boolean;
  /** The share of the steps done (0 to 1), for the bar when no estimate can say how far the run is. */
  stepsDone?: number;
}

export interface RunLine {
  /** `Step 3/7 · Push image · 54% · 1 min left`. */
  text: string;
  /** How full the run's bar is, 0 to 1: by the estimates, else by the steps done. */
  fraction: number;
}

/**
 * Where a run is, in one line: `Step 3/7 · 54% · 1 min left`. The share only when every step
 * still to do has an estimate; the time left as `at least 4 min left` while some have none.
 */
export function runProgressLine(p: RunLineInput): RunLine {
  const e = p.estimate;
  const parts: string[] = [];
  const where = p.where ?? (p.step !== undefined ? stepOfTotal(p.step, p.total) : undefined);
  if (where) parts.push(where);
  if (p.label) parts.push(p.label);
  const estimated = e?.fraction !== undefined;
  if (e && estimated) {
    const r = remaining(e, p.open);
    if (p.percent && !((e.unestimatedLeft ?? 0) > 0) && r.percent !== undefined) parts.push(`${r.percent}%`);
    if (e.leftSeconds > 0) parts.push(r.left);
  }
  const fraction = estimated ? Math.min(p.open > 0 ? 0.99 : 1, e!.fraction!) : (p.stepsDone ?? 0);
  return { text: parts.join(' · '), fraction: Math.min(1, Math.max(0, fraction)) };
}

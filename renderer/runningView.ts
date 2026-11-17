/**
 * What a running cell's status says at a given moment (renderer/runningStatus.ts draws it). The
 * extension sends when the cell started once; the renderer counts the seconds itself. So the
 * notebook doesn't change every second (it would be dirty, and auto save would save each time).
 * The words are core cellRunStatus's, the same in every client. Without the DOM, so it is
 * unit-tested.
 */

import { cellRunStatus } from '@md-runbook/core/runStatus';

/** What the extension sends (src/pinnedStatus.ts RunningData): once, and again when it changes. */
export interface RunningData {
  /** When the cell started: epoch ms, by the extension host's clock. */
  startedAt: number;
  /** The block's estimate in ms; without one, a counter and no bar. */
  estimateMs?: number;
  /** retry=: the attempt running, and how many it may take. */
  attempt?: number;
  attempts?: number;
}

/** What the renderer draws. */
export interface RunningView {
  /** `running · 12s of about 30s · attempt 2/5`. */
  line: string;
  /** How full the bar is, 0 to 1; undefined without an estimate (no bar). */
  fraction?: number;
  /** Past the estimate: the warning colour. */
  over: boolean;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isRunningData(v: unknown): v is RunningData {
  const d = v as Partial<RunningData> | null;
  return (
    typeof d === 'object' &&
    d !== null &&
    num(d.startedAt) &&
    (d.estimateMs === undefined || num(d.estimateMs)) &&
    (d.attempt === undefined || num(d.attempt)) &&
    (d.attempts === undefined || num(d.attempts))
  );
}

/** Milliseconds since the start, never below 0 (a remote extension host's clock may be ahead). */
function elapsedMs(d: RunningData, now: number): number {
  return Math.max(0, now - d.startedAt);
}

/** The status at `now` (epoch ms). */
export function runningView(d: RunningData, now: number): RunningView {
  const s = cellRunStatus({
    elapsedSeconds: elapsedMs(d, now) / 1000,
    ...(d.estimateMs !== undefined ? { estimateSeconds: d.estimateMs / 1000 } : {}),
    ...(d.attempt !== undefined ? { attempt: d.attempt } : {}),
    ...(d.attempts !== undefined ? { attempts: d.attempts } : {}),
  });
  return { line: s.line, ...(s.fraction !== undefined ? { fraction: s.fraction } : {}), over: s.over };
}

/** Milliseconds until the words change: the next whole second since the start. */
export function msToNextSecond(d: RunningData, now: number): number {
  return 1000 - (elapsedMs(d, now) % 1000);
}

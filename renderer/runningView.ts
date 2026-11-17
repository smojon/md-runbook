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
  /**
   * When the extension sent this data, by the same clock. A remote host's clock (Remote-SSH, WSL)
   * may be off the window's: the renderer counts from here by its own clock (elapsedMs).
   */
  sentAt: number;
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
    num(d.sentAt) &&
    (d.estimateMs === undefined || num(d.estimateMs)) &&
    (d.attempt === undefined || num(d.attempt)) &&
    (d.attempts === undefined || num(d.attempts))
  );
}

/**
 * Milliseconds since the start, never below 0. Each clock is only compared with itself: the time
 * to the send by the extension host's, then the time since `receivedAt` (the renderer first drew
 * this data) by the window's. A remote host's clock ahead or behind changes nothing.
 */
export function elapsedMs(d: RunningData, now: number, receivedAt: number): number {
  return Math.max(0, d.sentAt - d.startedAt + (now - receivedAt));
}

/** The status at `now` (epoch ms, the window's clock), for data first drawn at `receivedAt`. */
export function runningView(d: RunningData, now: number, receivedAt: number): RunningView {
  const s = cellRunStatus({
    elapsedSeconds: elapsedMs(d, now, receivedAt) / 1000,
    ...(d.estimateMs !== undefined ? { estimateSeconds: d.estimateMs / 1000 } : {}),
    ...(d.attempt !== undefined ? { attempt: d.attempt } : {}),
    ...(d.attempts !== undefined ? { attempts: d.attempts } : {}),
  });
  return { line: s.line, ...(s.fraction !== undefined ? { fraction: s.fraction } : {}), over: s.over };
}

/** Milliseconds until the words change: the next whole second since the start. */
export function msToNextSecond(d: RunningData, now: number, receivedAt: number): number {
  return 1000 - (elapsedMs(d, now, receivedAt) % 1000);
}

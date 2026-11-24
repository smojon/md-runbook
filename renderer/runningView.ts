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

/**
 * What a status gets when it goes (the run ended, or the status moved below a new output): the
 * renderer draws nothing and stops its timer. Not no items at all: VS Code doesn't take an
 * extension's output away when its items go (its update throws on no mime type), so the old
 * drawing stayed, counting for hours. An item of the same mime is an update the renderer is given.
 */
export interface EndedData {
  ended: true;
}

export function isEndedData(v: unknown): v is EndedData {
  return typeof v === 'object' && v !== null && (v as Partial<EndedData>).ended === true;
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
 * The renderer asks the extension host how long a cell has run, when it first draws its data
 * (src/pinnedStatus.ts elapsedAnswer). It may be drawn minutes after it came: scrolled back into
 * view, or in a new webview after a split or a move.
 */
export interface ElapsedAsk {
  type: 'elapsed?';
  /** The output item's id, sent back with the answer. */
  id: string;
  startedAt: number;
}

/** The answer: the time since the start, by the extension host's clock alone. */
export interface ElapsedAnswer {
  type: 'elapsed';
  id: string;
  elapsedMs: number;
}

export function isElapsedAnswer(v: unknown): v is ElapsedAnswer {
  const m = v as Partial<ElapsedAnswer> | null;
  return typeof m === 'object' && m !== null && m.type === 'elapsed' && typeof m.id === 'string' && num(m.elapsedMs);
}

/** Where the count stands: `elapsedMs` at `at` (epoch ms, the window's clock), going on by that clock. */
export interface Count {
  elapsedMs: number;
  at: number;
}

/**
 * The count when the renderer first draws data, until the extension host answers (hostCount).
 * Drawn as it was sent: the time to the send, by the host's clock alone. Drawn later (the reason
 * to ask): at least the time since the start by the window's clock, which a remote host's clock
 * skew puts off until the answer comes. Never below 0.
 */
export function firstCount(d: RunningData, now: number): Count {
  return { elapsedMs: Math.max(0, d.sentAt - d.startedAt, now - d.startedAt), at: now };
}

/** The count from the host's answer, received at `now`: no clock but the host's up to there. */
export function hostCount(elapsedMs: number, now: number): Count {
  return { elapsedMs: Math.max(0, elapsedMs), at: now };
}

/**
 * Milliseconds since the start, never below 0: the count, then the time since by the window's
 * clock. Each clock is only compared with itself.
 */
export function elapsedMs(c: Count, now: number): number {
  return Math.max(0, c.elapsedMs + (now - c.at));
}

/** The status at `now` (epoch ms, the window's clock). */
export function runningView(d: RunningData, now: number, c: Count): RunningView {
  const s = cellRunStatus({
    elapsedSeconds: elapsedMs(c, now) / 1000,
    ...(d.estimateMs !== undefined ? { estimateSeconds: d.estimateMs / 1000 } : {}),
    ...(d.attempt !== undefined ? { attempt: d.attempt } : {}),
    ...(d.attempts !== undefined ? { attempts: d.attempts } : {}),
  });
  return { line: s.line, ...(s.fraction !== undefined ? { fraction: s.fraction } : {}), over: s.over };
}

/** Milliseconds until the words change: the next whole second since the start. */
export function msToNextSecond(c: Count, now: number): number {
  return 1000 - (elapsedMs(c, now) % 1000);
}

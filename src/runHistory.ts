/**
 * Run history, the parts without VS Code (unit-tested): a small record of each run of a runbook,
 * kept in workspace state by runs.ts and never in the file; the caps; the Show Runs labels; when
 * the runbook last ran green; where a run starts in the transcript.
 */

import { formatEstimate } from '@md-runbook/core/estimate';

/** Runs kept per runbook: the oldest go first. */
export const RUNS_PER_RUNBOOK = 50;
/** Runbooks kept: the least recently run go first. */
export const RUNBOOKS_KEPT = 200;

/** One run (one cell, a range, Run All or Resume Run) as it ended. */
export interface RunSummary {
  /** When the first cell started, and when the run ended (ms since 1970). */
  started: number;
  ended: number;
  /** The runbook it ran in (a run copy keeps its own uri; it counts for its original). */
  uri: string;
  /** Who ran it (the user name on this machine). */
  by?: string;
  /** Indexes of the cells run, in order. */
  cells: number[];
  /** Their step keys (core stepHistoryKey), so a step is known after cells move or are added. */
  steps: string[];
  passed: number;
  failed: number;
  skipped: number;
  /** The runbook after the run: steps in all, and how many are done or skipped. */
  total: number;
  complete: number;
  /** After the run every step was done: nothing failed, nothing to do. */
  green: boolean;
  /** The first cell of this run that failed (or was stopped). */
  firstFailed?: { cell: number; step?: number; label: string };
  /** The run was stopped (Stop, or a timeout) rather than failed. */
  stopped?: boolean;
  /** A run of one cell: which step it was. */
  single?: { cell: number; step?: number; label: string };
}

/** Runs per runbook (by historyKey), oldest first; the most recently run runbook last. */
export type RunStore = Record<string, RunSummary[]>;

/** The store with `run` added for `key`, within the caps. Does not change `all`. */
export function withRun(all: RunStore | undefined, key: string, run: RunSummary, perRunbook = RUNS_PER_RUNBOOK, runbooks = RUNBOOKS_KEPT): RunStore {
  const next: RunStore = { ...(all ?? {}) };
  const runs = [...(next[key] ?? []), run].slice(-perRunbook);
  // Most recently run last: the oldest runbooks are dropped past the limit.
  delete next[key];
  next[key] = runs;
  const names = Object.keys(next);
  for (const old of names.slice(0, Math.max(0, names.length - runbooks))) delete next[old];
  return next;
}

/**
 * The runbook a run copy (`deploy.20261114-142000.md`) was copied from, by name
 * (`deploy.md`); undefined for a name that is not a copy's.
 */
export function originalName(fileName: string): string | undefined {
  const re = /\.\d{8}-\d{6}(?:-\d+)?\.md$/i;
  return re.test(fileName) ? fileName.replace(re, '.md') : undefined;
}

/** The last run after which every step was done, or undefined. */
export function lastGreenOf(runs: readonly RunSummary[] | undefined): { at: number; by?: string } | undefined {
  for (let i = (runs?.length ?? 0) - 1; i >= 0; i--) {
    const r = runs![i]!;
    if (r.green) return { at: r.ended, ...(r.by !== undefined ? { by: r.by } : {}) };
  }
  return undefined;
}

/** The step keys that ran in any of the runs (not counting cells skipped by an option). */
export function ranSteps(runs: readonly RunSummary[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const r of runs ?? []) for (const k of r.steps) keys.add(k);
  return keys;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `14 Nov 14:32` in local time, with the year when it is not this year's. */
export function formatWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `just now`, `5 minutes ago`, `3 days ago`: how long ago, roughly. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  const unit = (n: number, name: string): string => `${n} ${name}${n === 1 ? '' : 's'} ago`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 60) return unit(days, 'day');
  if (days < 730) return unit(Math.floor(days / 30), 'month');
  return unit(Math.floor(days / 365), 'year');
}

/** The status bar tooltip's line: `Last ran green: 3 days ago (by smojon)` or `Never ran green`. */
export function lastGreenText(green: { at: number; by?: string } | undefined, now = Date.now()): string {
  return green ? `Last ran green: ${ago(green.at, now)}${green.by ? ` (by ${green.by})` : ''}` : 'Never ran green';
}

/** A Show Runs item: `✓ Done · 6 of 6 · 14 Nov 14:32 · 3m10s`, who ran it and the counts below. */
export function runItem(r: RunSummary, now = Date.now()): { label: string; detail: string } {
  const where = (x: { step?: number; cell: number }): string => (x.step !== undefined ? `step ${x.step} of ${r.total}` : `cell ${x.cell + 1}`);
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  let what: string;
  if (r.firstFailed) what = r.stopped ? `■ Stopped at ${where(r.firstFailed)} — ${r.firstFailed.label}` : `✗ ${cap(where(r.firstFailed))} failed — ${r.firstFailed.label}`;
  else if (r.green) what = `✓ Done · ${r.complete} of ${r.total}`;
  else if (r.single) what = `○ ${cap(where(r.single))} ${r.skipped > 0 ? 'skipped' : 'passed'} — ${r.single.label}`;
  else what = `○ ${r.complete} of ${r.total} done`;
  const label = `${what} · ${formatWhen(r.started, now)} · ${formatEstimate(Math.max(0, r.ended - r.started) / 1000)}`;
  const counts = [`${r.passed} passed`, ...(r.failed > 0 ? [`${r.failed} failed`] : []), ...(r.skipped > 0 ? [`${r.skipped} skipped`] : [])];
  const copy = r.uri.split('/').pop() ?? '';
  const detail = [...(r.by ? [`by ${r.by}`] : []), counts.join(', '), ...(originalName(decodeURIComponent(copy)) ? [`in ${decodeURIComponent(copy)}`] : [])].join(' · ');
  return { label, detail };
}

const HEADER_RE = /^===== (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)?) · /;

/**
 * The 0-based line of the transcript where a run starts: the first entry header (`===== <time> · …`)
 * from the second the run started to its end; undefined when the transcript has none (it was off,
 * or rotated away).
 */
export function transcriptLine(text: string, started: number, ended: number): number | undefined {
  // Headers are to the second, and written just after the run's start was taken.
  const from = Math.floor(started / 1000) * 1000;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER_RE.exec(lines[i]!);
    if (!m) continue;
    const t = Date.parse(m[1]!);
    if (Number.isFinite(t) && t >= from && t <= ended + 1000) return i;
  }
  return undefined;
}

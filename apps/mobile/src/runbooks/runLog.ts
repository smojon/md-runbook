/**
 * Run history, as VS Code's Show Runs…: a small record of each run of a runbook on this device,
 * never in its file. When it ran, who ran it (the signer name, if set), how long it took, the
 * steps it ran with their state, and whether the runbook was green after it. Names, states and
 * times only (as run reports): never an output, a value or a secret. A run copy's runs count for
 * the runbook it was copied from, as in VS Code.
 */
import { useSyncExternalStore } from 'react';
import { RUN_STEP_STATES, RunStepState, summaryLabel } from '@md-runbook/core/runReport';
import { summarySteps } from '../reports/summary';
import { getJson, setJson } from '../storage/kv';
import { Runbook, runbookNamed } from './store';

const KEY = 'md-runbook.runLog';
/** Runs kept per runbook: the oldest go first. */
export const RUNS_PER_RUNBOOK = 30;
/** Runbooks kept: the least recently run go first. */
const MAX_RUNBOOKS = 200;

export interface RunLogStep {
  label: string;
  state: RunStepState;
  ms?: number;
}

export interface RunLogEntry {
  /** When the run started and ended (ms since 1970). */
  started: number;
  ended: number;
  by?: string;
  /** The steps this run ran, in order. */
  steps: RunLogStep[];
  /** The runbook after the run: its steps, and how many are done (passed, by hand) or skipped. */
  total: number;
  complete: number;
  /** After the run nothing failed and nothing was left to do. */
  green: boolean;
  /** The run copy it ran in (`deploy.20261116-143200.md`), for a copy's run. */
  copy?: string;
}

type Log = Record<string, RunLogEntry[]>;

const isEntry = (e: unknown): e is RunLogEntry => {
  const r = e as RunLogEntry;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof r.started === 'number' &&
    typeof r.ended === 'number' &&
    typeof r.total === 'number' &&
    typeof r.complete === 'number' &&
    typeof r.green === 'boolean' &&
    Array.isArray(r.steps) &&
    r.steps.every((s) => typeof s?.label === 'string' && (RUN_STEP_STATES as readonly string[]).includes(s.state))
  );
};
const isLog = (v: unknown): v is Log =>
  typeof v === 'object' && v !== null && Object.values(v).every((runs) => Array.isArray(runs) && runs.every(isEntry));

let log: Log = {};
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
let loaded: Promise<void> | undefined;

/** Read what is stored (once); a run recorded before that is kept. */
export function loadRunLog(): Promise<void> {
  loaded ??= getJson(KEY, isLog).then((v) => {
    const merged: Log = { ...(v ?? {}) };
    for (const [k, runs] of Object.entries(log)) merged[k] = [...(merged[k] ?? []), ...runs].slice(-RUNS_PER_RUNBOOK);
    log = merged;
    emit();
  });
  return loaded;
}

const COPY_RE = /\.\d{8}-\d{6}(?:-\d+)?\.md$/i;

/** The runbook a run copy (Run All as Copy, Start Incident) was made from, while the app has it. */
function originalOf(r: Pick<Runbook, 'id' | 'fileName'>): Runbook | undefined {
  if (!r.fileName || !COPY_RE.test(r.fileName)) return undefined;
  const original = runbookNamed(r.fileName.replace(COPY_RE, '.md'));
  return original && original.id !== r.id ? original : undefined;
}

/** Whose runs a runbook has: its own, or for a run copy its original's. */
export const runLogKey = (r: Pick<Runbook, 'id' | 'fileName'>): string => originalOf(r)?.id ?? r.id;

/**
 * The record of the run that started at `started` and ended at `ended`, from the runbook's text
 * after it; undefined when no step ran in it.
 */
export function runEntry(text: string, started: number, ended: number, by?: string): RunLogEntry | undefined {
  const steps = summarySteps(text, started);
  const ran = steps.filter((s) => s.ran);
  if (ran.length === 0) return undefined;
  const count = (...states: RunStepState[]): number => steps.filter((s) => states.includes(s.state)).length;
  return {
    started,
    ended: Math.max(started, ended),
    ...(by ? { by: summaryLabel(by) } : {}),
    steps: ran.map((s) => ({
      label: summaryLabel(s.label),
      state: s.state,
      ...(s.ms !== undefined && Number.isFinite(s.ms) ? { ms: Math.max(0, Math.round(s.ms)) } : {}),
    })),
    total: steps.length,
    complete: count('passed', 'by-hand', 'skipped'),
    green: count('failed', 'not-run') === 0,
  };
}

/** Record a run of `runbook` (a copy's for its original). */
export async function recordRun(runbook: Pick<Runbook, 'id' | 'fileName'>, entry: RunLogEntry): Promise<void> {
  await loadRunLog();
  const key = runLogKey(runbook);
  const withCopy = key !== runbook.id && runbook.fileName ? { ...entry, copy: runbook.fileName } : entry;
  const next: Log = { ...log };
  const runs = [...(next[key] ?? []), withCopy].slice(-RUNS_PER_RUNBOOK);
  // Most recently run last: the oldest runbooks are dropped past the limit.
  delete next[key];
  next[key] = runs;
  const ids = Object.keys(next);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_RUNBOOKS))) delete next[old];
  log = next;
  emit();
  await setJson(KEY, log);
}

/** Forget a runbook's runs. */
export async function forgetRuns(key: string): Promise<void> {
  await loadRunLog();
  const next = { ...log };
  delete next[key];
  log = next;
  emit();
  await setJson(KEY, log);
}

const NONE: readonly RunLogEntry[] = [];

/** A runbook's runs, oldest first, kept current. */
export function useRunLog(key: string | undefined): readonly RunLogEntry[] {
  const all = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      void loadRunLog();
      return () => listeners.delete(l);
    },
    () => log,
  );
  return key === undefined ? NONE : (all[key] ?? NONE);
}

/** A runbook's runs now (outside React), oldest first. */
export const runsOf = (key: string): readonly RunLogEntry[] => log[key] ?? NONE;

/** The last run after which the runbook was green. */
export function lastGreen(runs: readonly RunLogEntry[]): RunLogEntry | undefined {
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i]!.green) return runs[i];
  return undefined;
}

/** Tests: forget it all. */
export function resetRunLog(): void {
  log = {};
  loaded = undefined;
  emit();
}

/**
 * How long each step took on its runs that passed, per runbook, on this device (never in the
 * runbook's file): a block without estimate= then shows its usual time (`est. ~1m15s`, core's
 * learnedEstimate) and counts in the time left, as in VS Code. A step is kept under its name=,
 * else its text (core's stepHistoryKey), so editing a command starts its history again.
 */
import { useSyncExternalStore } from 'react';
import { learnedEstimate, stepHistoryKey, withDuration } from '@md-runbook/core/estimate';
import { getJson, setJson } from '../storage/kv';

const KEY = 'md-runbook.stepHistory';
/** Runbooks kept: the least recently run go first. */
const MAX_RUNBOOKS = 200;

type History = Record<string, Record<string, number[]>>;

const isHistory = (v: unknown): v is History =>
  typeof v === 'object' &&
  v !== null &&
  Object.values(v).every(
    (steps) =>
      typeof steps === 'object' &&
      steps !== null &&
      Object.values(steps as object).every((d) => Array.isArray(d) && d.every((n) => typeof n === 'number')),
  );

let history: History = {};
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
let loaded: Promise<void> | undefined;

/** Read what is stored (once); a run recorded before that is kept. */
export function loadStepHistory(): Promise<void> {
  loaded ??= getJson(KEY, isHistory).then((v) => {
    history = { ...(v ?? {}), ...history };
    emit();
  });
  return loaded;
}

/** A run of a step that passed took `seconds`. */
export async function recordStepRun(runbookId: string, info: string, source: string, seconds: number): Promise<void> {
  await loadStepHistory();
  const steps = { ...(history[runbookId] ?? {}) };
  const key = stepHistoryKey(info, source);
  steps[key] = withDuration(steps[key], seconds);
  // Most recently run last: the oldest runbooks are dropped past the limit.
  const next: History = { ...history };
  delete next[runbookId];
  next[runbookId] = steps;
  const ids = Object.keys(next);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_RUNBOOKS))) delete next[old];
  history = next;
  emit();
  await setJson(KEY, history);
}

/** The usual time of a step's runs that passed (seconds), or undefined before its first. */
export function learnedFor(steps: Readonly<Record<string, number[]>> | undefined, info: string, source: string): number | undefined {
  const runs = steps?.[stepHistoryKey(info, source)];
  return runs ? learnedEstimate(runs) : undefined;
}

/** A runbook's step history, kept current (re-renders when a run is recorded). */
export function useStepHistory(runbookId: string | undefined): Readonly<Record<string, number[]>> | undefined {
  const all = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => history,
  );
  return runbookId === undefined ? undefined : all[runbookId];
}

/** Tests: forget it all. */
export function resetStepHistory(): void {
  history = {};
  loaded = undefined;
  emit();
}

/**
 * What a narrow screen (a phone) shows of each runbook: the runbook itself or its Steps, as the
 * switch at the top was left. Kept on this device (never in the runbook's file), like the pins;
 * a runbook not listed shows the runbook.
 */
import { useSyncExternalStore } from 'react';
import { getJson, setJson } from '../storage/kv';

export type RunbookViewMode = 'runbook' | 'steps';

const KEY = 'runbooks.view.v1';
/** Runbooks kept: the ones switched least recently go first. */
const MAX = 200;
const isModes = (v: unknown): v is Record<string, RunbookViewMode> =>
  typeof v === 'object' && v !== null && Object.values(v).every((m) => m === 'runbook' || m === 'steps');
let modes: Readonly<Record<string, RunbookViewMode>> = {};
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function loadViewModes(): Promise<void> {
  return (loaded ??= (async () => {
    const saved = await getJson(KEY, isModes);
    // A switch made while loading wins.
    if (saved) modes = { ...saved, ...modes };
    emit();
  })());
}

export const viewModeOf = (id: string | undefined): RunbookViewMode => (id !== undefined ? (modes[id] ?? 'runbook') : 'runbook');

export function setViewMode(id: string, mode: RunbookViewMode): void {
  if (viewModeOf(id) === mode) return;
  // Only Steps is stored (the runbook is what shows without an entry); the most recent last.
  const next: Record<string, RunbookViewMode> = { ...modes };
  delete next[id];
  if (mode === 'steps') next[id] = mode;
  const ids = Object.keys(next);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX))) delete next[old];
  modes = next;
  emit();
  void setJson(KEY, modes).catch(() => undefined);
}

export function useViewMode(id: string | undefined): RunbookViewMode {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => viewModeOf(id),
  );
}

/** Tests. */
export function resetViewModes(): void {
  modes = {};
  loaded = undefined;
  emit();
}

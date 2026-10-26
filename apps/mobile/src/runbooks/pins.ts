/**
 * Pinned runbooks: the few an on-call person needs first, at the top of the start screen (and
 * on the app icon's long-press menu). Runbook ids, in the order they were pinned.
 */
import { useSyncExternalStore } from 'react';
import { getJson, setJson } from '../storage/kv';

const KEY = 'runbooks.pinned.v1';
const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
let pins: readonly string[] = [];
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function loadPins(): Promise<void> {
  return (loaded ??= (async () => {
    const saved = await getJson(KEY, isIds);
    // Pins made while loading stay.
    if (saved) pins = [...new Set([...saved, ...pins])];
    emit();
  })());
}

function save(next: readonly string[]): void {
  pins = next;
  emit();
  void setJson(KEY, pins).catch(() => undefined);
}

export const isPinned = (id: string): boolean => pins.includes(id);
export const pinnedIds = (): readonly string[] => pins;

export function setPinned(id: string, on: boolean): void {
  if (on === isPinned(id)) return;
  save(on ? [...pins, id] : pins.filter((p) => p !== id));
}

export function usePins(): readonly string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pins,
  );
}

/** Tests. */
export function resetPins(): void {
  pins = [];
  loaded = undefined;
  emit();
}

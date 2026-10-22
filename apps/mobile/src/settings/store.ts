/**
 * App settings that mirror the extension's: how many earlier runs each cell keeps in the file
 * (mdRunbook.output.historySize there, 0 by default: the file only has the latest run).
 */
import { useSyncExternalStore } from 'react';
import { getJson, setJson } from '../storage/kv';

const KEY = 'settings.v1';
export const HISTORY_SIZES = [0, 1, 3, 5, 10] as const;

interface Settings {
  historySize: number;
}
const isSettings = (v: unknown): v is Settings => typeof v === 'object' && v !== null && typeof (v as Settings).historySize === 'number';

let settings: Settings = { historySize: 0 };
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export async function loadSettings(): Promise<void> {
  settings = (await getJson(KEY, isSettings)) ?? settings;
  emit();
}

export const historySize = (): number => settings.historySize;

export function setHistorySize(n: number): void {
  settings = { ...settings, historySize: Math.max(0, Math.min(10, Math.floor(n))) };
  emit();
  void setJson(KEY, settings).catch(() => undefined);
}

export function useHistorySize(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => settings.historySize,
  );
}

/** Tests. */
export function resetSettings(): void {
  settings = { historySize: 0 };
  emit();
}

/**
 * The runbooks the app knows: the bundled sample and the files opened in this session (kept in
 * memory for now; saving them back and remembering them comes with running cells).
 */
import { useSyncExternalStore } from 'react';
import { BUNDLED } from './sample';

export interface Runbook {
  id: string;
  title: string;
  text: string;
  source: 'bundled' | 'file';
}

/** Larger files are refused: the app keeps every open runbook in memory. */
export const MAX_RUNBOOK_BYTES = 2_000_000;

let opened: Runbook[] = [];
let all: readonly Runbook[] = BUNDLED.map((r) => ({ ...r, source: 'bundled' as const }));
let next = 1;
const listeners = new Set<() => void>();

/** The first `# heading`, else the file name without `.md`. */
export function titleOf(text: string, fileName: string): string {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1]?.trim();
  return heading || fileName.replace(/\.(md|markdown)$/i, '') || fileName;
}

export function addRunbook(fileName: string, text: string): Runbook {
  const r: Runbook = { id: `file-${next++}`, title: titleOf(text, fileName), text, source: 'file' };
  opened = [...opened, r];
  all = [...BUNDLED.map((b) => ({ ...b, source: 'bundled' as const })), ...opened];
  listeners.forEach((l) => l());
  return r;
}

export function getRunbook(id: string | undefined): Runbook | undefined {
  return all.find((r) => r.id === id);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useRunbooks(): readonly Runbook[] {
  return useSyncExternalStore(subscribe, () => all);
}

/** Tests only: back to the bundled runbooks. */
export function resetRunbooks(): void {
  opened = [];
  all = BUNDLED.map((r) => ({ ...r, source: 'bundled' as const }));
  next = 1;
  listeners.forEach((l) => l());
}

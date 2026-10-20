/**
 * The runbooks the app knows: the bundled sample and the files the user opened. The app keeps
 * its own copy of each (storage/docs) and remembers the list (kv), so they are there after a
 * restart, outputs included. A runbook opened from a file remembers where that file is (`origin`)
 * and the fingerprint of the text last read from or saved to it (`savedHash`): different from the
 * current text means unsaved changes.
 */
import { useSyncExternalStore } from 'react';
import { deleteDoc, readDoc, writeDoc } from '../storage/docs';
import { getJson, setJson } from '../storage/kv';
import { Origin, isOrigin, textHash } from './origin';
import { BUNDLED } from './sample';

export interface Runbook {
  id: string;
  title: string;
  text: string;
  source: 'bundled' | 'file';
  fileName?: string;
  origin?: Origin;
  savedHash?: string;
}

/** Larger files are refused: the app keeps every open runbook in memory. */
export const MAX_RUNBOOK_BYTES = 2_000_000;

interface IndexEntry {
  id: string;
  fileName: string;
  origin?: Origin;
  savedHash?: string;
}
const INDEX_KEY = 'runbooks.v1';
const isIndex = (v: unknown): v is IndexEntry[] =>
  Array.isArray(v) &&
  v.every(
    (e: unknown) =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as IndexEntry).id === 'string' &&
      typeof (e as IndexEntry).fileName === 'string' &&
      ((e as IndexEntry).origin === undefined || isOrigin((e as IndexEntry).origin)),
  );

const bundled = (): Runbook[] => BUNDLED.map((r) => ({ ...r, source: 'bundled' as const }));
let all: readonly Runbook[] = bundled();
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

/** The first `# heading`, else the file name without `.md`. */
export function titleOf(text: string, fileName: string): string {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1]?.trim();
  return heading || fileName.replace(/\.(md|markdown)$/i, '') || fileName;
}

/** Writes in order per runbook, so a slow write never lands after a newer one. */
const writes = new Map<string, Promise<void>>();
function persistText(id: string, text: string): void {
  const prev = writes.get(id) ?? Promise.resolve();
  const next = prev.then(() => writeDoc(id, text)).catch((e: unknown) => console.warn(`runbook ${id} not saved in the app`, e));
  writes.set(id, next);
}
function persistIndex(): void {
  const index: IndexEntry[] = all
    .filter((r) => r.source === 'file')
    .map((r) => ({
      id: r.id,
      fileName: r.fileName ?? r.title,
      ...(r.origin ? { origin: r.origin } : {}),
      ...(r.savedHash ? { savedHash: r.savedHash } : {}),
    }));
  void setJson(INDEX_KEY, index).catch((e: unknown) => console.warn('runbook list not saved', e));
}

/** Waits for pending writes (tests, and before the app goes to the background). */
export async function flushRunbooks(): Promise<void> {
  await Promise.all(writes.values());
}

let loaded: Promise<void> | undefined;
/** Reads the remembered runbooks; once per launch. */
export function loadRunbooks(): Promise<void> {
  loaded ??= (async () => {
    const index = (await getJson(INDEX_KEY, isIndex)) ?? [];
    const files: Runbook[] = [];
    for (const e of index) {
      const text = await readDoc(e.id).catch(() => undefined);
      if (text === undefined) continue;
      files.push({
        id: e.id,
        title: titleOf(text, e.fileName),
        text,
        source: 'file',
        fileName: e.fileName,
        origin: e.origin,
        savedHash: e.savedHash,
      });
    }
    const samples = await Promise.all(
      bundled().map(async (b) => {
        const text = await readDoc(b.id).catch(() => undefined);
        return text === undefined ? b : { ...b, text };
      }),
    );
    // Runbooks opened while loading stay (after the remembered ones).
    const opened = all.filter((r) => r.source === 'file' && !files.some((f) => f.id === r.id));
    all = [...samples, ...files, ...opened];
    emit();
  })();
  return loaded;
}

export function addRunbook(fileName: string, text: string, origin?: Origin): Runbook {
  const id = `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const r: Runbook = {
    id,
    title: titleOf(text, fileName),
    text,
    source: 'file',
    fileName,
    ...(origin ? { origin, savedHash: textHash(text) } : {}),
  };
  all = [...all, r];
  persistText(id, text);
  persistIndex();
  emit();
  return r;
}

/** Replace a runbook's text (a cell ran, a box was ticked). */
export function updateRunbookText(id: string, text: string): void {
  all = all.map((r) => (r.id === id ? { ...r, text, title: r.source === 'file' ? titleOf(text, r.fileName ?? r.title) : r.title } : r));
  persistText(id, text);
  if (all.some((r) => r.id === id && r.source === 'file')) persistIndex();
  emit();
}

/** The runbook's text is now the file's (saved to it, or read from it); `origin` when it changed. */
export function markSaved(id: string, text: string, origin?: Origin): void {
  all = all.map((r) => (r.id === id ? { ...r, ...(origin ? { origin } : {}), savedHash: textHash(text) } : r));
  persistIndex();
  emit();
}

/** Forget a runbook (the app's copy and the link to its file; the file itself stays). */
export function removeRunbook(id: string): Runbook | undefined {
  const r = all.find((x) => x.id === id && x.source === 'file');
  if (!r) return undefined;
  all = all.filter((x) => x.id !== id);
  const prev = writes.get(id) ?? Promise.resolve();
  writes.set(
    id,
    prev.then(() => deleteDoc(id)).catch(() => undefined),
  );
  persistIndex();
  emit();
  return r;
}

/** Changes not yet saved to the runbook's file. */
export function hasUnsavedChanges(r: Runbook): boolean {
  return r.origin !== undefined && r.savedHash !== textHash(r.text);
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

/** Tests only: back to the bundled runbooks, nothing loaded. */
export function resetRunbooks(): void {
  all = bundled();
  loaded = undefined;
  writes.clear();
  emit();
}

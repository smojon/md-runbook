/**
 * Runbook files on the web. Browsers with the File System Access API (Chrome, Edge) open the
 * file itself and save back to it; the file handle is kept in IndexedDB, so the runbook stays
 * linked to its file after a reload (the browser asks again for permission to write). Other
 * browsers open a copy, and saving downloads the runbook.
 */
import { getDocumentAsync } from 'expo-document-picker';
import { t } from '../i18n';
import type { Origin, PickResult } from './origin';
import { MAX_RUNBOOK_BYTES } from './store';

interface Writable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<Writable>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}
type OpenPicker = (o: object) => Promise<FileHandle[]>;

const openPicker = (): OpenPicker | undefined => (globalThis as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;

export function canSaveInPlace(): boolean {
  return openPicker() !== undefined && typeof indexedDB !== 'undefined';
}

/** Saving a runbook that has no file: a download. */
export const canDownload = true;

const DB = 'md-runbook';
const STORE = 'file-handles';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = f(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB'));
    });
  } finally {
    d.close();
  }
}

async function handleOf(origin: Origin): Promise<FileHandle> {
  if (origin.kind !== 'handle') throw new Error(t.saveUnavailable);
  const h = await withStore<FileHandle | undefined>('readonly', (s) => s.get(origin.id) as IDBRequest<FileHandle | undefined>);
  if (!h) throw new Error(t.fileLinkLost);
  return h;
}

export async function pickRunbookFile(): Promise<PickResult> {
  const picker = openPicker();
  if (picker && typeof indexedDB !== 'undefined') {
    let handle: FileHandle | undefined;
    try {
      [handle] = await picker({
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] } }],
        multiple: false,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return { kind: 'canceled' };
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    if (!handle) return { kind: 'canceled' };
    const file = await handle.getFile();
    if (file.size > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(file.name) };
    const id = `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await withStore('readwrite', (s) => s.put(handle, id));
    return { kind: 'picked', name: file.name, text: await file.text(), origin: { kind: 'handle', id } };
  }
  const picked = await getDocumentAsync({ type: ['text/markdown', 'text/plain', '*/*'] });
  if (picked.canceled) return { kind: 'canceled' };
  const asset = picked.assets[0];
  if (!asset?.file) return { kind: 'canceled' };
  if (asset.file.size > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(asset.name) };
  return { kind: 'picked', name: asset.name, text: await asset.file.text() };
}

export async function readOrigin(origin: Origin): Promise<{ text: string; origin?: Origin }> {
  const h = await handleOf(origin);
  return { text: await (await h.getFile()).text() };
}

export async function writeOrigin(origin: Origin, text: string): Promise<void> {
  const h = await handleOf(origin);
  // After a reload the browser asks again; the Save tap is the user gesture it needs.
  if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if (!h.requestPermission || (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error(t.saveNotAllowed);
  }
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
}

/** The runbook as a .md download. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function forgetOrigin(origin: Origin): Promise<void> {
  if (origin.kind === 'handle') await withStore('readwrite', (s) => s.delete(origin.id)).catch(() => undefined);
}

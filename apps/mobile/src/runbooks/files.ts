/**
 * Runbook files on the phones: opened where they are and saved back there.
 * - Android: the system picker (ACTION_OPEN_DOCUMENT) through Expo's file system, which keeps a
 *   lasting read/write grant to the file's content URI.
 * - iOS: the DocumentAccess module opens the file in place and keeps a bookmark to it.
 * - Otherwise (a module missing): a copy of the file, which cannot be saved back.
 * The web has its own version (files.web.ts).
 */
import { getDocumentAsync } from 'expo-document-picker';
import { File as FsFile } from 'expo-file-system';
import { Platform } from 'react-native';
import { DocumentAccess } from '../../modules/document-access';
import { t } from '../i18n';
import type { Origin, PickResult } from './origin';
import { MAX_RUNBOOK_BYTES } from './store';

const MIME = ['text/markdown', 'text/x-markdown', 'text/plain', 'application/octet-stream'];

export function canSaveInPlace(): boolean {
  return Platform.OS === 'android' || (Platform.OS === 'ios' && DocumentAccess !== null);
}

/** Saving without a file to save to (a runbook opened as a copy): nothing on the phones. */
export const canDownload = false;

export async function pickRunbookFile(): Promise<PickResult> {
  try {
    if (Platform.OS === 'ios' && DocumentAccess) {
      const picked = await DocumentAccess.pick();
      if (!picked) return { kind: 'canceled' };
      return { kind: 'picked', name: picked.name, text: picked.text, origin: { kind: 'bookmark', bookmark: picked.bookmark } };
    }
    if (Platform.OS === 'android') {
      const picked = await FsFile.pickFileAsync({ mimeTypes: MIME });
      if (picked.canceled) return { kind: 'canceled' };
      const file = picked.result;
      if (file.size > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(file.name) };
      return { kind: 'picked', name: file.name, text: await file.text(), origin: { kind: 'uri', uri: file.uri } };
    }
    return await pickCopy();
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** A copy of the file (iOS without the module; Jest). */
async function pickCopy(): Promise<PickResult> {
  const picked = await getDocumentAsync({ type: [...MIME, '*/*'], copyToCacheDirectory: true });
  if (picked.canceled) return { kind: 'canceled' };
  const asset = picked.assets[0];
  if (!asset) return { kind: 'canceled' };
  if (asset.size !== undefined && asset.size > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(asset.name) };
  try {
    const text = asset.file ? await asset.file.text() : await new FsFile(asset.uri).text();
    return { kind: 'picked', name: asset.name, text };
  } catch (e) {
    return { kind: 'error', message: t.fileUnreadable(asset.name, e instanceof Error ? e.message : String(e)) };
  }
}

/** The file's text now; `origin` is set when it changed (an iOS bookmark renewed after a move). */
export async function readOrigin(origin: Origin): Promise<{ text: string; origin?: Origin }> {
  if (origin.kind === 'bookmark') {
    if (!DocumentAccess) throw new Error(t.saveUnavailable);
    const r = await DocumentAccess.read(origin.bookmark);
    return r.bookmark ? { text: r.text, origin: { kind: 'bookmark', bookmark: r.bookmark } } : { text: r.text };
  }
  if (origin.kind === 'uri') return { text: await new FsFile(origin.uri).text() };
  throw new Error(t.saveUnavailable);
}

export async function writeOrigin(origin: Origin, text: string): Promise<void> {
  if (origin.kind === 'bookmark') {
    if (!DocumentAccess) throw new Error(t.saveUnavailable);
    return DocumentAccess.write(origin.bookmark, text);
  }
  if (origin.kind === 'uri') return new FsFile(origin.uri).write(text);
  throw new Error(t.saveUnavailable);
}

/** No downloads on the phones (canDownload is false). */
export function downloadText(_fileName: string, _text: string): void {
  throw new Error(t.saveUnavailable);
}

/** Nothing to clean up on the phones (Android keeps its grant until the app is uninstalled). */
export async function forgetOrigin(_origin: Origin): Promise<void> {}

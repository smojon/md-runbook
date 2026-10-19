/** Open a Markdown runbook with the system file picker (iOS Files, Android documents, the browser). */
import { getDocumentAsync } from 'expo-document-picker';
import { File as FsFile } from 'expo-file-system';
import { t } from '../i18n';
import { MAX_RUNBOOK_BYTES, Runbook, addRunbook } from './store';

export type OpenResult = { kind: 'opened'; runbook: Runbook } | { kind: 'canceled' } | { kind: 'error'; message: string };

export async function openRunbookFile(): Promise<OpenResult> {
  const picked = await getDocumentAsync({ type: ['text/markdown', 'text/x-markdown', 'text/plain', '*/*'], copyToCacheDirectory: true });
  if (picked.canceled) return { kind: 'canceled' };
  const asset = picked.assets[0];
  if (!asset) return { kind: 'canceled' };
  if (asset.size !== undefined && asset.size > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(asset.name) };
  try {
    // Web: the browser's File; iOS/Android: the copy in the app's cache.
    const text = asset.file ? await asset.file.text() : await new FsFile(asset.uri).text();
    if (text.length > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(asset.name) };
    return { kind: 'opened', runbook: addRunbook(asset.name, text) };
  } catch (e) {
    return { kind: 'error', message: t.fileUnreadable(asset.name, e instanceof Error ? e.message : String(e)) };
  }
}

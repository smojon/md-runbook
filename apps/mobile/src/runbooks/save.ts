/**
 * Saving a runbook back to its file. Before writing, the file is read: if it changed since the
 * app last read or saved it (edited elsewhere, synced from another device), nothing is written
 * and the screen asks whether to overwrite it or load the file's version.
 */
import { t } from '../i18n';
import { canDownload, downloadText, readOrigin, writeOrigin } from './files';
import { textHash } from './origin';
import { getRunbook, markSaved, updateRunbookText } from './store';

export type SaveOutcome =
  | { kind: 'saved' }
  | { kind: 'unchanged' }
  | { kind: 'downloaded' }
  /** The file changed since the app read it: `fileText` is what is in it now. */
  | { kind: 'conflict'; fileText: string }
  | { kind: 'error'; message: string };

export async function saveRunbook(id: string, opts: { overwrite?: boolean } = {}): Promise<SaveOutcome> {
  const r = getRunbook(id);
  if (!r) return { kind: 'error', message: t.notFound };
  if (!r.origin) {
    if (!canDownload) return { kind: 'error', message: t.saveUnavailable };
    downloadText(r.fileName ?? `${r.title}.md`, r.text);
    return { kind: 'downloaded' };
  }
  try {
    const now = await readOrigin(r.origin);
    const origin = now.origin ?? r.origin;
    if (now.text === r.text) {
      markSaved(id, r.text, now.origin);
      return { kind: 'unchanged' };
    }
    if (!opts.overwrite && textHash(now.text) !== r.savedHash) return { kind: 'conflict', fileText: now.text };
    await writeOrigin(origin, r.text);
    markSaved(id, r.text, now.origin);
    return { kind: 'saved' };
  } catch (e) {
    return { kind: 'error', message: t.saveFailed(e instanceof Error ? e.message : String(e)) };
  }
}

/** Replace the app's copy with the file's text (the other side of a conflict). */
export function loadFileVersion(id: string, fileText: string): void {
  updateRunbookText(id, fileText);
  markSaved(id, fileText);
}

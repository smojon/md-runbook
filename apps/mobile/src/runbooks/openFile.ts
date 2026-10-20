/** Open a Markdown runbook with the system file picker (iOS Files, Android documents, the browser). */
import { t } from '../i18n';
import { pickRunbookFile } from './files';
import { MAX_RUNBOOK_BYTES, Runbook, addRunbook } from './store';

export type OpenResult = { kind: 'opened'; runbook: Runbook } | { kind: 'canceled' } | { kind: 'error'; message: string };

export async function openRunbookFile(): Promise<OpenResult> {
  const picked = await pickRunbookFile();
  if (picked.kind !== 'picked') return picked;
  if (picked.text.length > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(picked.name) };
  return { kind: 'opened', runbook: addRunbook(picked.name, picked.text, picked.origin) };
}

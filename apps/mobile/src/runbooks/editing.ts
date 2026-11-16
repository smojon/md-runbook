/**
 * Editing a runbook as text (screens/RunbookEditor.tsx) and New Runbook…: unsaved drafts kept
 * while the app runs (leaving the editor never loses them), a new runbook's text, its file name's
 * checks, and whether saving would break a signature that matches now (core signedStatus).
 */
import { SignedStatus, signedStatus, wholeRunbookSigned } from '@md-runbook/core/signing';
import { t } from '../i18n';
import type { Runbook } from './store';

const drafts = new Map<string, string>();

/** The unsaved text of a runbook's editor, if it has one. */
export const draftOf = (id: string): string | undefined => drafts.get(id);

/** Keep (or with undefined forget) a runbook's unsaved text. */
export function keepDraft(id: string, text: string | undefined): void {
  if (text === undefined) drafts.delete(id);
  else drafts.set(id, text);
}

/** Tests. */
export function resetDrafts(): void {
  drafts.clear();
}

/** Every part the signature covers is as signed (version 2: the whole text; version 1: its blocks). */
const intact = (s: SignedStatus): boolean =>
  s.version === 2
    ? wholeRunbookSigned(s)
    : s.changed.length === 0 && s.missing.length === 0 && s.moved.length === 0 && s.missingCalls.length === 0;

/**
 * The signature saving `after` in place of `before` would break: it matches `before` and doesn't
 * match `after` (or is gone). Undefined when nothing signed changes, or nothing matched before.
 */
export function signatureBreaks(before: string, after: string): { signer: string; name: string; version: number } | undefined {
  const was = signedStatus(before);
  if (!was || !intact(was)) return undefined;
  const now = signedStatus(after);
  if (now && intact(now)) return undefined;
  return { signer: was.block.signer, name: was.manifest.name, version: was.manifest.version };
}

/** Whether the text has saved outputs (output blocks), which the editor shows as text. */
export const hasOutputs = (text: string): boolean => /<!--\s*md-runbook:output\b/.test(text);

/** The file name as it will be kept (`.md` added), or why it can't be one. */
export function newFileName(typed: string, runbooks: readonly Pick<Runbook, 'fileName'>[]): { name: string } | { problem: string } {
  const v = typed.trim();
  if (v === '') return { problem: t.newRunbookNameEmpty };
  if (/[\\/]/.test(v)) return { problem: t.newRunbookNameFolder };
  const name = /\.(md|markdown)$/i.test(v) ? v : `${v}.md`;
  if (runbooks.some((r) => r.fileName?.toLowerCase() === name.toLowerCase())) return { problem: t.newRunbookNameTaken };
  return { name };
}

/** `restart-api.md` → `Restart api`: the title a new runbook starts with. */
export function titleFromFileName(name: string): string {
  const words = name
    .replace(/(\.runbook)?\.(md|markdown)$/i, '')
    .replace(/[-_.]+/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : t.newRunbookTitle;
}

/** A new runbook's text: its title, and with the template a short intro and one bash step. */
export function newRunbookText(fileName: string, template: boolean): string {
  const title = `# ${titleFromFileName(fileName)}\n`;
  if (!template) return title;
  return [title, t.newRunbookTemplateIntro, '', `\`\`\`bash name="${t.newRunbookTemplateStep}"`, 'hostname && uptime', '```', ''].join(
    '\n',
  );
}

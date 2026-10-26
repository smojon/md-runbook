/** The run report the app shares: the core's HTML report (as the extension and the CLI make it). */
import { DEFAULT_PATTERNS, clearOutputBlocks, createRedactor, recordJson, renderReport } from '@md-runbook/core';
import { formatRunbookLink } from '@md-runbook/core/runbookLink';
import { parseManifest, readSignature, signerNames } from '@md-runbook/core/signing';
import { t } from '../i18n';
import type { Runbook } from '../runbooks/store';

const redactor = createRedactor(DEFAULT_PATTERNS);

export function reportHtml(runbook: Runbook, now = new Date()): string {
  return renderReport(runbook.text, { generatedAt: now, fallbackTitle: runbook.title, redact: redactor.redact });
}

/** The runbook's file name without `.md` (for `name.report.html`, `name.pdf`). */
export function baseName(runbook: Runbook): string {
  return (runbook.fileName ?? runbook.title).replace(/\.(md|markdown)$/i, '').replace(/[\\/:*?"<>|]+/g, '-') || 'runbook';
}

/** The run record as JSON (timeline, summary, signature), redacted as the report is. */
export function recordJsonText(runbook: Runbook, now = new Date()): string {
  return recordJson(runbook.text, { file: runbook.fileName ?? `${baseName(runbook)}.md`, generatedAt: now, redact: redactor.redact });
}

/** The co-signature request: what is to be co-signed, and the link that opens it on Co-sign Runbook. */
export function cosignRequestMessage(runbook: Runbook): string {
  const block = readSignature(runbook.text);
  let what = runbook.title;
  try {
    if (block) what = `${parseManifest(block.manifest).name} version ${parseManifest(block.manifest).version}`;
  } catch {
    // An unreadable manifest: the title will do (Co-sign Runbook says what is wrong).
  }
  const link = formatRunbookLink({ text: clearOutputBlocks(runbook.text), params: {}, action: 'cosign' });
  return t.cosignRequest(what, block ? signerNames(block).join(', ') : '', link);
}

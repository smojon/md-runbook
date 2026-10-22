/** The run report the app shares: the core's HTML report (as the extension and the CLI make it). */
import { DEFAULT_PATTERNS, createRedactor, renderReport } from '@md-runbook/core';
import type { Runbook } from '../runbooks/store';

const redactor = createRedactor(DEFAULT_PATTERNS);

export function reportHtml(runbook: Runbook, now = new Date()): string {
  return renderReport(runbook.text, { generatedAt: now, fallbackTitle: runbook.title, redact: redactor.redact });
}

/** The runbook's file name without `.md` (for `name.report.html`, `name.pdf`). */
export function baseName(runbook: Runbook): string {
  return (runbook.fileName ?? runbook.title).replace(/\.(md|markdown)$/i, '').replace(/[\\/:*?"<>|]+/g, '-') || 'runbook';
}

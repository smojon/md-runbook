/**
 * Output history and run copies. Earlier runs of a cell are kept after its latest output block,
 * collapsed so they render as one line on GitHub:
 *
 *   <!-- md-runbook:output end -->
 *   <details><summary>md-runbook: 2 previous runs</summary>
 *
 *   <!-- md-runbook:output start exit=1 ran=... -->
 *   ```text
 *   ...
 *   ```
 *   <!-- md-runbook:output end -->
 *
 *   </details>
 */

import { addIndent } from './fence';
import { endsWithNewline } from './lines';
import { CodeMeta, HistoryEntry, OutputInput, isHistoryEntry } from './model';
import { formatOutputBlock } from './outputBlock';
import { parseOutputBlockRaw } from './parser';

/** Cell metadata key holding the run history captured when a cell is re-run (see RunHistory). */
export const HISTORY_KEY = 'mdRunbookHistory';

/** What the history preparer stores on a cell when it is re-run. */
export interface RunHistory {
  /** The output the cell had before this run; adds `changed=yes|no`. */
  previous?: HistoryEntry;
  /** History to write, newest first, already trimmed. */
  history: HistoryEntry[];
}

export function isRunHistory(v: unknown): v is RunHistory {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (m.previous === undefined || isHistoryEntry(m.previous)) && Array.isArray(m.history) && m.history.every(isHistoryEntry);
}

/** Attach the captured history of a re-run cell to its new output. */
export function withRunHistory(output: OutputInput | undefined, value: unknown): OutputInput | undefined {
  if (output?.kind !== 'new' || !isRunHistory(value)) return output;
  return { ...output, ...(value.previous ? { previous: value.previous } : {}), history: value.history };
}

/** The output block loaded from the file for this cell, as a history entry. */
export function loadedOutputEntry(meta: CodeMeta): HistoryEntry | undefined {
  if (!meta.output) return undefined;
  const raw = meta.output.raw.slice(meta.output.gap.length);
  const parsed = parseOutputBlockRaw(raw);
  return parsed ? { raw, ...parsed } : undefined;
}

/** History after a re-run: the previous output first, then the older entries, trimmed to `size`. */
export function nextHistory(previous: HistoryEntry | undefined, older: readonly HistoryEntry[], size: number): HistoryEntry[] {
  if (!previous || size <= 0) return [];
  return [previous, ...older].slice(0, size);
}

export function historySummary(count: number): string {
  return `md-runbook: ${count} previous run${count === 1 ? '' : 's'}`;
}

/** Render a history block. Entries loaded from the file are written verbatim. Ends with `eol`. */
export function formatHistoryBlock(entries: readonly HistoryEntry[], indent: string, eol: string): string {
  let s = addIndent(`<details><summary>${historySummary(entries.length)}</summary>`, indent) + eol;
  for (const e of entries) {
    s += eol;
    if (e.raw !== undefined) s += endsWithNewline(e.raw) ? e.raw : e.raw + eol;
    else s += formatOutputBlock(e.text, e.attrs, indent, eol);
  }
  return s + eol + addIndent('</details>', indent) + eol;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `notes.md` -> `notes.20261018-142000.md` (local time). */
export function copyFileName(fileName: string, d: Date): string {
  const base = fileName.replace(/\.md$/i, '');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${base}.${stamp}.md`;
}

/** Whether a file name looks like a run copy made by `copyFileName`. */
export function isCopyFileName(fileName: string): boolean {
  return /\.\d{8}-\d{6}(?:-\d+)?\.md$/i.test(fileName);
}

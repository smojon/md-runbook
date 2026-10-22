/** Mapping between VS Code cell outputs and the core's persisted-output model. */

import * as vscode from 'vscode';
import { colorizeSaved, escapeHtml, parseLineSet } from '@md-runbook/core';
import { cloudView, cloudViewMarkdown } from '@md-runbook/core/cloudViews';
import { colorConfig } from './config';
import type { HistoryEntry, OutputInput, ParsedOutput } from '@md-runbook/core';

export const META_KEY = 'mdRunbook';

const STDOUT = 'application/vnd.code.notebook.stdout';
const STDERR = 'application/vnd.code.notebook.stderr';

/** Metadata on outputs created by md-runbook. */
export interface OutputMetadata {
  /** Loaded from the file: written back verbatim unless replaced. */
  persisted?: boolean;
  /** Stream output of a run; `attrs` are provisional (exit=running) until a status output follows. */
  run?: { attrs: Record<string, string> };
  /** Status line (exit code, duration); never persisted as output text. */
  status?: boolean;
  /** Final marker attributes of a finished run, carried by its status output. */
  attrs?: Record<string, string>;
  /** The run's output as saved (plain text, stderr lines marked), carried by its status output. */
  text?: string;
  /** The collapsed list of earlier runs (output history); display only, never persisted. */
  earlier?: boolean;
  /** A cloud console table of the output (cloudViews.ts); display only, never persisted. */
  cloud?: boolean;
}

interface OutputLike {
  items: readonly { mime: string; data: Uint8Array }[];
  metadata?: Record<string, unknown>;
}

export function outputMeta(output: OutputLike): OutputMetadata | undefined {
  const m = output.metadata?.[META_KEY];
  return typeof m === 'object' && m !== null ? (m as OutputMetadata) : undefined;
}

export function statusLine(exit: string | undefined, ran: string | undefined, duration?: string): string {
  const parts: string[] = [];
  if (exit !== undefined) parts.push(/^-?\d+$/.test(exit) ? `exit code ${exit}` : exit);
  if (duration) parts.push(duration);
  if (ran) parts.push(`ran ${ran}`);
  return parts.join(' · ');
}

/** `2 earlier runs` for the status line (output history), or '' when there are none. */
export function earlierRuns(count: number): string {
  return count > 0 ? `${count} earlier run${count === 1 ? '' : 's'}` : '';
}

/**
 * The earlier runs kept in the output history, newest first, as a collapsed section under the
 * status line. Everything shown is escaped: the entries come from the file.
 */
export function earlierRunsOutput(entries: readonly HistoryEntry[]): vscode.NotebookCellOutput | undefined {
  if (entries.length === 0) return undefined;
  const runs = entries.map((e) => {
    const head = escapeHtml(statusLine(e.attrs.exit, e.attrs.ran, e.attrs.duration) || 'earlier run');
    const fence = '`'.repeat(Math.max(3, ...[...e.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `${head}\n\n${fence}text\n${e.text}\n${fence}`;
  });
  const md = `<details><summary>${earlierRuns(entries.length)}</summary>\n\n${runs.join('\n\n')}\n\n</details>\n`;
  const meta: OutputMetadata = { earlier: true };
  return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(md, 'text/markdown')], { [META_KEY]: meta });
}

/** The cloud console table of an output's resources (AWS, Google Cloud), if it has any. */
export function cloudOutput(stdout: string): vscode.NotebookCellOutput | undefined {
  const view = colorConfig().cloud ? cloudView(stdout) : undefined;
  if (!view) return undefined;
  const meta: OutputMetadata = { cloud: true };
  return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(cloudViewMarkdown(view), 'text/markdown')], { [META_KEY]: meta });
}

/**
 * VS Code only syncs a replaced output's items (not its metadata) to the extension host, so
 * metadata that must survive to save time goes on a newly appended output like this one.
 */
export function statusOutput(text: string, attrs?: Record<string, string>, saved?: string): vscode.NotebookCellOutput {
  const meta: OutputMetadata = { status: true, ...(attrs ? { attrs } : {}), ...(saved !== undefined ? { text: saved } : {}) };
  return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(text)], { [META_KEY]: meta });
}

/** Outputs for a cell loaded from disk: the stored text plus a status line. */
export function persistedOutputs(out: ParsedOutput, history: readonly HistoryEntry[] = []): vscode.NotebookCellOutput[] {
  const meta: OutputMetadata = { persisted: true };
  // Coloured as when it ran (display only: a save writes the block from the file, unchanged).
  const colors = colorConfig();
  const shown = colorizeSaved(out.text, out.attrs.stderr, colors.levels, colors.stderrRed);
  const outputs = [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(shown)], { [META_KEY]: meta })];
  // The cloud console table, from the saved output without its stderr lines.
  const errLines = parseLineSet(out.attrs.stderr);
  const cloud = cloudOutput(
    out.text
      .split('\n')
      .filter((_, i) => !errLines.has(i))
      .join('\n'),
  );
  if (cloud) outputs.push(cloud);
  if (out.attrs.exit !== undefined || out.attrs.ran !== undefined) {
    const status = [statusLine(out.attrs.exit, out.attrs.ran, out.attrs.duration), earlierRuns(history.length)].filter(Boolean).join(' · ');
    outputs.push(statusOutput(status));
  }
  const earlier = earlierRunsOutput(history);
  if (earlier) outputs.push(earlier);
  return outputs;
}

const decoder = new TextDecoder();

/** Decide what to write for a cell's outputs on save. */
export function toOutputInput(outputs: readonly OutputLike[]): OutputInput | undefined {
  let attrs: Record<string, string> | undefined;
  let text = '';
  let saved: string | undefined;
  for (const o of outputs) {
    const m = outputMeta(o);
    if (m?.persisted) return { kind: 'preserved' };
    if (m?.run) {
      attrs ??= m.run.attrs;
      for (const item of o.items) {
        if (item.mime === STDOUT || item.mime === STDERR || item.mime === 'text/plain') text += decoder.decode(item.data);
      }
    }
    if (m?.status && m.attrs) attrs = m.attrs;
    // The plain text the run recorded (the shown items carry colours); older outputs have none.
    if (m?.status && m.text !== undefined) saved = m.text;
  }
  return attrs ? { kind: 'new', text: saved ?? text, attrs } : undefined;
}

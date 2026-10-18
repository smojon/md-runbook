/** Mapping between VS Code cell outputs and the core's persisted-output model. */

import * as vscode from 'vscode';
import type { OutputInput, ParsedOutput } from './core';

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

/**
 * VS Code only syncs a replaced output's items (not its metadata) to the extension host, so
 * metadata that must survive to save time goes on a newly appended output like this one.
 */
export function statusOutput(text: string, attrs?: Record<string, string>): vscode.NotebookCellOutput {
  const meta: OutputMetadata = { status: true, ...(attrs ? { attrs } : {}) };
  return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(text)], { [META_KEY]: meta });
}

/** Outputs for a cell loaded from disk: the stored text plus a status line. */
export function persistedOutputs(out: ParsedOutput): vscode.NotebookCellOutput[] {
  const meta: OutputMetadata = { persisted: true };
  const outputs = [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(out.text)], { [META_KEY]: meta })];
  if (out.attrs.exit !== undefined || out.attrs.ran !== undefined) {
    outputs.push(statusOutput(statusLine(out.attrs.exit, out.attrs.ran, out.attrs.duration)));
  }
  return outputs;
}

const decoder = new TextDecoder();

/** Decide what to write for a cell's outputs on save. */
export function toOutputInput(outputs: readonly OutputLike[]): OutputInput | undefined {
  let attrs: Record<string, string> | undefined;
  let text = '';
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
  }
  return attrs ? { kind: 'new', text, attrs } : undefined;
}

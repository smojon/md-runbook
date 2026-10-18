/** VS Code adapter around the pure parser/writer in ./core. */

import * as vscode from 'vscode';
import { CellInput, HISTORY_KEY, parse, serialize, withRunHistory } from './core';
import { writeOptions } from './config';
import { META_KEY, persistedOutputs, toOutputInput } from './outputs';

export const NOTEBOOK_TYPE = 'md-runbook';

// ignoreBOM keeps a BOM in the decoded text so the parser can record and restore it.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

/** What the writer needs of a notebook cell (NotebookCellData or a live NotebookCell). */
interface CellLike {
  kind: vscode.NotebookCellKind;
  value: string;
  languageId: string | undefined;
  metadata: Record<string, unknown> | undefined;
  outputs: readonly vscode.NotebookCellOutput[];
}

/** Notebook cells -> writer input, exactly as a save maps them (outputs with run history). */
function cellInputs(cells: readonly CellLike[]): CellInput[] {
  return cells.map((c) => ({
    kind: c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup',
    value: c.value,
    languageId: c.languageId,
    meta: c.metadata?.[META_KEY],
    output: c.kind === vscode.NotebookCellKind.Code ? withRunHistory(toOutputInput(c.outputs), c.metadata?.[HISTORY_KEY]) : undefined,
  }));
}

/**
 * An open notebook's cells as a save would write them (unsaved edits, live outputs and run
 * history included). Shared by Export Report and the AI context so they match the saved file.
 */
export function notebookCellInputs(notebook: vscode.NotebookDocument): CellInput[] {
  return cellInputs(
    notebook.getCells().map((c) => ({
      kind: c.kind,
      value: c.document.getText(),
      languageId: c.document.languageId,
      metadata: c.metadata,
      outputs: c.outputs,
    })),
  );
}

/** Markdown for an open notebook as a save would write it, but always with outputs (for reports and AI text). */
export function notebookTextWithOutputs(notebook: vscode.NotebookDocument): string {
  return serialize(notebook.metadata?.[META_KEY], notebookCellInputs(notebook), { ...writeOptions(), persistOutputs: true });
}

export class RunbookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const doc = parse(decoder.decode(content));
    const cells = doc.cells.map((c) => {
      const kind = c.kind === 'code' ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;
      const cell = new vscode.NotebookCellData(kind, c.value, c.languageId);
      cell.metadata = { [META_KEY]: c.meta };
      if (c.output) cell.outputs = persistedOutputs(c.output, c.meta.kind === 'code' ? (c.meta.history?.entries ?? []) : []);
      return cell;
    });
    const data = new vscode.NotebookData(cells);
    data.metadata = { [META_KEY]: doc.meta };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const cells = cellInputs(data.cells.map((c) => ({ kind: c.kind, value: c.value, languageId: c.languageId, metadata: c.metadata, outputs: c.outputs ?? [] })));
    return encoder.encode(serialize(data.metadata?.[META_KEY], cells, writeOptions()));
  }
}

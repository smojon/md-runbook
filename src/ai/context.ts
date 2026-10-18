/**
 * Fallback context builder for the AI commands: the notebook as it would be saved now, through
 * the core `buildAiContext`. Kept in this one file so it can be swapped for src/aiContextGlue.ts
 * (same signature, same workspaceState key for the pseudonym map).
 */

import * as vscode from 'vscode';
import { AiContext, PseudonymMap, buildAiContext, emptyMap } from '../core/aiContext';
import { CellInput, parse, serialize } from '../core';
import { SECTION, writeOptions } from '../config';
import { META_KEY, toOutputInput } from '../outputs';

export const PSEUDONYM_MAP_KEY = 'mdRunbook.ai.pseudonymMap';

export function getPseudonymMap(context: vscode.ExtensionContext): PseudonymMap {
  const m = context.workspaceState.get<PseudonymMap>(PSEUDONYM_MAP_KEY);
  return m && typeof m.forward === 'object' && m.forward !== null ? m : emptyMap();
}

export async function savePseudonymMap(context: vscode.ExtensionContext, map: PseudonymMap): Promise<void> {
  await context.workspaceState.update(PSEUDONYM_MAP_KEY, map);
}

/** The notebook's Markdown with its current (unsaved) cells and outputs. */
export function notebookMarkdown(nb: vscode.NotebookDocument): string {
  const cells: CellInput[] = nb.getCells().map((c) => {
    const code = c.kind === vscode.NotebookCellKind.Code;
    return {
      kind: code ? 'code' : 'markup',
      value: c.document.getText(),
      languageId: c.document.languageId,
      meta: c.metadata?.[META_KEY],
      output: code ? toOutputInput(c.outputs) : undefined,
    };
  });
  return serialize(nb.metadata?.[META_KEY], cells, writeOptions());
}

/**
 * Context for `cells` (notebook indices of code cells to include; default all). Notebook and
 * parsed indices can differ (adjacent markup cells merge when re-parsed), so code cells are
 * matched by their order.
 */
export async function buildContext(context: vscode.ExtensionContext, notebook: vscode.NotebookDocument, cells?: number[]): Promise<AiContext> {
  const markdown = notebookMarkdown(notebook);
  let parsedCells: number[] | undefined;
  if (cells) {
    const ordinals = notebook
      .getCells()
      .filter((c) => c.kind === vscode.NotebookCellKind.Code)
      .map((c, k) => (cells.includes(c.index) ? k : -1))
      .filter((k) => k >= 0);
    const codeIdx = parse(markdown)
      .cells.map((c, i) => (c.kind === 'code' ? i : -1))
      .filter((i) => i >= 0);
    parsedCells = ordinals.map((k) => codeIdx[k]).filter((i): i is number => i !== undefined);
  }
  const c = vscode.workspace.getConfiguration(SECTION, notebook.uri);
  const ctx = buildAiContext(
    markdown,
    {
      redact: writeOptions().redact,
      maxOutputLines: 200,
      maxChars: 60_000,
      pseudonymize: c.get<boolean>('ai.pseudonymize', true),
      ...(parsedCells ? { cells: parsedCells } : {}),
    },
    getPseudonymMap(context),
  );
  await savePseudonymMap(context, ctx.map);
  return ctx;
}

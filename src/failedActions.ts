/**
 * A failed step's next moves, where it failed: on its status line, Retry (this step again),
 * Resume from Here (this step and the ones after), Mark Done (done by hand instead) and, with the
 * assistant on, Explain. Only on the step that failed, and not while anything runs.
 */

import * as vscode from 'vscode';
import { isCodeMeta } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { stepState } from '@md-runbook/core/progress';
import { META_KEY } from './outputs';
import { SECTION } from './config';
import { showRunbook } from './currentRunbook';
import { anyRunning } from './estimates';
import { cellAttrs, selectRunbookKernel } from './progress';
import { NOTEBOOK_TYPE } from './serializer';

/** The cell failed on its last run (a check that failed counts; a declined or skipped one doesn't). */
export function hasFailed(cell: vscode.NotebookCell): boolean {
  if (cell.kind !== vscode.NotebookCellKind.Code) return false;
  const a = cellAttrs(cell);
  return a !== undefined && stepState(a.exit, a.lines !== undefined, a.check) === 'failed';
}

const cellRef = (cell: vscode.NotebookCell): [string, number] => [cell.notebook.uri.toString(), cell.index];

/** on-failure="Rollback" on a failed step: the step named so in the same runbook, if there is one. */
export function rollbackOf(cell: vscode.NotebookCell): { name: string; cell: vscode.NotebookCell } | undefined {
  const meta: unknown = cell.metadata?.[META_KEY];
  const name = isCodeMeta(meta) ? parseCellOptions(meta.info).onFailure : undefined;
  if (!name) return undefined;
  const target = cell.notebook.getCells().find((c) => {
    const m: unknown = c.metadata?.[META_KEY];
    return c.kind === vscode.NotebookCellKind.Code && isCodeMeta(m) && parseCellOptions(m.info).name === name;
  });
  return target ? { name, cell: target } : undefined;
}

function cellOf(uri: unknown, index: unknown): vscode.NotebookCell | undefined {
  if (typeof uri !== 'string' || typeof index !== 'number') return undefined;
  const nb = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri);
  return nb && index >= 0 && index < nb.cellCount ? nb.cellAt(index) : undefined;
}

class FailedActions implements vscode.NotebookCellStatusBarItemProvider {
  readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this.changed.event;

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    if (!hasFailed(cell) || anyRunning(cell.notebook)) return [];
    const item = (text: string, tooltip: string, command: string, args: unknown[]): vscode.NotebookCellStatusBarItem => {
      const i = new vscode.NotebookCellStatusBarItem(text, vscode.NotebookCellStatusBarAlignment.Left);
      i.tooltip = tooltip;
      i.command = { title: tooltip, command, arguments: args };
      i.accessibilityInformation = { label: tooltip };
      // Right after VS Code's own ✗ and time, before the estimate: what to do next.
      i.priority = 900;
      return i;
    };
    const items = [
      item('$(refresh) Retry', 'Run this step again', 'mdRunbook.retryStep', cellRef(cell)),
      item('$(debug-continue) Resume from Here', 'Run this step and the ones after it', 'mdRunbook.resumeFromHere', cellRef(cell)),
      item('$(check) Mark Done', 'Done by hand instead: mark this step done', 'mdRunbook.markStepDone', [cell]),
    ];
    // on-failure="Rollback": the step to run when this one fails, offered here.
    const fallback = rollbackOf(cell);
    if (fallback) items.push(item(`$(debug-reverse-continue) Run ${fallback.name}`, `Run the step "${fallback.name}" (on-failure)`, 'mdRunbook.retryStep', cellRef(fallback.cell)));
    if (vscode.workspace.getConfiguration(SECTION).get<string>('ai.provider', 'off') !== 'off') {
      items.push(item('$(sparkle) Explain', 'Ask the assistant why it failed', 'mdRunbook.ai.explainOutput', [cell]));
      items.push(item('$(lightbulb) Suggest a Fix', 'Ask the assistant for a fix, added after this step as a proposal to approve', 'mdRunbook.ai.suggestFix', [cell]));
    }
    items.forEach((i, n) => (i.priority = 900 - n));
    return items;
  }
}

/** Run cells `start` up to (not including) `end` of `nb`, bringing it to front for the kernel. */
async function runRange(context: vscode.ExtensionContext, nb: vscode.NotebookDocument, start: number, end: number): Promise<void> {
  await showRunbook(nb, start);
  await selectRunbookKernel(context, nb);
  await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start, end: Math.min(end, nb.cellCount) }], document: nb.uri });
}

export function registerFailedActions(context: vscode.ExtensionContext): void {
  const actions = new FailedActions();
  context.subscriptions.push(
    actions.changed,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, actions),
    // A run starting or ending changes them (the outputs change then).
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.notebookType === NOTEBOOK_TYPE && e.cellChanges.some((c) => c.outputs !== undefined || c.executionSummary !== undefined)) actions.changed.fire();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.ai.provider`)) actions.changed.fire();
    }),
    vscode.commands.registerCommand('mdRunbook.retryStep', async (uri?: unknown, index?: unknown) => {
      const cell = cellOf(uri, index);
      if (cell) await runRange(context, cell.notebook, cell.index, cell.index + 1);
    }),
    vscode.commands.registerCommand('mdRunbook.resumeFromHere', async (uri?: unknown, index?: unknown) => {
      const cell = cellOf(uri, index);
      if (cell) await runRange(context, cell.notebook, cell.index, cell.notebook.cellCount);
    }),
  );
}

/**
 * A failed step's next moves, where it failed: on its status line, Retry (this step again),
 * Resume from Here (this step and the ones after), Mark Done (done by hand instead) and, with the
 * assistant on, Explain. Only on the step that failed, and not while anything runs.
 */

import * as vscode from 'vscode';
import { stepState } from '@md-runbook/core/progress';
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
    if (vscode.workspace.getConfiguration(SECTION).get<string>('ai.provider', 'off') !== 'off') {
      items.push(item('$(sparkle) Explain', 'Ask the assistant why it failed', 'mdRunbook.ai.explainOutput', [cell]));
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

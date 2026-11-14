/**
 * A cell that waits for the reader: a value asked in VS Code's input box (which opens at the top
 * of the window, far from the cell, and extensions can't move it) or a confirmation. While it
 * waits, the cell's status line and the runbook's status bar item say so, so a run that seems
 * slow reads as "your turn" instead.
 */

import * as vscode from 'vscode';
import { NOTEBOOK_TYPE } from './serializer';

interface Waiting {
  cell: vscode.NotebookCell;
  /** What is asked, e.g. "parameter NAMESPACE". */
  what: string;
}

const waiting = new Map<string, Waiting>();
const changed = new vscode.EventEmitter<void>();
export const onDidChangeWaiting = changed.event;

const keyOf = (cell: vscode.NotebookCell): string => cell.document.uri.toString();

/** What `cell` waits for, if anything. */
export function waitingFor(cell: vscode.NotebookCell): string | undefined {
  return waiting.get(keyOf(cell))?.what;
}

/** The first cell of `nb` that waits for the reader. */
export function waitingIn(nb: vscode.NotebookDocument): Waiting | undefined {
  for (const w of waiting.values()) if (w.cell.notebook === nb) return w;
  return undefined;
}

/** Run `ask` (a prompt) with `cell` shown as waiting for `what`. */
export async function whileWaiting<T>(cell: vscode.NotebookCell | undefined, what: string, ask: () => Thenable<T>): Promise<T> {
  if (!cell) return ask();
  const key = keyOf(cell);
  const entry = { cell, what };
  waiting.set(key, entry);
  changed.fire();
  try {
    return await ask();
  } finally {
    if (waiting.get(key) === entry) waiting.delete(key);
    changed.fire();
  }
}

/** The text on the waiting cell's status line, and the status bar's. */
export function waitingText(what: string): { cell: string; statusBar: string; tooltip: string } {
  return {
    cell: `$(edit) Waiting for you: ${what} (in the box at the top of the window)`,
    statusBar: `$(edit) Waiting for you: ${what}`,
    tooltip: `The run waits for ${what}: answer in the box at the top of the window (Escape cancels). Click to show the cell.`,
  };
}

class WaitingStatus implements vscode.NotebookCellStatusBarItemProvider {
  readonly onDidChangeCellStatusBarItems = onDidChangeWaiting;

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    const what = waitingFor(cell);
    if (what === undefined) return [];
    const t = waitingText(what);
    const item = new vscode.NotebookCellStatusBarItem(t.cell, vscode.NotebookCellStatusBarAlignment.Left);
    item.tooltip = t.tooltip;
    // Before the estimate and VS Code's own items: it is what the reader must act on.
    item.priority = 1000;
    return [item];
  }
}

export function registerWaiting(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    changed,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, new WaitingStatus()),
    // For tests: what each cell of the active runbook waits for (undefined: nothing).
    vscode.commands.registerCommand('mdRunbook._waiting', () => vscode.window.activeNotebookEditor?.notebook.getCells().map((c) => waitingFor(c))),
  );
}

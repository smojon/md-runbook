/**
 * The cells a run has queued and not reached yet. Their outputs are still the previous run's, so
 * a re-run would count them as done; the estimate counts them as still to do instead
 * (estimates.ts notebookEstimateSteps). The controller marks them when queued and unmarks each
 * once its turn has passed.
 */

import * as vscode from 'vscode';

const queued = new WeakSet<vscode.NotebookCell>();
const changed = new vscode.EventEmitter<void>();
export const onDidChangeQueue = changed.event;

export function markQueued(cells: readonly vscode.NotebookCell[]): void {
  if (cells.length === 0) return;
  for (const c of cells) queued.add(c);
  changed.fire();
}

export function unmarkQueued(cells: readonly vscode.NotebookCell[]): void {
  let any = false;
  for (const c of cells) any = queued.delete(c) || any;
  if (any) changed.fire();
}

export function isQueued(cell: vscode.NotebookCell): boolean {
  return queued.has(cell);
}

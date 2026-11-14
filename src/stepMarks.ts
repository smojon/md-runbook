/**
 * Marks a reader puts on a step for this session, from the Steps view (right-click a row) or the
 * cell's ⋯ menu: **Pause Before This Step** (Run All stops there and asks Continue / Stop on the
 * cell) and **Notify Me When It Starts** (a notification when it starts, once). Also **Run Until
 * Here**: from the first step still to do up to this one. Marks live in memory, per cell; the file
 * never changes.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { isCell, labelOf, notebookProgress, selectRunbookKernel } from './progress';
import { showRunbook } from './currentRunbook';
import { NOTEBOOK_TYPE } from './serializer';
import { askOnCell } from './waiting';

interface Marks {
  pause?: boolean;
  notify?: boolean;
}

const marks = new Map<string, Marks>();
const changed = new vscode.EventEmitter<void>();
/** A mark was set or cleared (the Steps view and the cells' status lines redraw). */
export const onDidChangeMarks = changed.event;

const keyOf = (cell: vscode.NotebookCell): string => cell.document.uri.toString();

export function pausesBefore(cell: vscode.NotebookCell): boolean {
  return marks.get(keyOf(cell))?.pause === true;
}

export function notifiesOnStart(cell: vscode.NotebookCell): boolean {
  return marks.get(keyOf(cell))?.notify === true;
}

function toggle(cell: vscode.NotebookCell, which: keyof Marks): void {
  const m = { ...(marks.get(keyOf(cell)) ?? {}) };
  m[which] = !m[which];
  if (!m.pause && !m.notify) marks.delete(keyOf(cell));
  else marks.set(keyOf(cell), m);
  changed.fire();
}

/**
 * Before a step of a run of several cells: a pause mark stops here and asks on the cell
 * (Continue / Stop). True to go on.
 */
export async function pauseBefore(cell: vscode.NotebookCell): Promise<boolean> {
  if (!pausesBefore(cell)) return true;
  const answer = await askOnCell(cell, `paused before ${labelOf(cell)}`, [
    { id: 'go', label: 'Continue', icon: 'debug-continue', tooltip: 'Runs this step and goes on' },
    { id: 'stop', label: 'Stop', icon: 'debug-stop', tooltip: 'Stops the run here (Resume Run goes on from here)' },
  ]);
  return answer === 'go';
}

/** A step starts: its notify mark says so, once (the mark is then cleared). */
export function stepStarting(cell: vscode.NotebookCell, notify: (title: string, body: string) => void): void {
  if (!notifiesOnStart(cell)) return;
  toggle(cell, 'notify');
  const p = notebookProgress(cell.notebook);
  const step = p.stepOfCell[cell.index];
  const name = path.posix.basename(cell.notebook.uri.path).replace(/\.md$/i, '');
  notify(name, `${step !== undefined ? `Step ${step} of ${p.total}` : `Cell ${cell.index + 1}`} started: ${labelOf(cell)}`);
}

/**
 * The cell a command is about: a cell (the cell ⋯ menu), the Steps view's row context
 * (`{ mdRunbookUri, mdRunbookCell }`), else the selected cell of the runbook in front.
 */
function cellFrom(arg: unknown): vscode.NotebookCell | undefined {
  if (isCell(arg)) return arg;
  const ctx = arg as { mdRunbookUri?: unknown; mdRunbookCell?: unknown } | undefined;
  if (typeof ctx?.mdRunbookUri === 'string' && typeof ctx.mdRunbookCell === 'number') {
    const nb = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === ctx.mdRunbookUri);
    const i = ctx.mdRunbookCell;
    return nb && i >= 0 && i < nb.cellCount ? nb.cellAt(i) : undefined;
  }
  const editor = vscode.window.activeNotebookEditor;
  return editor?.notebook.notebookType === NOTEBOOK_TYPE && editor.notebook.cellCount > 0 ? editor.notebook.cellAt(editor.selection.start) : undefined;
}

class MarkStatus implements vscode.NotebookCellStatusBarItemProvider {
  readonly onDidChangeCellStatusBarItems = onDidChangeMarks;

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    const items: vscode.NotebookCellStatusBarItem[] = [];
    const item = (text: string, tooltip: string, command: string): void => {
      const i = new vscode.NotebookCellStatusBarItem(text, vscode.NotebookCellStatusBarAlignment.Right);
      i.tooltip = tooltip;
      i.command = { title: tooltip, command, arguments: [cell] };
      i.accessibilityInformation = { label: tooltip };
      items.push(i);
    };
    if (pausesBefore(cell)) item('$(debug-pause) Pauses here', 'Run All pauses before this step. Click to remove the pause.', 'mdRunbook.togglePauseBefore');
    if (notifiesOnStart(cell)) item('$(bell) Notifies', 'A notification when this step starts. Click to cancel it.', 'mdRunbook.toggleNotifyOnStart');
    return items;
  }
}

export function registerStepMarks(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    changed,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, new MarkStatus()),
    vscode.commands.registerCommand('mdRunbook.togglePauseBefore', (arg?: unknown) => {
      const cell = cellFrom(arg);
      if (cell?.kind === vscode.NotebookCellKind.Code) toggle(cell, 'pause');
    }),
    vscode.commands.registerCommand('mdRunbook.toggleNotifyOnStart', (arg?: unknown) => {
      const cell = cellFrom(arg);
      if (cell?.kind === vscode.NotebookCellKind.Code) toggle(cell, 'notify');
    }),
    // The same, named for the Steps view's right-click menu when the mark is on.
    vscode.commands.registerCommand('mdRunbook.removePause', (arg?: unknown) => {
      const cell = cellFrom(arg);
      if (cell && pausesBefore(cell)) toggle(cell, 'pause');
    }),
    vscode.commands.registerCommand('mdRunbook.cancelNotify', (arg?: unknown) => {
      const cell = cellFrom(arg);
      if (cell && notifiesOnStart(cell)) toggle(cell, 'notify');
    }),
    // From the first step still to do (else the top) up to and including this one.
    vscode.commands.registerCommand('mdRunbook.runUntilHere', async (arg?: unknown) => {
      const cell = cellFrom(arg);
      if (!cell) return;
      const nb = cell.notebook;
      const first = notebookProgress(nb).resume.find((i) => i <= cell.index) ?? 0;
      await showRunbook(nb, cell.index);
      await selectRunbookKernel(context, nb);
      await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: Math.min(first, cell.index), end: cell.index + 1 }], document: nb.uri });
    }),
    // For tests: the marks of the runbook in front, by cell index.
    vscode.commands.registerCommand('mdRunbook._marks', () =>
      vscode.window.activeNotebookEditor?.notebook.getCells().map((c) => ({ pause: pausesBefore(c), notify: notifiesOnStart(c) })),
    ),
  );
}

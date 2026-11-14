/**
 * A cell that waits for the reader: a value asked in VS Code's input box (which opens at the top
 * of the window, far from the cell, and extensions can't move it) or a confirmation. While it
 * waits, the cell's status line and the runbook's status bar item say so, so a run that seems
 * slow reads as "your turn" instead.
 */

import * as vscode from 'vscode';
import { NOTEBOOK_TYPE } from './serializer';

/** Where the question is: VS Code's input box (top of the window), a dialog (the middle), or buttons on the cell. */
export type WaitingWhere = 'box' | 'dialog' | 'cell';

/** A button on the waiting cell's status line (and its row in the Steps view). */
export interface WaitingAnswer {
  id: string;
  label: string;
  /** A codicon name, e.g. `check`. */
  icon?: string;
  tooltip?: string;
}

interface Waiting {
  cell: vscode.NotebookCell;
  /** What is asked, e.g. "parameter NAMESPACE". */
  what: string;
  where: WaitingWhere;
  /** With where = 'cell': the buttons, and what a click does. */
  answers?: readonly WaitingAnswer[];
  /**
   * Where the buttons show, when not on `cell` itself: a Markdown cell shows its status line only
   * while it's edited, so a checklist item's question shows on the code block that waits after it.
   */
  shownOn?: vscode.NotebookCell;
  answer?: (id: string) => void;
}

const waiting = new Map<string, Waiting>();
const changed = new vscode.EventEmitter<void>();
export const onDidChangeWaiting = changed.event;

const keyOf = (cell: vscode.NotebookCell): string => cell.document.uri.toString();

/** What `cell` waits for, if anything. */
export function waitingFor(cell: vscode.NotebookCell): string | undefined {
  return waiting.get(keyOf(cell))?.what;
}

/** Where the question `cell` waits on is. */
export function waitingWhere(cell: vscode.NotebookCell): WaitingWhere {
  return waiting.get(keyOf(cell))?.where ?? 'box';
}

/** The first cell of `nb` that waits for the reader. */
export function waitingIn(nb: vscode.NotebookDocument): Waiting | undefined {
  for (const w of waiting.values()) if (w.cell.notebook === nb) return w;
  return undefined;
}

/** Run `ask` (a prompt) with `cell` shown as waiting for `what`. */
export async function whileWaiting<T>(cell: vscode.NotebookCell | undefined, what: string, ask: () => Thenable<T>, where: WaitingWhere = 'box'): Promise<T> {
  if (!cell) return ask();
  const key = keyOf(cell);
  const entry = { cell, what, where };
  waiting.set(key, entry);
  changed.fire();
  try {
    return await ask();
  } finally {
    if (waiting.get(key) === entry) waiting.delete(key);
    changed.fire();
  }
}

/** The answers a cell waiting on its own buttons offers (none for a prompt or a dialog). */
export function waitingAnswers(cell: vscode.NotebookCell): readonly WaitingAnswer[] {
  return waiting.get(keyOf(cell))?.answers ?? [];
}

/**
 * Ask on the cell itself, not in a dialog: its status line (and its Steps row) shows `what` with
 * `answers` as buttons, and the window stays free (a step done by hand needs it). Resolves with
 * the id clicked, or undefined when `token` is cancelled or `settle` ends it (e.g. the box ticked).
 */
export function askOnCell(
  cell: vscode.NotebookCell,
  what: string,
  answers: readonly WaitingAnswer[],
  settle?: (answer: (id: string | undefined) => void) => vscode.Disposable | undefined,
  token?: vscode.CancellationToken,
  shownOn?: vscode.NotebookCell,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const key = keyOf(cell);
    const subs: vscode.Disposable[] = [];
    const done = (id: string | undefined): void => {
      if (waiting.get(key) !== entry) return;
      waiting.delete(key);
      subs.forEach((s) => s.dispose());
      changed.fire();
      resolve(id);
    };
    const entry: Waiting = { cell, what, where: 'cell', answers, answer: done, ...(shownOn ? { shownOn } : {}) };
    waiting.set(key, entry);
    const s = settle?.(done);
    if (s) subs.push(s);
    if (token) subs.push(token.onCancellationRequested(() => done(undefined)));
    changed.fire();
  });
}

/** A click on one of a waiting cell's buttons (`cellUri`: the cell's document URI). */
export function answerWaiting(cellUri: string, id: string): boolean {
  const w = waiting.get(cellUri);
  if (!w?.answer || !w.answers?.some((a) => a.id === id)) return false;
  w.answer(id);
  return true;
}

/** The text on the waiting cell's status line, and the status bar's. */
export function waitingText(what: string, where: WaitingWhere = 'box'): { cell: string; statusBar: string; tooltip: string } {
  if (where === 'cell') {
    return {
      cell: `$(edit) Waiting for you: ${what}`,
      statusBar: `$(edit) Waiting for you: ${what}`,
      tooltip: `The run waits for you: ${what}. Answer with the buttons on the cell or in the Steps view. Click to show the cell.`,
    };
  }
  const place = where === 'box' ? 'in the box at the top of the window' : 'in the dialog';
  return {
    cell: `$(edit) Waiting for you: ${what} (${place})`,
    statusBar: `$(edit) Waiting for you: ${what}`,
    tooltip: `The run waits for ${what}: answer ${place} (Escape cancels). Click to show the cell.`,
  };
}

class WaitingStatus implements vscode.NotebookCellStatusBarItemProvider {
  readonly onDidChangeCellStatusBarItems = onDidChangeWaiting;

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    // Its own question, else one shown on it for another cell (a checklist item above it).
    const w = waiting.get(keyOf(cell)) ?? [...waiting.values()].find((x) => x.shownOn && keyOf(x.shownOn) === keyOf(cell));
    if (!w || (w.shownOn && keyOf(w.shownOn) !== keyOf(cell))) return [];
    const t = waitingText(w.what, w.where);
    const item = new vscode.NotebookCellStatusBarItem(t.cell, vscode.NotebookCellStatusBarAlignment.Left);
    item.tooltip = t.tooltip;
    // Before the estimate and VS Code's own items: it is what the reader must act on.
    item.priority = 1000;
    // The answers as buttons right after it, in order.
    const buttons = (w.answers ?? []).map((a, i) => {
      const b = new vscode.NotebookCellStatusBarItem(`${a.icon ? `$(${a.icon}) ` : ''}${a.label}`, vscode.NotebookCellStatusBarAlignment.Left);
      b.tooltip = a.tooltip ?? a.label;
      b.priority = 999 - i;
      b.command = { title: a.label, command: 'mdRunbook.answerWaiting', arguments: [w.cell.document.uri.toString(), a.id] };
      b.accessibilityInformation = { label: `${a.label}: ${w.what}` };
      return b;
    });
    return [item, ...buttons];
  }
}

export function registerWaiting(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    changed,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, new WaitingStatus()),
    // A button on a waiting cell (its status line, the Steps view, a notification): answers it.
    vscode.commands.registerCommand('mdRunbook.answerWaiting', (cellUri?: unknown, id?: unknown) => {
      if (typeof cellUri === 'string' && typeof id === 'string') return answerWaiting(cellUri, id);
      return false;
    }),
    // For tests: every question asked on a cell's buttons, in any runbook.
    vscode.commands.registerCommand('mdRunbook._waitingAnswers', () =>
      [...waiting.values()].filter((w) => w.answers).map((w) => ({ cell: w.cell.document.uri.toString(), index: w.cell.index, what: w.what, answers: w.answers!.map((a) => a.id) })),
    ),
    // For tests: what each cell of the active runbook waits for (undefined: nothing).
    vscode.commands.registerCommand('mdRunbook._waiting', () => vscode.window.activeNotebookEditor?.notebook.getCells().map((c) => waitingFor(c))),
  );
}

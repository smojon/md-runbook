/**
 * The runbook the progress surfaces follow (the status bar item, the Steps view): the runbook in
 * front, else one that runs or waits for you, else the last one in front. So a run stays on
 * screen while you read another file, and coming back finds it where it was.
 */

import * as vscode from 'vscode';
import { anyRunning } from './estimates';
import { NOTEBOOK_TYPE } from './serializer';
import { onDidChangeWaiting, waitingIn } from './waiting';

let last: vscode.NotebookDocument | undefined;
const changed = new vscode.EventEmitter<void>();
/** The current runbook may have changed (another editor in front, a run started or ended elsewhere). */
export const onDidChangeCurrentRunbook = changed.event;

const isRunbook = (nb: vscode.NotebookDocument | undefined): nb is vscode.NotebookDocument => nb?.notebookType === NOTEBOOK_TYPE && !nb.isClosed;

export function currentRunbook(): vscode.NotebookDocument | undefined {
  const active = vscode.window.activeNotebookEditor?.notebook;
  if (isRunbook(active)) return active;
  const busy = vscode.workspace.notebookDocuments.filter(isRunbook);
  return busy.find((nb) => waitingIn(nb) !== undefined) ?? busy.find((nb) => anyRunning(nb)) ?? (isRunbook(last) ? last : undefined);
}

/** `nb` is the editor in front (the status bar then needn't name it). */
export function inFront(nb: vscode.NotebookDocument): boolean {
  return vscode.window.activeNotebookEditor?.notebook === nb;
}

/** A visible editor of `nb`, else none (it's open in a tab behind, or not open). */
export function editorOf(nb: vscode.NotebookDocument): vscode.NotebookEditor | undefined {
  const editors = [vscode.window.activeNotebookEditor, ...vscode.window.visibleNotebookEditors];
  return editors.find((e) => e?.notebook === nb);
}

/** Show `nb` (bringing its tab to front, or opening it), with cell `index` selected and in view. */
export async function showRunbook(nb: vscode.NotebookDocument, index?: number): Promise<vscode.NotebookEditor> {
  const editor = await vscode.window.showNotebookDocument(nb, { preserveFocus: false });
  if (index !== undefined && index >= 0 && index < nb.cellCount) {
    const range = new vscode.NotebookRange(index, index + 1);
    editor.selections = [range];
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
  }
  return editor;
}

export function registerCurrentRunbook(context: vscode.ExtensionContext): void {
  const remember = (): void => {
    const nb = vscode.window.activeNotebookEditor?.notebook;
    if (isRunbook(nb)) last = nb;
    changed.fire();
  };
  remember();
  context.subscriptions.push(
    changed,
    vscode.window.onDidChangeActiveNotebookEditor(remember),
    onDidChangeWaiting(() => changed.fire()),
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      if (nb === last) last = undefined;
      changed.fire();
    }),
    // Shows the runbook (a click on the status bar item while another file is in front).
    vscode.commands.registerCommand('mdRunbook._showRunbook', async (uri?: unknown) => {
      const nb = typeof uri === 'string' ? vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri) : currentRunbook();
      if (nb) await showRunbook(nb);
    }),
  );
}

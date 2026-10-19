/**
 * Clickable task-list checkboxes in Markdown cells. The notebook renderer (renderer/index.ts)
 * draws them and sends a message on click; this flips the `[ ]` / `[x]` in the cell's source.
 */

import * as vscode from 'vscode';
import type { ToggleMessage } from '../renderer/taskListPlugin';
import { taskItemAtLine } from '@md-runbook/core';
import { NOTEBOOK_TYPE } from './serializer';

export const TASK_RENDERER_ID = 'md-runbook.taskLists';

const normalize = (s: string): string => s.replace(/\r\n/g, '\n');

function isToggle(m: unknown): m is ToggleMessage {
  const t = m as Partial<ToggleMessage> | null;
  return (
    typeof t === 'object' && t !== null && t.type === 'toggleTask' && typeof t.text === 'string' &&
    Number.isInteger(t.line) && typeof t.checked === 'boolean'
  );
}

export function registerTaskLists(context: vscode.ExtensionContext): void {
  const messaging = vscode.notebooks.createRendererMessaging(TASK_RENDERER_ID);
  context.subscriptions.push(
    // The webview renders the Markdown with its HTML, so a message can only be trusted to flip one
    // task box of a Markdown cell in the notebook it came from; nothing else is done with it.
    messaging.onDidReceiveMessage(async ({ editor, message }) => {
      if (editor.notebook.notebookType !== NOTEBOOK_TYPE || !isToggle(message)) return;
      const text = normalize(message.text);
      const cells = editor.notebook
        .getCells()
        .filter((c) => c.kind === vscode.NotebookCellKind.Markup && normalize(c.document.getText()) === text);
      if (cells.length !== 1) {
        void vscode.window.showInformationMessage(
          cells.length > 1
            ? 'md-runbook: several Markdown cells have the same text, so the checkbox cannot be ticked by clicking. Edit the cell instead.'
            : 'md-runbook: the cell changed since it was shown, so the checkbox was not ticked. Click it again.',
        );
        return;
      }
      const cell = cells[0]!;
      const item = taskItemAtLine(cell.document.getText(), message.line);
      if (!item || item.checked === message.checked) return;
      await setTaskBox(cell, item.offset, message.checked);
    }),
  );
}

/**
 * Tick or untick the task box whose character is at `offset` in a Markdown cell, and redraw it.
 * VS Code only re-renders a Markdown cell on a text edit once the cell has been opened in an
 * editor, but always on a metadata update: setting the same metadata again redraws it without
 * adding an undo step or marking the notebook dirty.
 */
export async function setTaskBox(cell: vscode.NotebookCell, offset: number, checked: boolean): Promise<void> {
  const doc = cell.document;
  const at = doc.positionAt(offset);
  const text = new vscode.WorkspaceEdit();
  text.replace(doc.uri, new vscode.Range(at, at.translate(0, 1)), checked ? 'x' : ' ');
  if (!(await vscode.workspace.applyEdit(text))) return;
  const redraw = new vscode.WorkspaceEdit();
  redraw.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, cell.metadata)]);
  await vscode.workspace.applyEdit(redraw);
}

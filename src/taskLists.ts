/**
 * Clickable task-list checkboxes in Markdown cells. The notebook renderer (renderer/index.ts)
 * draws them and sends a message on click; this flips the `[ ]` / `[x]` in the cell's source.
 */

import * as vscode from 'vscode';
import type { ToggleMessage } from '../renderer/taskListPlugin';
import { taskItemAtLine } from './core';
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
        if (cells.length > 1) {
          void vscode.window.showInformationMessage(
            'md-runbook: several Markdown cells have the same text, so the checkbox cannot be ticked by clicking. Edit the cell instead.',
          );
        }
        return;
      }
      const doc = cells[0]!.document;
      const item = taskItemAtLine(doc.getText(), message.line);
      if (!item || item.checked === message.checked) return;
      const edit = new vscode.WorkspaceEdit();
      const at = doc.positionAt(item.offset);
      edit.replace(doc.uri, new vscode.Range(at, at.translate(0, 1)), message.checked ? 'x' : ' ');
      await vscode.workspace.applyEdit(edit);
    }),
  );
}

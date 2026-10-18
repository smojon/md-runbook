import * as vscode from 'vscode';
import { NOTEBOOK_TYPE, RunbookSerializer } from './serializer';

function targetUri(uri: unknown): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri) return uri;
  return vscode.window.activeTextEditor?.document.uri ?? vscode.window.activeNotebookEditor?.notebook.uri;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new RunbookSerializer(), {
      transientOutputs: false,
      transientCellMetadata: {},
      transientDocumentMetadata: {},
    }),
    vscode.commands.registerCommand('mdRunbook.openAsRunbook', async (uri?: unknown) => {
      const target = targetUri(uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, NOTEBOOK_TYPE);
    }),
    vscode.commands.registerCommand('mdRunbook.openAsText', async (uri?: unknown) => {
      const target = targetUri(uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
  );
}

export function deactivate(): void {}

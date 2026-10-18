/** Getting started: the walkthrough's Open Sample Runbook command. */

import * as vscode from 'vscode';
import { NOTEBOOK_TYPE, RunbookSerializer } from './serializer';

export function registerWalkthrough(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mdRunbook.openSample', async () => {
      // Untitled, so running it never writes into the extension's folder; Save As keeps a copy.
      const uri = vscode.Uri.joinPath(context.extensionUri, 'examples', 'sample.runbook.md');
      const data = await new RunbookSerializer().deserializeNotebook(await vscode.workspace.fs.readFile(uri));
      const nb = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
      await vscode.window.showNotebookDocument(nb);
    }),
  );
}

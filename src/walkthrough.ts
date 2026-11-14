/** Getting started: the walkthrough's Open Sample Runbook command, and Get Started (the walkthrough itself). */

import * as vscode from 'vscode';
import { isTestMode } from './secrets';
import { NOTEBOOK_TYPE, RunbookSerializer } from './serializer';

/** Open an example shipped with the extension, untitled: running it never writes into the extension's folder; Save As keeps a copy. */
async function openExample(context: vscode.ExtensionContext, name: string): Promise<void> {
  const uri = vscode.Uri.joinPath(context.extensionUri, 'examples', name);
  const data = await new RunbookSerializer().deserializeNotebook(await vscode.workspace.fs.readFile(uri));
  const nb = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
  await vscode.window.showNotebookDocument(nb);
}

export function registerWalkthrough(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // A short tour (six steps, under a minute), with the Steps view beside it.
    vscode.commands.registerCommand('mdRunbook.openSample', async () => {
      await openExample(context, 'quickstart.runbook.md');
      if (!isTestMode(context)) {
        await vscode.commands.executeCommand('mdRunbook.steps.focus');
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      }
    }),
    // Every feature, one section each (the old sample).
    vscode.commands.registerCommand('mdRunbook.openFeatureTour', () => openExample(context, 'sample.runbook.md')),
    // Every action with when it matters (docs/cheatsheet.md, shipped with the extension).
    vscode.commands.registerCommand('mdRunbook.openCheatSheet', () =>
      vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'docs', 'cheatsheet.md')),
    ),
    // The Get Started page, from the toolbar's Help menu (menus can't pass the walkthrough's id).
    vscode.commands.registerCommand('mdRunbook.getStarted', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#gettingStarted`, false),
    ),
  );
}

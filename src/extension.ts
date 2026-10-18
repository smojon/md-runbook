import * as vscode from 'vscode';
import { clearOutputBlocks } from './core';
import { RunbookController } from './controller';
import { RunPipeline } from './pipeline';
import { registerSafety } from './safety';
import { NOTEBOOK_TYPE, RunbookSerializer } from './serializer';

function targetUri(uri: unknown): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri) return uri;
  return vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

async function clearAllOutputs(uri?: unknown): Promise<void> {
  const target = targetUri(uri);
  if (!target) return;

  const notebook = vscode.workspace.notebookDocuments.find(
    (d) => d.notebookType === NOTEBOOK_TYPE && d.uri.toString() === target.toString(),
  );
  if (notebook) {
    await vscode.window.showNotebookDocument(notebook);
    await vscode.commands.executeCommand('notebook.clearAllCellsOutputs');
    if (!notebook.isUntitled) await notebook.save();
    return;
  }

  const textDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
  if (textDoc) {
    // Open as text: edit through the editor so unsaved changes and undo are kept.
    const cleared = clearOutputBlocks(textDoc.getText());
    if (cleared === textDoc.getText()) return void vscode.window.showInformationMessage('md-runbook: no output blocks found.');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(target, new vscode.Range(textDoc.positionAt(0), textDoc.positionAt(textDoc.getText().length)), cleared);
    await vscode.workspace.applyEdit(edit);
    await textDoc.save();
    return;
  }

  // Not open: rewrite the bytes directly, so line endings stay exactly as they were.
  const text = decoder.decode(await vscode.workspace.fs.readFile(target));
  const cleared = clearOutputBlocks(text);
  if (cleared === text) return void vscode.window.showInformationMessage('md-runbook: no output blocks found.');
  await vscode.workspace.fs.writeFile(target, encoder.encode(cleared));
}

export function activate(context: vscode.ExtensionContext): void {
  const pipeline = new RunPipeline();
  // Feature modules register preparers/observers/executor on `pipeline` here.
  registerSafety(context, pipeline);
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new RunbookSerializer(), {
      transientOutputs: false,
      transientCellMetadata: {},
      transientDocumentMetadata: {},
    }),
    new RunbookController(pipeline),
    vscode.commands.registerCommand('mdRunbook.openAsRunbook', async (uri?: unknown) => {
      const target = targetUri(uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, NOTEBOOK_TYPE);
    }),
    vscode.commands.registerCommand('mdRunbook.openAsText', async (uri?: unknown) => {
      const target = targetUri(uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
    vscode.commands.registerCommand('mdRunbook.clearAllOutputs', clearAllOutputs),
  );
}

export function deactivate(): void {}

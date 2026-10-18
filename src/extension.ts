import * as vscode from 'vscode';
import { registerAi } from './ai/commands';
import { registerApproval } from './approval';
import { registerAiContext } from './aiCommands';
import { registerCodeLens } from './codeLens';
import { clearOutputBlocks } from './core';
import { RunbookController } from './controller';
import { registerReport } from './exportReport';
import { registerHistory } from './history';
import { RunPipeline } from './pipeline';
import { registerProgress } from './progress';
import { registerSafety } from './safety';
import { registerSecrets } from './secrets';
import { NOTEBOOK_TYPE, RunbookSerializer } from './serializer';
import { registerSessions } from './session';
import { registerTaskLists } from './taskLists';
import { registerTerminal } from './terminal';

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
  // Feature modules register preparers/observers/executor on `pipeline` here. Preparers run in
  // registration order: the approval gate first, so proposed cells never prompt for anything;
  // then safety (cell options, confirmation when no context is recorded), so skipped or declined
  // cells never prompt for secrets.
  const approval = registerApproval(context, pipeline);
  const safety = registerSafety(context, pipeline);
  registerSecrets(context, pipeline);
  registerHistory(context, pipeline);
  registerSessions(context, pipeline);
  registerTerminal(context, pipeline);
  // Read-only credentials of AI-proposed cells win over cell options and secrets.
  pipeline.preparers.push(approval.credentials);
  // Last, once the environment is final: record the context (cluster, ...) the cell really runs
  // against, and ask for a pending confirmation showing it.
  pipeline.preparers.push(safety.final);
  const controller = new RunbookController(pipeline);
  registerProgress(context, pipeline, controller);
  registerCodeLens(context);
  registerReport(context);
  registerAi(context);
  registerAiContext(context);
  registerTaskLists(context);
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new RunbookSerializer(), {
      transientOutputs: false,
      transientCellMetadata: {},
      transientDocumentMetadata: {},
    }),
    controller,
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

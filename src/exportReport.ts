/** "Export Report (HTML)": a runbook and its stored outputs as one self-contained HTML file. */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { CellInput, renderReport, serialize } from './core';
import { confirmNoLeaks } from './aiCommands';
import { SECTION, writeOptions } from './config';
import { META_KEY, toOutputInput } from './outputs';
import { NOTEBOOK_TYPE } from './serializer';

export const EXPORT_REPORT = 'mdRunbook.exportReport';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const nb = vscode.window.activeNotebookEditor?.notebook;
  if (nb?.notebookType === NOTEBOOK_TYPE) return nb.uri;
  const doc = vscode.window.activeTextEditor?.document;
  return doc?.languageId === 'markdown' ? doc.uri : undefined;
}

/** The Markdown as it would be saved now: an open runbook's live outputs, an open editor's unsaved text, or the file. */
async function currentText(uri: vscode.Uri): Promise<string> {
  const key = uri.toString();
  const nb = vscode.workspace.notebookDocuments.find((d) => d.notebookType === NOTEBOOK_TYPE && d.uri.toString() === key);
  if (nb) {
    const cells: CellInput[] = nb.getCells().map((c) => {
      const code = c.kind === vscode.NotebookCellKind.Code;
      return {
        kind: code ? 'code' : 'markup',
        value: c.document.getText(),
        languageId: c.document.languageId,
        meta: c.metadata?.[META_KEY],
        output: code ? toOutputInput(c.outputs) : undefined,
      };
    });
    return serialize(nb.metadata?.[META_KEY], cells, writeOptions());
  }
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (doc) return doc.getText();
  return decoder.decode(await vscode.workspace.fs.readFile(uri));
}

/** `mdRunbook.report.folder`: empty = next to the .md; relative = against the workspace folder (or the .md's folder). */
function reportFolder(uri: vscode.Uri): vscode.Uri {
  const dir = vscode.Uri.joinPath(uri, '..');
  const setting = vscode.workspace.getConfiguration(SECTION, uri).get<string>('report.folder', '').trim();
  if (setting === '') return dir;
  if (path.isAbsolute(setting)) return vscode.Uri.file(setting);
  const base = vscode.workspace.getWorkspaceFolder(uri)?.uri ?? dir;
  return vscode.Uri.joinPath(base, ...setting.split(/[\\/]+/).filter(Boolean));
}

/** Write the report and offer to open it. Resolves to the report's URI. */
export async function exportReport(arg?: unknown): Promise<vscode.Uri | undefined> {
  const uri = targetUri(arg);
  if (!uri) {
    void vscode.window.showInformationMessage('md-runbook: open a Markdown file or runbook to export a report.');
    return undefined;
  }
  if (uri.scheme === 'untitled') {
    void vscode.window.showWarningMessage('md-runbook: save the file before exporting a report.');
    return undefined;
  }
  const name = path.posix.basename(uri.path);
  const text = await currentText(uri);
  if (!(await confirmNoLeaks(text, 'Export'))) return undefined;
  const html = renderReport(text, { generatedAt: new Date(), fallbackTitle: name, redact: writeOptions().redact });
  const folder = reportFolder(uri);
  await vscode.workspace.fs.createDirectory(folder);
  const out = vscode.Uri.joinPath(folder, name.replace(/\.(md|markdown)$/i, '') + '.report.html');
  await vscode.workspace.fs.writeFile(out, new TextEncoder().encode(html));
  void vscode.window.showInformationMessage(`md-runbook: report written to ${vscode.workspace.asRelativePath(out)}`, 'Open').then((choice) => {
    if (choice === 'Open') void vscode.env.openExternal(out);
  });
  return out;
}

export function registerReport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(EXPORT_REPORT, exportReport));
}

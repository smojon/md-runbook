/**
 * "Export Report (HTML)": a runbook and its stored outputs as one self-contained HTML file.
 * "Export Report (PDF)": the same report printed by an installed Chrome, Edge or Chromium.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { findBrowser, htmlToPdf } from './cli/pdf';
import { recordJson, renderReport } from '@md-runbook/core';
import { confirmNoLeaks } from './aiCommands';
import { SECTION, writeOptions } from './config';
import { NOTEBOOK_TYPE, notebookTextWithOutputs } from './serializer';

export const EXPORT_REPORT = 'mdRunbook.exportReport';
export const EXPORT_REPORT_PDF = 'mdRunbook.exportReportPdf';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const nb = vscode.window.activeNotebookEditor?.notebook;
  if (nb?.notebookType === NOTEBOOK_TYPE) return nb.uri;
  const doc = vscode.window.activeTextEditor?.document;
  return doc?.languageId === 'markdown' ? doc.uri : undefined;
}

/** The Markdown as it would be saved now (outputs always included): an open runbook's live outputs, an open editor's unsaved text, or the file. */
async function currentText(uri: vscode.Uri): Promise<string> {
  const key = uri.toString();
  const nb = vscode.workspace.notebookDocuments.find((d) => d.notebookType === NOTEBOOK_TYPE && d.uri.toString() === key);
  if (nb) {
    return notebookTextWithOutputs(nb);
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

/** The report of the runbook a command applies to, and where to write it (`<name>.report.<ext>`). */
async function prepareReport(arg: unknown, ext: 'html' | 'pdf'): Promise<{ html: string; out: vscode.Uri } | undefined> {
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
  return { html, out: vscode.Uri.joinPath(folder, name.replace(/\.(md|markdown)$/i, '') + `.report.${ext}`) };
}

function offerToOpen(out: vscode.Uri): void {
  void vscode.window.showInformationMessage(`md-runbook: report written to ${vscode.workspace.asRelativePath(out)}`, 'Open').then((choice) => {
    if (choice === 'Open') void vscode.env.openExternal(out);
  });
}

/** Write the report and offer to open it. Resolves to the report's URI. */
export async function exportReport(arg?: unknown): Promise<vscode.Uri | undefined> {
  const r = await prepareReport(arg, 'html');
  if (!r) return undefined;
  await vscode.workspace.fs.writeFile(r.out, new TextEncoder().encode(r.html));
  offerToOpen(r.out);
  return r.out;
}

/** Print the report to PDF with an installed Chromium-based browser. Resolves to the PDF's URI. */
export async function exportReportPdf(arg?: unknown): Promise<vscode.Uri | undefined> {
  const configured = vscode.workspace.getConfiguration(SECTION).get<string>('report.browserPath', '').trim();
  const browser = findBrowser(configured || undefined);
  if (!browser) {
    void vscode.window.showWarningMessage(
      'md-runbook: Export Report (PDF) needs Google Chrome, Microsoft Edge or Chromium. Install one, or set mdRunbook.report.browserPath. Export Report (HTML) works without it.',
    );
    return undefined;
  }
  const r = await prepareReport(arg, 'pdf');
  if (!r) return undefined;
  if (r.out.scheme !== 'file') {
    void vscode.window.showWarningMessage('md-runbook: PDF reports can only be written to a local folder; use Export Report (HTML) here.');
    return undefined;
  }
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'md-runbook: printing the report to PDF…' }, () =>
      htmlToPdf(r.html, r.out.fsPath, browser),
    );
  } catch (e) {
    void vscode.window.showErrorMessage(`md-runbook: PDF export failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  offerToOpen(r.out);
  return r.out;
}

/**
 * Export Run Record (JSON): the timeline, its summary and the record's signature (core
 * recordJson), for audit and ticket tools, as `<name>.record.json` where reports go.
 */
export async function exportRecordJson(arg?: unknown): Promise<vscode.Uri | undefined> {
  const uri = targetUri(arg);
  if (!uri) return void vscode.window.showInformationMessage('md-runbook: open a runbook to export its run record.');
  if (uri.scheme === 'untitled') return void vscode.window.showWarningMessage('md-runbook: save the file before exporting its run record.');
  const name = path.posix.basename(uri.path);
  const text = await currentText(uri);
  if (!(await confirmNoLeaks(text, 'Export'))) return undefined;
  const folder = reportFolder(uri);
  await vscode.workspace.fs.createDirectory(folder);
  const out = vscode.Uri.joinPath(folder, name.replace(/\.(md|markdown)$/i, '') + '.record.json');
  await vscode.workspace.fs.writeFile(out, new TextEncoder().encode(recordJson(text, { file: name, generatedAt: new Date(), redact: writeOptions().redact })));
  void vscode.window.showInformationMessage(`md-runbook: run record written to ${vscode.workspace.asRelativePath(out)}`, 'Open').then((choice) => {
    if (choice === 'Open') void vscode.commands.executeCommand('vscode.open', out);
  });
  return out;
}

export function registerReport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(EXPORT_REPORT, exportReport),
    vscode.commands.registerCommand(EXPORT_REPORT_PDF, exportReportPdf),
    vscode.commands.registerCommand('mdRunbook.exportRecordJson', exportRecordJson),
  );
}

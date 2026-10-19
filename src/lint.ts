/**
 * Problem markers for runbooks (`mdRunbook.lint.enabled`): the checks of `md-runbook lint`,
 * shown while you edit, in the runbook view and in the plain Markdown editor.
 */

import * as vscode from 'vscode';
import { SECTION } from './config';
import { LintProblem, lintRunbook } from './core/lint';
import { NOTEBOOK_TYPE, notebookTextWithOutputs } from './serializer';

const DELAY_MS = 300;

function toDiagnostic(p: LintProblem, range: vscode.Range, prefix = ''): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, prefix + p.message, p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
  d.source = 'md-runbook';
  return d;
}

const lineRange = (doc: vscode.TextDocument, line: number): vscode.Range => {
  const l = doc.lineAt(Math.min(Math.max(line, 0), Math.max(doc.lineCount - 1, 0)));
  return new vscode.Range(l.range.start.translate(0, l.firstNonWhitespaceCharacterIndex), l.range.end);
};

export function registerLint(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('md-runbook');
  const enabled = (): boolean => vscode.workspace.getConfiguration(SECTION).get<boolean>('lint.enabled', true);
  /** Cell documents that got markers, per notebook, so they can be cleared. */
  const notebookUris = new Map<string, vscode.Uri[]>();
  const timers = new Map<string, NodeJS.Timeout>();

  const clearNotebook = (nb: vscode.NotebookDocument): void => {
    for (const uri of notebookUris.get(nb.uri.toString()) ?? []) collection.delete(uri);
    notebookUris.delete(nb.uri.toString());
  };

  const lintNotebook = (nb: vscode.NotebookDocument): void => {
    clearNotebook(nb);
    if (!enabled() || nb.isClosed) return;
    const byCell = new Map<number, vscode.Diagnostic[]>();
    for (const p of lintRunbook(notebookTextWithOutputs(nb))) {
      // Problems in a code block go on its cell; front matter problems on the first cell.
      const index = p.cell?.index ?? 0;
      if (index >= nb.cellCount) continue;
      const doc = nb.cellAt(index).document;
      // Fence options are not part of the cell's text: mark its first line.
      const d =
        p.cell === undefined
          ? toDiagnostic(p, lineRange(doc, p.line))
          : p.cell.sourceLine === undefined
            ? toDiagnostic(p, lineRange(doc, 0), 'cell options: ')
            : toDiagnostic(p, lineRange(doc, p.cell.sourceLine));
      byCell.set(index, [...(byCell.get(index) ?? []), d]);
    }
    const uris: vscode.Uri[] = [];
    for (const [index, ds] of byCell) {
      const uri = nb.cellAt(index).document.uri;
      collection.set(uri, ds);
      uris.push(uri);
    }
    notebookUris.set(nb.uri.toString(), uris);
  };

  const lintText = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== 'markdown' || doc.uri.scheme === 'vscode-notebook-cell') return;
    if (!enabled()) return void collection.delete(doc.uri);
    collection.set(doc.uri, lintRunbook(doc.getText()).map((p) => toDiagnostic(p, lineRange(doc, p.line))));
  };

  const later = (key: string, fn: () => void): void => {
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn();
      }, DELAY_MS),
    );
  };
  const isRunbook = (nb: vscode.NotebookDocument): boolean => nb.notebookType === NOTEBOOK_TYPE;
  const all = (): void => {
    for (const nb of vscode.workspace.notebookDocuments) if (isRunbook(nb)) lintNotebook(nb);
    for (const doc of vscode.workspace.textDocuments) lintText(doc);
  };

  context.subscriptions.push(
    collection,
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    vscode.workspace.onDidOpenNotebookDocument((nb) => isRunbook(nb) && lintNotebook(nb)),
    vscode.workspace.onDidChangeNotebookDocument((e) => isRunbook(e.notebook) && later(e.notebook.uri.toString(), () => lintNotebook(e.notebook))),
    vscode.workspace.onDidCloseNotebookDocument((nb) => isRunbook(nb) && clearNotebook(nb)),
    vscode.workspace.onDidOpenTextDocument(lintText),
    vscode.workspace.onDidChangeTextDocument((e) => e.document.languageId === 'markdown' && later(e.document.uri.toString(), () => lintText(e.document))),
    vscode.workspace.onDidCloseTextDocument((doc) => doc.uri.scheme !== 'vscode-notebook-cell' && collection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.lint.enabled`)) all();
    }),
    // For tests: the markers of a document.
    vscode.commands.registerCommand('mdRunbook._diagnostics', (uri: vscode.Uri) => collection.get(uri)?.map((d) => d.message) ?? []),
  );
  all();
}

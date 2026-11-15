/**
 * Problem markers for runbooks (`mdRunbook.lint.enabled`): the checks of `md-runbook lint`,
 * shown while you edit, in the runbook view and in the plain Markdown editor. Prose findings
 * show as `mdRunbook.lint.prose` says (lintLevel.ts).
 */

import * as vscode from 'vscode';
import { LintOptions } from '@md-runbook/core/lint';
import { matchRunbooks, runbookReader } from '@md-runbook/core/node';
import { SECTION } from './config';
import { isCodeMeta } from '@md-runbook/core';
import { renameInfoOption } from '@md-runbook/core/cellOptions';
import { LintProblem, lintRunbook, suggestOption } from '@md-runbook/core/lint';
import { withInfo } from '@md-runbook/core/proposal';
import { META_KEY } from './outputs';
import { neverRanCells, onDidChangeRuns, runsKeyOf } from './runs';
import { NOTEBOOK_TYPE, notebookTextWithOutputs } from './serializer';
import { timed } from './timings';
import { MarkerLevel, markerLevel, proseSetting } from './lintLevel';

const DELAY_MS = 300;
/** The diagnostic code of an unknown option that looks like a typo (a Quick Fix renames it). */
const TYPO_CODE = 'unknown-cell-option';
/** Its fix, read back from the message: the code action gets copies of the diagnostics, without extra fields. */
const TYPO_RE = /unknown cell option "([^"]+)" \(ignored\): did you mean "([^"]+)"\?/;
const FENCE_LINE_RE = /^(\s*(?:`{3,}|~{3,}))(.*)$/;
/** The hint on a step that never ran in a recorded run (only in the runbook view: the records are per notebook). */
const NEVER_RAN = 'This step has never run here.';
const NEVER_RAN_CODE = 'never-ran';

const SEVERITY: Record<MarkerLevel, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

function toDiagnostic(p: LintProblem, level: MarkerLevel, range: vscode.Range, prefix = ''): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, prefix + p.message, SEVERITY[level]);
  d.source = 'md-runbook';
  if (p.fix) d.code = TYPO_CODE;
  else if (p.code) d.code = p.code;
  return d;
}

const FIX_COMMAND = 'mdRunbook._fixCellOption';

/** Only a typo's fix: `from` is not a known option and `to` is the one lint suggests for it. */
const isTypoFix = (from: string, to: string): boolean => to !== from.toLowerCase() && suggestOption(from) === to;

/**
 * The fix in the runbook view: the fence options are in the cell's metadata, and a code action's
 * workspace edit can't carry a notebook edit (VS Code ignores it), so a command makes it. Any
 * command can also be called from a link: this one renames nothing but a typo to lint's
 * suggestion, so it can't turn off an option such as confirm.
 */
async function fixCellOption(notebook: unknown, index: unknown, from: unknown, to: unknown): Promise<boolean> {
  if (typeof notebook !== 'string' || typeof index !== 'number' || typeof from !== 'string' || typeof to !== 'string' || !isTypoFix(from, to)) return false;
  const nb = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === notebook);
  if (!nb || index < 0 || index >= nb.cellCount) return false;
  const cell = nb.cellAt(index);
  const meta: unknown = cell.metadata?.[META_KEY];
  const info = isCodeMeta(meta) ? renameInfoOption(meta.info, from, to) : undefined;
  if (!isCodeMeta(meta) || info === undefined) return false;
  const edit = new vscode.WorkspaceEdit();
  edit.set(nb.uri, [vscode.NotebookEdit.updateCellMetadata(index, { ...cell.metadata, [META_KEY]: withInfo(meta, info) })]);
  return vscode.workspace.applyEdit(edit);
}

/**
 * Quick Fix for a misspelled cell option: rename it on the fence, in the runbook view (the cell's
 * fence options, kept in its metadata) and in the Markdown text (the fence line).
 */
const typoFixes: vscode.CodeActionProvider = {
  provideCodeActions(doc, _range, context) {
    const actions: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      const m = d.source === 'md-runbook' && d.code === TYPO_CODE ? TYPO_RE.exec(d.message) : null;
      if (!m) continue;
      const [, from, to] = m as unknown as [string, string, string];
      const action = new vscode.CodeAction(`Change "${from}" to "${to}"`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [d];
      action.isPreferred = true;
      if (doc.uri.scheme === 'vscode-notebook-cell') {
        const cell = vscode.workspace.notebookDocuments.flatMap((nb) => nb.getCells()).find((c) => c.document.uri.toString() === doc.uri.toString());
        if (!cell) continue;
        action.command = { title: action.title, command: FIX_COMMAND, arguments: [cell.notebook.uri.toString(), cell.index, from, to] };
      } else {
        const line = doc.lineAt(d.range.start.line);
        const fence = FENCE_LINE_RE.exec(line.text);
        const info = fence ? renameInfoOption(fence[2]!, from, to) : undefined;
        if (!fence || info === undefined) continue;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, line.range, fence[1]! + info);
        action.edit = edit;
      }
      actions.push(action);
    }
    return actions;
  },
};

const lineRange = (doc: vscode.TextDocument, line: number): vscode.Range => {
  const l = doc.lineAt(Math.min(Math.max(line, 0), Math.max(doc.lineCount - 1, 0)));
  return new vscode.Range(l.range.start.translate(0, l.firstNonWhitespaceCharacterIndex), l.range.end);
};

/** Runbook calls: lint reads the runbook a call names (a local file), and the files a pattern matches. */
function callLintOptions(uri: vscode.Uri): LintOptions {
  if (uri.scheme !== 'file') return {};
  return { readRunbook: runbookReader(uri.fsPath), matchRunbooks: (glob) => matchRunbooks(uri.fsPath, glob) };
}

export function registerLint(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('md-runbook');
  const enabled = (): boolean => vscode.workspace.getConfiguration(SECTION).get<boolean>('lint.enabled', true);
  /** Each problem with how it shows (prose findings as mdRunbook.lint.prose says), the hidden ones left out. */
  const shown = (problems: readonly LintProblem[]): Array<[LintProblem, MarkerLevel]> => {
    const prose = proseSetting(vscode.workspace.getConfiguration(SECTION).get('lint.prose'));
    return problems.flatMap((p) => {
      const level = markerLevel(p, prose);
      return level ? [[p, level] as [LintProblem, MarkerLevel]] : [];
    });
  };
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
    for (const [p, level] of shown(lintRunbook(notebookTextWithOutputs(nb), callLintOptions(nb.uri)))) {
      // Problems in a cell go on it (prose on its Markdown cell); front matter problems on the first cell.
      const index = p.cell?.index ?? 0;
      if (index >= nb.cellCount) continue;
      const doc = nb.cellAt(index).document;
      // Fence options are not part of the cell's text: mark its first line.
      const d =
        p.cell === undefined
          ? toDiagnostic(p, level, lineRange(doc, p.line))
          : p.cell.sourceLine === undefined
            ? toDiagnostic(p, level, lineRange(doc, 0), 'cell options: ')
            : toDiagnostic(p, level, lineRange(doc, p.cell.sourceLine));
      byCell.set(index, [...(byCell.get(index) ?? []), d]);
    }
    // Steps that never ran in any recorded run (runs.ts): a hint, once the runbook has a run.
    for (const index of neverRanCells(nb)) {
      const d = new vscode.Diagnostic(lineRange(nb.cellAt(index).document, 0), NEVER_RAN, vscode.DiagnosticSeverity.Information);
      d.source = 'md-runbook';
      d.code = NEVER_RAN_CODE;
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
    collection.set(doc.uri, shown(lintRunbook(doc.getText(), callLintOptions(doc.uri))).map(([p, level]) => toDiagnostic(p, level, lineRange(doc, p.line))));
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
    vscode.languages.registerCodeActionsProvider([{ scheme: 'vscode-notebook-cell' }, { language: 'markdown' }], typoFixes, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.commands.registerCommand(FIX_COMMAND, fixCellOption),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    vscode.workspace.onDidOpenNotebookDocument((nb) => isRunbook(nb) && timed('lint', nb.uri.fsPath, () => lintNotebook(nb))),
    vscode.workspace.onDidChangeNotebookDocument((e) => isRunbook(e.notebook) && later(e.notebook.uri.toString(), () => lintNotebook(e.notebook))),
    vscode.workspace.onDidCloseNotebookDocument((nb) => isRunbook(nb) && clearNotebook(nb)),
    // A run recorded: the never-ran hints of that runbook (and its copies' original) change.
    onDidChangeRuns((key) => {
      for (const nb of vscode.workspace.notebookDocuments) if (isRunbook(nb) && runsKeyOf(nb.uri) === key) later(nb.uri.toString(), () => lintNotebook(nb));
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => timed('lint text', doc.uri.fsPath, () => lintText(doc))),
    vscode.workspace.onDidChangeTextDocument((e) => e.document.languageId === 'markdown' && later(e.document.uri.toString(), () => lintText(e.document))),
    vscode.workspace.onDidCloseTextDocument((doc) => doc.uri.scheme !== 'vscode-notebook-cell' && collection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.lint.enabled`) || e.affectsConfiguration(`${SECTION}.lint.prose`)) all();
    }),
    // For tests: the markers of a document.
    vscode.commands.registerCommand('mdRunbook._diagnostics', (uri: vscode.Uri) => collection.get(uri)?.map((d) => d.message) ?? []),
  );
  all();
}

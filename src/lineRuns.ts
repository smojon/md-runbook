/**
 * Line runs: run the line under the cursor (or the selected text) of a code cell, run all its
 * lines one by one, or step through them, pausing before each line like a debugger. Lines are
 * commands as `core/steps.ts` finds them; the controller runs them in one shell.
 */

import * as vscode from 'vscode';
import { shellKindForLanguage } from './core';
import { LineStep, formatLineRange, splitSteps, stepAtLine } from './core/steps';
import { LineRun, RunbookController } from './controller';
import { isCell, runbookEditor, selectRunbookKernel } from './progress';
import { NOTEBOOK_TYPE } from './serializer';

type Mode = 'selection' | 'each' | 'step' | 'stepFrom';

/** A Step Through run waiting before its next line. */
interface Paused {
  cell: vscode.NotebookCell;
  /** The step that runs next, and the run's steps. */
  index: number;
  steps: readonly LineStep[];
  next(): void;
  rest(): void;
  stop(): void;
}

const PAUSED_KEY = 'mdRunbook.stepPaused';

/** The cell a command applies to, with its text editor when one is shown (for the cursor). */
function targetCell(arg: unknown): { cell: vscode.NotebookCell; editor?: vscode.TextEditor } | undefined {
  const editorOf = (cell: vscode.NotebookCell): vscode.TextEditor | undefined =>
    vscode.window.visibleTextEditors.find((e) => e.document === cell.document);
  if (isCell(arg)) return arg.notebook.notebookType === NOTEBOOK_TYPE ? { cell: arg, editor: editorOf(arg) } : undefined;
  const nbEditor = runbookEditor(vscode.window.activeNotebookEditor?.notebook);
  if (!nbEditor) return undefined;
  const active = vscode.window.activeTextEditor;
  const focused = active && nbEditor.notebook.getCells().find((c) => c.document === active.document);
  if (focused) return { cell: focused, editor: active };
  const index = nbEditor.selections[0]?.start;
  const cell = index !== undefined && index < nbEditor.notebook.cellCount ? nbEditor.notebook.cellAt(index) : undefined;
  return cell && { cell, editor: editorOf(cell) };
}

/** Trimmed to its last character, so a selection of whole lines doesn't end on the next line. */
function lastSelectedLine(sel: vscode.Selection): number {
  return sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
}

/** Builds what to run, or says why there is nothing to run. */
function planLineRun(mode: Mode, cell: vscode.NotebookCell, editor: vscode.TextEditor | undefined): Omit<LineRun, 'beforeStep' | 'onStep' | 'cellText'> | string {
  const kind = shellKindForLanguage(cell.document.languageId);
  if (cell.kind !== vscode.NotebookCellKind.Code || kind === undefined) return 'line runs need a bash, PowerShell or cmd code cell.';
  const doc = cell.document;
  const all = splitSteps(doc.getText(), kind);
  if (all.length === 0) return 'this cell has no commands to run.';
  if (mode === 'each' || mode === 'step') return { source: doc.getText(), steps: all, coversCell: true };

  const sel = editor?.selection;
  if (!sel) return 'put the cursor on a line of the cell, or select the text to run.';
  if (mode === 'stepFrom') {
    // From the command on the cursor line, or the next one after a blank or comment line.
    const from = all.findIndex((s) => s.end >= sel.active.line);
    if (from < 0) return `there is no command on or after line ${sel.active.line + 1}.`;
    const steps = all.slice(from);
    return { source: steps.map((s) => s.text).join('\n'), steps, coversCell: from === 0 };
  }
  if (sel.isEmpty) {
    const step = stepAtLine(all, sel.active.line);
    if (!step) return `line ${sel.active.line + 1} has no command (it is blank or a comment).`;
    return { source: step.text, steps: [step], coversCell: all.length === 1 };
  }
  const text = doc.getText(sel).replace(/(\r\n|\n|\r)$/, '');
  if (text.trim() === '') return 'the selection is empty.';
  const step: LineStep = { start: sel.start.line, end: lastSelectedLine(sel), text };
  // Every command of the cell is selected from its first character to the end of its last line.
  const coversCell = all.every((s) => {
    const first = doc.lineAt(s.start);
    return sel.contains(new vscode.Range(s.start, first.firstNonWhitespaceCharacterIndex, s.end, doc.lineAt(s.end).text.length));
  });
  return { source: text, steps: [step], coversCell };
}

export function registerLineRuns(context: vscode.ExtensionContext, controller: RunbookController): void {
  const paused = new Map<string, Paused>();
  const running = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.focusedStackFrameHighlightBackground'),
  });
  const waiting = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    after: {
      contentText: '  ⏸ next line: F10 run · F5 run the rest · Shift+F5 stop',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
  });
  /** Highlighted line per cell document, re-applied when its editor is shown again. */
  const highlights = new Map<vscode.TextDocument, { type: vscode.TextEditorDecorationType; range: vscode.Range }>();
  const paint = (editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void => {
    for (const e of editors) {
      const h = highlights.get(e.document);
      e.setDecorations(running, h?.type === running ? [h.range] : []);
      e.setDecorations(waiting, h?.type === waiting ? [h.range] : []);
    }
  };
  const highlight = (cell: vscode.NotebookCell, type: vscode.TextEditorDecorationType | undefined, step?: LineStep): void => {
    if (type && step) highlights.set(cell.document, { type, range: new vscode.Range(step.start, 0, step.end, cell.document.lineAt(step.end).text.length) });
    else highlights.delete(cell.document);
    paint(vscode.window.visibleTextEditors.filter((e) => e.document === cell.document));
  };

  const status = vscode.window.createStatusBarItem('mdRunbook.stepThrough', vscode.StatusBarAlignment.Left, 99);
  status.name = 'md-runbook step through';
  status.command = 'mdRunbook.stepNext';
  /** The paused run of the active runbook, if any. */
  const activePaused = (): Paused | undefined => {
    const nb = vscode.window.activeNotebookEditor?.notebook;
    return nb && paused.get(nb.uri.toString());
  };
  const updateUi = (): void => {
    const p = activePaused();
    void vscode.commands.executeCommand('setContext', PAUSED_KEY, p !== undefined);
    if (!p) return status.hide();
    const step = p.steps[p.index]!;
    status.text = `$(debug-pause) line ${formatLineRange(step.start, step.end)} next (${p.index + 1}/${p.steps.length})`;
    status.tooltip = `md-runbook: stepping through cell ${p.cell.index + 1}. Click or F10 to run the next line, F5 to run the rest, Shift+F5 to stop.`;
    status.show();
  };

  const run = async (mode: Mode, arg?: unknown): Promise<void> => {
    const target = targetCell(arg);
    if (!target) return void vscode.window.showInformationMessage('md-runbook: open a runbook and pick a code cell first.');
    const { cell, editor } = target;
    const plan = planLineRun(mode, cell, editor);
    if (typeof plan === 'string') return void vscode.window.showInformationMessage(`md-runbook: ${plan}`);
    const key = cell.notebook.uri.toString();
    let runRest = false;
    const lineRun: LineRun = {
      ...plan,
      cellText: cell.document.getText(),
      onStep: (i) => highlight(cell, i === undefined ? undefined : running, i === undefined ? undefined : plan.steps[i]),
      ...(mode === 'step' || mode === 'stepFrom'
        ? {
            beforeStep: (index: number, token: vscode.CancellationToken) =>
              runRest
                ? Promise.resolve(true)
                : new Promise<boolean>((resolve) => {
                    const finish = (go: boolean, rest = false): void => {
                      sub.dispose();
                      if (paused.get(key)?.cell === cell) paused.delete(key);
                      runRest = rest;
                      highlight(cell, undefined);
                      updateUi();
                      resolve(go);
                    };
                    // The cell's Stop button ends the run where it is.
                    const sub = token.onCancellationRequested(() => finish(false));
                    paused.set(key, { cell, index, steps: plan.steps, next: () => finish(true), rest: () => finish(true, true), stop: () => finish(false) });
                    highlight(cell, waiting, plan.steps[index]);
                    updateUi();
                  }),
          }
        : {}),
    };
    await selectRunbookKernel(context, cell.notebook);
    await controller.runLines(cell, lineRun);
  };

  /** Acts on the paused run of the given cell's runbook, else of the active runbook. */
  const control = (action: 'next' | 'rest' | 'stop') => (arg?: unknown) => {
    const p = isCell(arg) ? paused.get(arg.notebook.uri.toString()) : activePaused();
    if (!p) return void vscode.window.setStatusBarMessage('md-runbook: no cell is waiting for its next line', 4000);
    p[action]();
  };

  context.subscriptions.push(
    running,
    waiting,
    status,
    { dispose: () => [...paused.values()].forEach((p) => p.stop()) },
    vscode.commands.registerCommand('mdRunbook.runLine', (arg?: unknown) => run('selection', arg)),
    vscode.commands.registerCommand('mdRunbook.runLinesOneByOne', (arg?: unknown) => run('each', arg)),
    vscode.commands.registerCommand('mdRunbook.stepThroughLines', (arg?: unknown) => run('step', arg)),
    vscode.commands.registerCommand('mdRunbook.stepThroughFromLine', (arg?: unknown) => run('stepFrom', arg)),
    vscode.commands.registerCommand('mdRunbook.stepNext', control('next')),
    vscode.commands.registerCommand('mdRunbook.stepContinue', control('rest')),
    vscode.commands.registerCommand('mdRunbook.stepStop', control('stop')),
    // For tests: where the active runbook's Step Through run is waiting.
    vscode.commands.registerCommand('mdRunbook._stepPaused', () => {
      const p = activePaused();
      return p && { cell: p.cell.index, index: p.index };
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => paint(editors)),
    vscode.window.onDidChangeActiveNotebookEditor(updateUi),
    vscode.workspace.onDidCloseNotebookDocument((nb) => paused.get(nb.uri.toString())?.stop()),
  );
}

/**
 * Runbook progress: mark steps done/skipped by hand, check off task-list items, a status bar
 * summary, Resume Run and Clear Outputs Above/Below.
 */

import * as os from 'node:os';
import * as vscode from 'vscode';
import { Progress, checklist, computeProgress, formatLocalIso, formatProgress, isCodeMeta, nextUncheckedOffset, outputBlockAttrs } from '@md-runbook/core';
import { isManualMark } from '@md-runbook/core/progress';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { osGroups } from '@md-runbook/core/os';
import { SECTION } from './config';
import { CONTROLLER_ID, RunbookController } from './controller';
import { META_KEY, outputMeta } from './outputs';
import { RunPipeline } from './pipeline';
import { NOTEBOOK_TYPE } from './serializer';
import { setTaskBox } from './taskLists';

/** Marker attributes of a code cell's current output, or undefined if it has none (or is running). */
function cellAttrs(cell: vscode.NotebookCell): Record<string, string> | undefined {
  let attrs: Record<string, string> | undefined;
  for (const o of cell.outputs) {
    const m = outputMeta(o);
    if (m?.persisted) {
      // Loaded from the file: the marker attributes are in the cell's raw output block.
      const meta: unknown = cell.metadata?.[META_KEY];
      const fromFile = isCodeMeta(meta) && meta.output ? outputBlockAttrs(meta.output.raw) : undefined;
      return fromFile?.exit ? fromFile : { ...fromFile, exit: 'done' };
    }
    if (m?.run) attrs ??= m.run.attrs;
    if (m?.status && m.attrs) attrs = m.attrs;
  }
  return attrs;
}

export function notebookProgress(nb: vscode.NotebookDocument): Progress {
  const cells = nb.getCells();
  const optionsOn = vscode.workspace.getConfiguration(SECTION).get<boolean>('cellOptions.enabled', true);
  const slots = osGroups(
    cells.map((c) => {
      const meta: unknown = c.metadata?.[META_KEY];
      const os = optionsOn && c.kind === vscode.NotebookCellKind.Code && isCodeMeta(meta) ? parseCellOptions(meta.info).os : undefined;
      return { kind: c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup', ...(os ? { os } : {}) };
    }),
  );
  return computeProgress(
    cells.map((c, i) => {
      if (c.kind !== vscode.NotebookCellKind.Code) return { kind: 'markup', tasks: checklist(c.document.getText()) };
      const attrs = cellAttrs(c);
      const os = slots[i];
      const meta: unknown = c.metadata?.[META_KEY];
      // host= blocks never run here (see safety.ts): skipped, not pending forever.
      const elsewhere = isCodeMeta(meta) && parseCellOptions(meta.info).host !== undefined;
      return { kind: 'code', exit: attrs?.exit, partial: attrs?.lines !== undefined, check: attrs?.check, ...(os ? { os } : {}), ...(elsewhere ? { elsewhere } : {}) };
    }),
  );
}

function userName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

export function isCell(v: unknown): v is vscode.NotebookCell {
  return typeof v === 'object' && v !== null && 'notebook' in v && 'document' in v && typeof (v as { index?: unknown }).index === 'number';
}

export function runbookEditor(nb?: vscode.NotebookDocument): vscode.NotebookEditor | undefined {
  const editors = [vscode.window.activeNotebookEditor, ...vscode.window.visibleNotebookEditors];
  return editors.find((e) => e && e.notebook.notebookType === NOTEBOOK_TYPE && (!nb || e.notebook === nb));
}

/** The cell passed from a cell toolbar, else the selected cells of the active runbook. */
function targetCells(arg: unknown, kind: vscode.NotebookCellKind): vscode.NotebookCell[] {
  if (isCell(arg)) return arg.kind === kind ? [arg] : [];
  const editor = runbookEditor();
  if (!editor) return [];
  return editor.selections.flatMap((r) => editor.notebook.getCells(r)).filter((c) => c.kind === kind);
}

/** Executions need this controller to be the notebook's selected kernel. */
export async function selectRunbookKernel(context: vscode.ExtensionContext, nb: vscode.NotebookDocument): Promise<void> {
  const notebookEditor = runbookEditor(nb);
  if (notebookEditor) await vscode.commands.executeCommand('notebook.selectKernel', { notebookEditor, id: CONTROLLER_ID, extension: context.extension.id });
}

export function registerProgress(context: vscode.ExtensionContext, pipeline: RunPipeline, controller: RunbookController): void {
  const ensureKernel = (nb: vscode.NotebookDocument): Promise<void> => selectRunbookKernel(context, nb);

  const mark = (exit: 'done' | 'skipped') => async (arg?: unknown) => {
    const cells = targetCells(arg, vscode.NotebookCellKind.Code);
    if (cells[0]) await ensureKernel(cells[0].notebook);
    const by = userName();
    for (const cell of cells) {
      await controller.recordManual(cell, { exit, ran: formatLocalIso(new Date()), by }, `[md-runbook] marked ${exit} by ${by}\n`, exit === 'done' ? true : undefined);
    }
    refresh();
  };

  const clear = async (cells: vscode.NotebookCell[]): Promise<void> => {
    const code = cells.filter((c) => c.kind === vscode.NotebookCellKind.Code && c.outputs.length > 0);
    if (!code[0]) return;
    await ensureKernel(code[0].notebook);
    await controller.clearOutputs(code);
    refresh();
  };

  /** Clear above (excluding the cell) or below (including it), like Run Above/Below. */
  const clearRelative = (above: boolean) => async (arg?: unknown) => {
    const editor = runbookEditor();
    const nb = isCell(arg) ? arg.notebook : editor?.notebook;
    const index = isCell(arg) ? arg.index : editor?.selections[0]?.start;
    if (!nb || index === undefined) return;
    await clear(nb.getCells().filter((c) => (above ? c.index < index : c.index >= index)));
  };

  const item = vscode.window.createStatusBarItem('mdRunbook.progress', vscode.StatusBarAlignment.Left, 100);
  item.name = 'md-runbook progress';
  item.command = 'mdRunbook.revealNextStep';
  let timer: NodeJS.Timeout | undefined;
  const update = (): void => {
    timer = undefined;
    const nb = vscode.window.activeNotebookEditor?.notebook;
    const p = nb?.notebookType === NOTEBOOK_TYPE && vscode.workspace.getConfiguration(SECTION).get<boolean>('progress.statusBar', true) ? notebookProgress(nb) : undefined;
    if (!p || p.total === 0) return item.hide();
    item.text = formatProgress(p);
    item.tooltip = `${p.done} done, ${p.skipped} skipped, ${p.failed} failed, ${p.pending} pending. Click to go to the ${p.firstFailed ? 'failed' : 'next'} step.`;
    item.show();
  };
  // Outputs stream in many small changes; coalesce them.
  const refresh = (): void => {
    timer ??= setTimeout(update, 100);
  };

  pipeline.observers.push({ onDidRunCell: refresh, onDidRunSequence: refresh });

  context.subscriptions.push(
    item,
    { dispose: () => clearTimeout(timer) },
    vscode.window.onDidChangeActiveNotebookEditor(refresh),
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook === vscode.window.activeNotebookEditor?.notebook) refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.progress`)) refresh();
    }),
    vscode.commands.registerCommand('mdRunbook.markStepDone', mark('done')),
    vscode.commands.registerCommand('mdRunbook.markStepSkipped', mark('skipped')),
    vscode.commands.registerCommand('mdRunbook.unmarkStep', async (arg?: unknown) => {
      // Only marks made by hand: a real run recorded as skipped (skip option) keeps its output.
      await clear(targetCells(arg, vscode.NotebookCellKind.Code).filter((c) => isManualMark(cellAttrs(c))));
    }),
    vscode.commands.registerCommand('mdRunbook.checkNextItem', async (arg?: unknown) => {
      for (const cell of targetCells(arg, vscode.NotebookCellKind.Markup)) {
        const at = nextUncheckedOffset(cell.document.getText());
        if (at === undefined) continue;
        await setTaskBox(cell, at, true);
      }
    }),
    vscode.commands.registerCommand('mdRunbook.resumeRun', async (arg?: unknown) => {
      const editor = arg instanceof vscode.Uri ? runbookEditor(vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === arg.toString())) : runbookEditor();
      if (!editor) return;
      const { resume } = notebookProgress(editor.notebook);
      if (resume.length === 0) return void vscode.window.showInformationMessage('md-runbook: every step is done or skipped.');
      await ensureKernel(editor.notebook);
      // Only failed/pending cells: steps already done or marked skipped are not run again.
      const ranges = resume.map((i) => ({ start: i, end: i + 1 }));
      await vscode.commands.executeCommand('notebook.cell.execute', { ranges, document: editor.notebook.uri });
    }),
    vscode.commands.registerCommand('mdRunbook.clearOutputsAbove', clearRelative(true)),
    vscode.commands.registerCommand('mdRunbook.clearOutputsBelow', clearRelative(false)),
    vscode.commands.registerCommand('mdRunbook.revealNextStep', () => {
      const editor = runbookEditor();
      if (!editor) return;
      const p = notebookProgress(editor.notebook);
      const target = (p.firstFailed ?? p.firstPending)?.cell;
      if (target === undefined) return;
      const range = new vscode.NotebookRange(target, target + 1);
      editor.selections = [range];
      editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    }),
    // For tests: the progress model of a runbook (default: the active one).
    vscode.commands.registerCommand('mdRunbook._progress', (uri?: vscode.Uri) => {
      const nb = uri ? vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString()) : runbookEditor()?.notebook;
      return nb ? notebookProgress(nb) : undefined;
    }),
  );
  refresh();
}

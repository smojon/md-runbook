/**
 * Runbook progress: mark steps done/skipped by hand, check off task-list items, a status bar
 * summary, Resume Run and Clear Outputs Above/Below.
 */

import * as os from 'node:os';
import * as vscode from 'vscode';
import { Progress, checklist, computeProgress, formatLocalIso, isCodeMeta, nextUncheckedOffset, outputBlockAttrs, runbookEstimate } from '@md-runbook/core';
import { PartEstimate, RunbookEstimate, formatEstimate, formatFinish, formatTimeLeft, stepLabel, withoutEstimate } from '@md-runbook/core/estimate';
import { isManualMark } from '@md-runbook/core/progress';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { osGroups } from '@md-runbook/core/os';
import { SECTION } from './config';
import { CONTROLLER_ID, RunbookController, cellPart } from './controller';
import { anyRunning, estimateItem, notebookEstimateSteps, notebookPartStates, runningSince } from './estimates';
import { META_KEY, outputMeta } from './outputs';
import { RunPipeline } from './pipeline';
import { NOTEBOOK_TYPE } from './serializer';
import { setTaskBox } from './taskLists';
import { onDidChangeWaiting, waitingIn, waitingText } from './waiting';

/** Marker attributes of a code cell's current output, or undefined if it has none (or is running). */
export function cellAttrs(cell: vscode.NotebookCell): Record<string, string> | undefined {
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
      const o = optionsOn && isCodeMeta(meta) ? parseCellOptions(meta.info) : undefined;
      // host= blocks never run here (see safety.ts): skipped, not pending forever.
      const elsewhere = isCodeMeta(meta) && parseCellOptions(meta.info).host !== undefined;
      return {
        kind: 'code',
        exit: attrs?.exit,
        partial: attrs?.lines !== undefined,
        check: attrs?.check,
        ...(os ? { os } : {}),
        ...(elsewhere ? { elsewhere } : {}),
        ...(o?.part ? { part: o.part } : {}),
      };
    }),
  );
}

/** What the status bar item shows: its text, a Markdown tooltip, and a background for a failure. */
export interface ProgressStatus {
  text: string;
  tooltip: vscode.MarkdownString;
  failed: boolean;
}

/** The cell running now in `nb`, if any (its live output carries exit=running). */
function runningCell(nb: vscode.NotebookDocument): vscode.NotebookCell | undefined {
  return nb.getCells().find((c) => runningSince(c) !== undefined);
}

function labelOf(cell: vscode.NotebookCell): string {
  const meta: unknown = cell.metadata?.[META_KEY];
  return stepLabel(isCodeMeta(meta) ? meta.info : '', cell.document.getText(), cell.document.languageId) || `cell ${cell.index + 1}`;
}

/**
 * The status bar item, in the same words as the app's run bar:
 *   running   ⟳ Step 3/6 · Push image · 1m 40s left
 *   failed    ✗ Step 4/6 failed            (red)
 *   done      ✓ Done · 6/6 · teardown offered
 *   idle      ☰ 2/6 · ~4 min
 * The time left is by the blocks' estimates (estimate=); nothing about them without any.
 */
export function progressStatus(nb: vscode.NotebookDocument, p: Progress = notebookProgress(nb), now = Date.now()): ProgressStatus {
  const e = runbookEstimate(notebookEstimateSteps(nb, cellAttrs, now), notebookPartStates(nb, cellAttrs));
  const left = e.fraction !== undefined && e.leftSeconds > 0 ? e.leftSeconds : undefined;
  const running = runningCell(nb);
  const complete = p.done + p.skipped;
  let text: string;
  if (running) {
    const step = p.stepOfCell[running.index];
    const part = cellPart(running);
    const where = step !== undefined ? `Step ${step}/${p.total}` : part === 'ready' ? 'Ready check' : part === 'teardown' ? 'Teardown' : `Cell ${running.index + 1}`;
    text = `$(sync~spin) ${where} · ${labelOf(running)}${left !== undefined ? ` · ${formatTimeLeft(left)} left` : ''}`;
  } else if (p.firstFailed) {
    text = `$(error) Step ${p.firstFailed.step}/${p.total} failed`;
  } else if (p.pending === 0 && p.total > 0) {
    text = `$(pass-filled) Done · ${complete}/${p.total}${p.offered > 0 ? ' · teardown offered' : ''}`;
  } else {
    text = `$(checklist) ${complete}/${p.total}${left !== undefined ? ` · ~${formatTimeLeft(left)}` : ''}`;
  }
  return { text, tooltip: progressTooltip(nb, p, e, running, now), failed: !running && p.firstFailed !== undefined };
}

/**
 * The tooltip: where the run is, a table of the setup, the runbook's own steps and the teardown
 * (each with its time, one percentage only: the whole runbook's), and links to act on it.
 */
export function progressTooltip(nb: vscode.NotebookDocument, p: Progress, e: RunbookEstimate, running: vscode.NotebookCell | undefined, now = Date.now()): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['mdRunbook.revealNextStep', 'mdRunbook.resumeRun', 'mdRunbook._revealCell'] };
  const complete = p.done + p.skipped;
  const head: string[] = [`**${complete} of ${p.total} steps done**`];
  if (e.fraction !== undefined) head.push(`${Math.floor(e.fraction * 100)}% by the estimates`);
  if (e.fraction !== undefined && e.leftSeconds > 0) head.push(`${formatTimeLeft(e.leftSeconds)} left`, `done ≈ ${formatFinish(e.leftSeconds, now)}`);
  md.appendMarkdown(head.join(' · ') + '\n\n');
  if (running) md.appendMarkdown(`Running: ${escapeMd(labelOf(running))} (cell ${running.index + 1})\n\n`);
  const counts = [`${p.done} done`, `${p.skipped} skipped`, `${p.failed} failed`, `${p.pending} to do`];
  if (p.offered > 0) counts.push(`${p.offered} teardown step${p.offered === 1 ? '' : 's'} offered`);
  if (e.unestimatedLeft > 0) counts.push(withoutEstimate(e.unestimatedLeft));
  md.appendMarkdown(counts.join(' · ') + '\n\n');
  const parts = e.parts;
  if (parts) {
    const time = (x: PartEstimate): string =>
      x.totalSeconds > 0 ? (x.doneSeconds > 0 && x.leftSeconds > 0 ? `${formatEstimate(x.doneSeconds)} of ${formatEstimate(x.totalSeconds)}` : formatEstimate(x.totalSeconds)) : '';
    const state = (x: PartEstimate): string => (x.leftSeconds === 0 && x.doneSeconds > 0 ? '✓ done' : x.doneSeconds > 0 ? 'running' : 'to do');
    const rows: string[] = ['| | | Time |', '|---|---|---:|'];
    if (parts.setup.blocks > 0) {
      const s = parts.states.setup;
      rows.push(`| Setup | ${s === 'up' ? '✓ already up' : s === 'unchecked' ? 'unless already up' : state(parts.setup)} | ${s === 'up' ? '' : time(parts.setup)} |`);
    }
    rows.push(`| Steps | ${state(parts.body)} | ${time(parts.body)} |`);
    if (parts.teardown.blocks > 0) rows.push(`| Teardown | ${parts.states.teardown === 'chosen' ? state(parts.teardown) : 'offered at the end'} | ${time(parts.teardown)} |`);
    md.appendMarkdown(rows.join('\n') + '\n\n');
  }
  const links: string[] = [];
  if (running) links.push(`[Show the running step](command:mdRunbook._revealCell?${encodeURIComponent(JSON.stringify([{ uri: nb.uri.toString(), index: running.index }]))})`);
  else if (p.firstFailed || p.firstPending) links.push(`[Go to the ${p.firstFailed ? 'failed' : 'next'} step](command:mdRunbook.revealNextStep)`);
  if (!running && p.resume.length > 0 && complete > 0) links.push('[Resume Run](command:mdRunbook.resumeRun)');
  if (links.length) md.appendMarkdown(links.join(' · '));
  return md;
}

const escapeMd = (t: string): string => t.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

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
  // While a block runs, the time left moves on without any output.
  let ticker: NodeJS.Timeout | undefined;
  const update = (): void => {
    timer = undefined;
    const nb = vscode.window.activeNotebookEditor?.notebook;
    const p = nb?.notebookType === NOTEBOOK_TYPE && vscode.workspace.getConfiguration(SECTION).get<boolean>('progress.statusBar', true) ? notebookProgress(nb) : undefined;
    const running = !!p && !!nb && anyRunning(nb);
    if (running && !ticker) ticker = setInterval(refresh, 1000);
    if (!running && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
    if (!p || p.total === 0 || !nb) return item.hide();
    const w = waitingIn(nb);
    if (w) {
      // The prompt is at the top of the window, easy to miss: say whose turn it is, in colour.
      const t = waitingText(w.what);
      item.text = t.statusBar;
      item.tooltip = t.tooltip;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.command = { title: 'Show the cell', command: 'mdRunbook._revealCell', arguments: [w.cell] };
      return item.show();
    }
    const s = progressStatus(nb, p);
    item.text = s.text;
    item.tooltip = s.tooltip;
    item.backgroundColor = s.failed ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    item.command = 'mdRunbook.revealNextStep';
    item.show();
  };
  // Outputs stream in many small changes; coalesce them.
  const refresh = (): void => {
    timer ??= setTimeout(update, 100);
  };

  pipeline.observers.push({ onDidRunCell: refresh, onDidRunSequence: refresh });

  context.subscriptions.push(
    item,
    { dispose: () => (clearTimeout(timer), clearInterval(ticker)) },
    vscode.window.onDidChangeActiveNotebookEditor(refresh),
    onDidChangeWaiting(refresh),
    // The status bar item while a cell waits for the reader (waiting.ts).
    vscode.commands.registerCommand('mdRunbook._revealCell', (arg?: unknown) => {
      // A cell (the waiting item), or { uri, index } from a tooltip link.
      const ref = arg as { uri?: unknown; index?: unknown } | undefined;
      const cell = isCell(arg)
        ? arg
        : typeof ref?.uri === 'string' && typeof ref.index === 'number'
          ? vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === ref.uri)?.cellAt(ref.index as number)
          : undefined;
      if (!cell) return;
      const editor = runbookEditor(cell.notebook);
      if (!editor) return;
      const range = new vscode.NotebookRange(cell.index, cell.index + 1);
      editor.selections = [range];
      editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
    }),
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
    // For tests: the estimates of a runbook: the status bar text and each cell's estimate item.
    vscode.commands.registerCommand('mdRunbook._estimates', (uri?: vscode.Uri) => {
      const nb = uri ? vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString()) : runbookEditor()?.notebook;
      if (!nb) return undefined;
      const status = progressStatus(nb);
      return { status: { text: status.text, tooltip: status.tooltip.value }, runbook: runbookEstimate(notebookEstimateSteps(nb, cellAttrs)), cells: nb.getCells().map((c) => estimateItem(c)?.text) };
    }),
  );
  refresh();
}

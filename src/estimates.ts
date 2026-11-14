/**
 * estimate= in the notebook: each block's estimate on its status line, a running block's time
 * against it as a bar (full at the estimate, then "+1m20s over"), and the estimate steps of the
 * whole runbook for the progress item in the status bar (progress.ts).
 */

import * as vscode from 'vscode';
import { isCallLanguage, isDynamicSrc, parseCall } from '@md-runbook/core/call';
import { callEstimateSeconds } from '@md-runbook/core/node';
import { EstimateStep, blockBar, blockProgress, formatBlockProgress, formatEstimate, isCodeMeta, isOverEstimate, overEstimate, stepState, suggestedEstimate } from '@md-runbook/core';
import { parseCellOptions, setInfoOption } from '@md-runbook/core/cellOptions';
import { withInfo } from '@md-runbook/core/proposal';
import { parseInterval } from '@md-runbook/core/checks';
import { osGroups } from '@md-runbook/core/os';
import { PartStates } from '@md-runbook/core/estimate';
import { SECTION } from './config';
import { META_KEY, outputMeta } from './outputs';
import { NOTEBOOK_TYPE } from './serializer';

/** How often a running block's bar (and the runbook's time left) moves on. */
const TICK_MS = 1000;
/** The running block's bar on its status line: long enough to move every few seconds (eighths). */
const BAR_WIDTH = 24;
const SET_ESTIMATE = 'mdRunbook._setEstimate';

function optionsOn(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('cellOptions.enabled', true);
}

/** The block's estimate= in seconds, or undefined. */
export function cellEstimate(cell: vscode.NotebookCell): number | undefined {
  if (cell.kind !== vscode.NotebookCellKind.Code || !optionsOn()) return undefined;
  const meta: unknown = cell.metadata?.[META_KEY];
  if (!isCodeMeta(meta)) return undefined;
  // A runbook call takes as long as what it runs (its estimate=, else the estimates in that file).
  if (isCallLanguage(cell.document.languageId) && cell.notebook.uri.scheme === 'file') return callEstimateSeconds(cell.notebook.uri.fsPath, meta.info, cell.document.getText());
  return parseCellOptions(meta.info).estimateSeconds;
}

/**
 * When the cell's run started, while it runs: its live outputs carry exit=running and ran= until
 * the status output of the finished run follows (the live outputs stay, with their metadata).
 */
export function runningSince(cell: vscode.NotebookCell): number | undefined {
  let since: number | undefined;
  for (const o of cell.outputs) {
    const m = outputMeta(o);
    if (m?.status || m?.persisted) return undefined;
    const run = m?.run?.attrs;
    if (since === undefined && run?.exit === 'running' && run.ran) {
      const t = Date.parse(run.ran);
      if (Number.isFinite(t)) since = t;
    }
  }
  return since;
}

/** The last finished run's duration in seconds, from its status output. */
export function lastDuration(cell: vscode.NotebookCell): number | undefined {
  for (const o of cell.outputs) {
    const m = outputMeta(o);
    const d = m?.status ? m.attrs?.duration : undefined;
    if (d) {
      const ms = parseInterval(d);
      return ms === undefined ? undefined : ms / 1000;
    }
  }
  return undefined;
}

/**
 * The runbook's blocks as estimate steps: every code cell but `skip` and `host=` blocks and the
 * alternatives for another OS; `exitOf` is the cell's recorded exit (progress.ts's cellAttrs).
 */
export function notebookEstimateSteps(
  nb: vscode.NotebookDocument,
  attrsOf: (cell: vscode.NotebookCell) => Record<string, string> | undefined,
  now = Date.now(),
): EstimateStep[] {
  const cells = nb.getCells();
  const opts = cells.map((c) => {
    const meta: unknown = c.metadata?.[META_KEY];
    return c.kind === vscode.NotebookCellKind.Code && isCodeMeta(meta) && optionsOn() ? parseCellOptions(meta.info) : undefined;
  });
  const slots = osGroups(cells.map((c, i) => ({ kind: c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup', ...(opts[i]?.os ? { os: opts[i]!.os } : {}) })));
  const steps: EstimateStep[] = [];
  cells.forEach((c, i) => {
    if (c.kind !== vscode.NotebookCellKind.Code) return;
    const o = opts[i];
    // The ready check is a quick look, not a step that takes time.
    if (o?.skip || o?.part === 'ready' || o?.host !== undefined || (slots[i] && !slots[i]!.active)) return;
    const since = runningSince(c);
    const seconds = cellEstimate(c);
    const e = {
      ...(seconds !== undefined ? { estimateSeconds: seconds } : {}),
      ...(o?.part === 'setup' || o?.part === 'teardown' ? { part: o.part } : {}),
    };
    if (since !== undefined) return void steps.push({ ...e, state: 'running', elapsedSeconds: (now - since) / 1000 });
    const a = attrsOf(c);
    const state = stepState(a?.exit, a?.lines !== undefined, a?.check);
    steps.push({ ...e, state: state === 'done' || state === 'skipped' ? 'done' : 'pending' });
  });
  return steps;
}

/**
 * How the setup and teardown stand (core/estimate.ts textPartStates, from the cells' outputs): the
 * setup `up` (the ready check or a skipped setup step said so), `run` (a setup step ran, or the
 * check said down, or nothing can skip it) or `unchecked`; the teardown `chosen` once it ran.
 */
export function notebookPartStates(nb: vscode.NotebookDocument, attrsOf: (cell: vscode.NotebookCell) => Record<string, string> | undefined): Required<PartStates> {
  let readyAttr: string | undefined;
  let guarded = false;
  let setupUp = false;
  let setupRan = false;
  let teardownRan = false;
  for (const c of nb.getCells()) {
    if (c.kind !== vscode.NotebookCellKind.Code) continue;
    const meta: unknown = c.metadata?.[META_KEY];
    const part = isCodeMeta(meta) && optionsOn() ? parseCellOptions(meta.info).part : undefined;
    if (part === undefined) continue;
    const a = runningSince(c) === undefined ? attrsOf(c) : undefined;
    if (part === 'ready') {
      guarded = true;
      readyAttr ??= a?.ready;
    } else if (part === 'setup') {
      if (isCallLanguage(c.document.languageId)) guarded = true;
      if (a?.ready === 'up') setupUp = true;
      else if ((a?.exit !== undefined && a.exit !== 'skipped') || runningSince(c) !== undefined) setupRan = true;
    } else if ((a?.exit !== undefined && a.exit !== 'skipped') || runningSince(c) !== undefined) teardownRan = true;
  }
  const setup = setupUp || (!setupRan && readyAttr === 'up') ? 'up' : setupRan || readyAttr === 'down' || !guarded ? 'run' : 'unchecked';
  return { setup, teardown: teardownRan ? 'chosen' : 'offered' };
}

/** Whether a cell of the notebook runs now. */
export function anyRunning(nb: vscode.NotebookDocument): boolean {
  return nb.getCells().some((c) => runningSince(c) !== undefined);
}

/**
 * The block's estimate on its status line: `est. 2m30s`; while it runs, its time against it as a
 * bar (`████████▌░░░… 1m of 2m30s`, then `⚠ ███…█ +1m20s over 2m30s`); after a run noticeably over
 * it, how long it took (`est. 2m30s · took 3m10s (+40s)`, a click sets estimate= to it), with a
 * warning past twice it. Undefined for a block without an estimate.
 */
export function estimateItem(cell: vscode.NotebookCell, now = Date.now()): { text: string; tooltip: string; setTo?: number } | undefined {
  const est = cellEstimate(cell);
  if (est === undefined) {
    // A call whose src= has placeholders: what it runs is known when it runs.
    const meta: unknown = cell.metadata?.[META_KEY];
    const src = isCallLanguage(cell.document.languageId) && isCodeMeta(meta) ? parseCall(meta.info, '').src : undefined;
    if (src !== undefined && isDynamicSrc(src) && optionsOn()) {
      return { text: '$(watch) estimate unknown until run', tooltip: `src="${src}" is known when the call runs; add estimate= to the block to show one.` };
    }
    return undefined;
  }
  const since = runningSince(cell);
  if (since !== undefined) {
    const elapsed = (now - since) / 1000;
    const over = blockProgress(elapsed, est).overSeconds > 0;
    return {
      text: `${over ? '$(warning)' : '$(watch)'} ${formatBlockProgress(elapsed, est, BAR_WIDTH, blockBar)}`,
      tooltip: `Running for ${formatEstimate(elapsed)}; this block's estimate (estimate=) is ${formatEstimate(est)}.`,
    };
  }
  const took = lastDuration(cell);
  const extra = took !== undefined ? overEstimate(took, est) : undefined;
  if (took !== undefined && extra !== undefined) {
    const setTo = suggestedEstimate(took);
    return {
      text: `${isOverEstimate(took, est) ? '$(warning)' : '$(watch)'} est. ${formatEstimate(est)} · took ${formatEstimate(took)} (+${formatEstimate(extra)})`,
      tooltip: `The last run took ${formatEstimate(took)}, ${formatEstimate(extra)} more than this block's estimate. Click to set estimate=${formatEstimate(setTo)}.`,
      setTo,
    };
  }
  return { text: `$(watch) est. ${formatEstimate(est)}`, tooltip: 'How long this block takes, as measured on a real run (estimate=). It does not change how it runs.' };
}

/** Set a block's estimate= (from its last run): the fence options are in the cell's metadata. */
async function setEstimate(notebook: unknown, index: unknown, seconds: unknown): Promise<boolean> {
  if (typeof notebook !== 'string' || typeof index !== 'number' || typeof seconds !== 'number' || !(seconds > 0)) return false;
  const nb = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === notebook);
  if (!nb || index < 0 || index >= nb.cellCount) return false;
  const cell = nb.cellAt(index);
  const meta: unknown = cell.metadata?.[META_KEY];
  if (!isCodeMeta(meta)) return false;
  const edit = new vscode.WorkspaceEdit();
  edit.set(nb.uri, [vscode.NotebookEdit.updateCellMetadata(index, { ...cell.metadata, [META_KEY]: withInfo(meta, setInfoOption(meta.info, 'estimate', formatEstimate(seconds))) })]);
  return vscode.workspace.applyEdit(edit);
}

class EstimateStatus implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this.changed.event;
  private timer: NodeJS.Timeout | undefined;

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    const s = estimateItem(cell);
    if (!s) return [];
    const item = new vscode.NotebookCellStatusBarItem(s.text, vscode.NotebookCellStatusBarAlignment.Left);
    item.tooltip = s.tooltip;
    if (s.setTo !== undefined) item.command = { title: 'Set estimate=', command: SET_ESTIMATE, arguments: [cell.notebook.uri.toString(), cell.index, s.setTo] };
    return [item];
  }

  /** Redraw now, and every second while a block with an estimate runs. */
  refresh(): void {
    this.changed.fire();
    const nb = vscode.window.activeNotebookEditor?.notebook;
    const ticking = nb?.notebookType === NOTEBOOK_TYPE && nb.getCells().some((c) => runningSince(c) !== undefined && cellEstimate(c) !== undefined);
    if (ticking && !this.timer) this.timer = setInterval(() => this.refresh(), TICK_MS);
    if (!ticking && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.changed.dispose();
  }
}

export function registerEstimates(context: vscode.ExtensionContext): void {
  const status = new EstimateStatus();
  context.subscriptions.push(
    status,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, status),
    vscode.commands.registerCommand(SET_ESTIMATE, setEstimate),
    // A run starting or ending changes the outputs.
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.notebookType === NOTEBOOK_TYPE && e.cellChanges.some((c) => c.outputs !== undefined || c.metadata !== undefined)) status.refresh();
    }),
    vscode.window.onDidChangeActiveNotebookEditor(() => status.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.cellOptions`)) status.refresh();
    }),
  );
}

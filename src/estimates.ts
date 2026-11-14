/**
 * estimate= in the notebook: each block's estimate on its status line, a running block's time
 * against it as a bar (full at the estimate, then "+1m20s over"), and the estimate steps of the
 * whole runbook for the progress item in the status bar (progress.ts).
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { isCallLanguage, isDynamicSrc, parseCall } from '@md-runbook/core/call';
import { callEstimateSeconds } from '@md-runbook/core/node';
import { EstimateStep, HISTORY_RUNS, blockBar, blockProgress, formatBlockProgress, formatEstimate, formatLearned, isCodeMeta, isOverEstimate, learnedEstimate, overEstimate, stepHistoryKey, stepState, suggestedEstimate, withDuration } from '@md-runbook/core';
import { parseCellOptions, setInfoOption } from '@md-runbook/core/cellOptions';
import { withInfo } from '@md-runbook/core/proposal';
import { parseInterval } from '@md-runbook/core/checks';
import { osGroups } from '@md-runbook/core/os';
import { PartStates } from '@md-runbook/core/estimate';
import { SECTION } from './config';
import { copyOrigin } from './copyOrigins';
import { META_KEY, outputMeta } from './outputs';
import type { RunPipeline, RunRecord } from './pipeline';
import { originalName } from './runHistory';
import { NOTEBOOK_TYPE } from './serializer';

/** How often a running block's bar (and the runbook's time left) moves on. */
const TICK_MS = 1000;
/** The running block's bar on its status line: twice the old 10, so it moves in twentieths. */
const BAR_WIDTH = 20;
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

/** Past runs of each step that passed, per runbook (workspace state; never in the file). */
const HISTORY_KEY = 'mdRunbook.stepHistory';
/** Runbooks kept: the least recently run go first. */
const HISTORY_RUNBOOKS = 200;
type History = Record<string, Record<string, number[]>>;
let memento: vscode.Memento | undefined;

const learning = (): boolean => vscode.workspace.getConfiguration(SECTION).get<boolean>('estimates.learn', true);

/**
 * Whose history a runbook uses: its own, and for a run copy (`deploy.20261114-142000.md`) the
 * runbook it was copied from, so teams that always run copies learn too. The run history
 * (runs.ts) keys its records the same way.
 */
export function historyOf(uri: vscode.Uri): string {
  const original = originalName(path.posix.basename(uri.path));
  if (original === undefined) return uri.toString();
  // A copy made in another folder (output.copyFolder) knows where the original's cells run.
  const dir = copyOrigin(uri);
  return dir ? vscode.Uri.file(path.join(dir, original)).toString() : vscode.Uri.joinPath(uri, '..', original).toString();
}

/** A block's past runs that passed (seconds, oldest first), for its learned estimate; undefined without any. */
function learnedRuns(cell: vscode.NotebookCell): number[] | undefined {
  if (!memento || cell.kind !== vscode.NotebookCellKind.Code || !optionsOn() || !learning() || isCallLanguage(cell.document.languageId)) return undefined;
  const meta: unknown = cell.metadata?.[META_KEY];
  if (!isCodeMeta(meta)) return undefined;
  return memento.get<History>(HISTORY_KEY)?.[historyOf(cell.notebook.uri)]?.[stepHistoryKey(meta.info, cell.document.getText())];
}

/** From 3 runs on, how much they varied: ` (28s–41s over its last 4 runs)`; else ''. */
function learnedRange(cell: vscode.NotebookCell): string {
  const runs = learnedRuns(cell)?.slice(-HISTORY_RUNS);
  if (!runs || runs.length < 3) return '';
  return ` (${formatEstimate(Math.min(...runs))}–${formatEstimate(Math.max(...runs))} over its last ${runs.length} runs)`;
}

/** A block without estimate=: the usual time of its past runs that passed (learnedEstimate), or undefined. */
export function learnedSeconds(cell: vscode.NotebookCell): number | undefined {
  const runs = learnedRuns(cell);
  return runs ? learnedEstimate(runs) : undefined;
}

/** The block's time: its estimate=, else (`learned`) the usual time of its past runs. */
export function blockEstimate(cell: vscode.NotebookCell): { seconds: number; learned: boolean } | undefined {
  const declared = cellEstimate(cell);
  if (declared !== undefined) return { seconds: declared, learned: false };
  const learned = learnedSeconds(cell);
  return learned !== undefined ? { seconds: learned, learned: true } : undefined;
}

/** Keeps how long a run that passed took, for its step's learned estimate (not line runs, skips or the ready check). */
async function recordRun(run: RunRecord): Promise<void> {
  if (!memento || !learning() || !run.success || run.plan.steps || run.plan.skip || run.ready !== undefined || run.cell.kind !== vscode.NotebookCellKind.Code) return;
  const meta: unknown = run.cell.metadata?.[META_KEY];
  const ms = run.attrs.duration !== undefined ? parseInterval(run.attrs.duration) : undefined;
  if (!isCodeMeta(meta) || ms === undefined) return;
  const all: History = { ...(memento.get<History>(HISTORY_KEY) ?? {}) };
  const nb = historyOf(run.notebook.uri);
  const steps = { ...(all[nb] ?? {}) };
  const key = stepHistoryKey(meta.info, run.cell.document.getText());
  steps[key] = withDuration(steps[key], ms / 1000);
  // Most recently run last: the oldest runbooks are dropped past the limit.
  delete all[nb];
  all[nb] = steps;
  const names = Object.keys(all);
  for (const old of names.slice(0, Math.max(0, names.length - HISTORY_RUNBOOKS))) delete all[old];
  await memento.update(HISTORY_KEY, all);
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
    const seconds = blockEstimate(c)?.seconds;
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
 * bar (`████████░░… 1m of 2m30s`, then `⚠ ███…█ +1m20s over 2m30s`); after a run noticeably over
 * it, how long it took (`est. 2m30s · took 3m10s (+40s)`, a click sets estimate= to it), with a
 * warning past twice it. Undefined for a block without an estimate.
 */
export function estimateItem(cell: vscode.NotebookCell, now = Date.now()): { text: string; tooltip: string; label: string; setTo?: number } | undefined {
  const block = blockEstimate(cell);
  if (block === undefined) {
    // A call whose src= has placeholders: what it runs is known when it runs.
    const meta: unknown = cell.metadata?.[META_KEY];
    const src = isCallLanguage(cell.document.languageId) && isCodeMeta(meta) ? parseCall(meta.info, '').src : undefined;
    if (src !== undefined && isDynamicSrc(src) && optionsOn()) {
      return {
        text: '$(watch) estimate unknown until run',
        tooltip: `src="${src}" is known when the call runs; add estimate= to the block to show one.`,
        label: 'Estimate unknown until the call runs',
      };
    }
    return undefined;
  }
  const est = block.seconds;
  const fmt = block.learned ? formatLearned : formatEstimate;
  const learnedNote = block.learned ? `${learnedRange(cell)}; it has no estimate=, so this is the usual time of its last runs that passed` : '';
  const since = runningSince(cell);
  if (since !== undefined) {
    const elapsed = (now - since) / 1000;
    const overSeconds = blockProgress(elapsed, est).overSeconds;
    const over = overSeconds > 0;
    return {
      text: `${over ? '$(warning)' : '$(watch)'} ${formatBlockProgress(elapsed, est, BAR_WIDTH, blockBar)}`,
      // Read out as words, not the bar's block characters.
      label: over ? `Running, ${spoken(overSeconds)} over the estimate of ${spoken(est)}` : `Running, ${spoken(elapsed)} of ${spoken(est)}`,
      tooltip: block.learned
        ? `Running for ${formatEstimate(elapsed)}; this block usually takes ${fmt(est)}${learnedNote}.`
        : `Running for ${formatEstimate(elapsed)}; this block's estimate (estimate=) is ${formatEstimate(est)}.`,
    };
  }
  const took = lastDuration(cell);
  const extra = took !== undefined ? overEstimate(took, est) : undefined;
  if (took !== undefined && extra !== undefined) {
    const setTo = suggestedEstimate(took);
    return {
      text: `${isOverEstimate(took, est) ? '$(warning)' : '$(watch)'} est. ${fmt(est)} · took ${formatEstimate(took)} (+${formatEstimate(extra)})`,
      tooltip: `The last run took ${formatEstimate(took)}, ${formatEstimate(extra)} more than ${block.learned ? 'this block usually takes' : "this block's estimate"}. Click to set estimate=${formatEstimate(setTo)}.`,
      label: `Estimate ${spoken(est)}, the last run took ${spoken(took)}, ${spoken(extra)} more`,
      setTo,
    };
  }
  if (block.learned) {
    return {
      text: `$(watch) est. ${fmt(est)}`,
      tooltip: `This block usually takes ${formatEstimate(est)}${learnedNote}. Click to write it into the runbook as estimate=${formatEstimate(est)}.`,
      label: `Usually takes about ${spoken(est)}`,
      setTo: est,
    };
  }
  return {
    text: `$(watch) est. ${formatEstimate(est)}`,
    tooltip: 'How long this block takes, as measured on a real run (estimate=). It does not change how it runs.',
    label: `Estimate ${spoken(est)}`,
  };
}

/** A duration as a screen reader should say it: `2 minutes 30 seconds` (formatEstimate's `2m30s`). */
function spoken(seconds: number): string {
  const whole = Math.round(Math.max(0, seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const unit = (n: number, name: string): string => `${n} ${name}${n === 1 ? '' : 's'}`;
  return [h ? unit(h, 'hour') : '', m ? unit(m, 'minute') : '', s || (!h && !m) ? unit(s, 'second') : ''].filter(Boolean).join(' ');
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
    item.accessibilityInformation = { label: s.label };
    if (s.setTo !== undefined) item.command = { title: 'Set estimate=', command: SET_ESTIMATE, arguments: [cell.notebook.uri.toString(), cell.index, s.setTo] };
    return [item];
  }

  /** Redraw now, and every second while a block with an estimate runs. */
  refresh(): void {
    this.changed.fire();
    const nb = vscode.window.activeNotebookEditor?.notebook;
    const ticking = nb?.notebookType === NOTEBOOK_TYPE && nb.getCells().some((c) => runningSince(c) !== undefined && blockEstimate(c) !== undefined);
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

export function registerEstimates(context: vscode.ExtensionContext, pipeline?: RunPipeline): void {
  const status = new EstimateStatus();
  memento = context.workspaceState;
  pipeline?.observers.push({ onDidRunCell: (run) => recordRun(run).then(() => status.refresh()) });
  context.subscriptions.push(
    vscode.commands.registerCommand('mdRunbook.forgetLearnedTimes', async (arg?: unknown) => {
      const nb = arg instanceof vscode.Uri ? vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === arg.toString()) : vscode.window.activeNotebookEditor?.notebook;
      const name = nb?.notebookType === NOTEBOOK_TYPE ? path.posix.basename(nb.uri.path) : undefined;
      const pick = await vscode.window.showQuickPick(
        [
          ...(name ? [{ label: `Forget the times of ${name}`, id: 'one' }] : []),
          { label: 'Forget the times of every runbook', id: 'all' },
        ],
        { title: 'Forget Learned Times', placeHolder: 'Blocks without estimate= learn their usual time again from their next runs' },
      );
      if (!pick || !memento) return;
      const all: History = { ...(memento.get<History>(HISTORY_KEY) ?? {}) };
      if (pick.id === 'one' && nb) delete all[historyOf(nb.uri)];
      await memento.update(HISTORY_KEY, pick.id === 'all' ? {} : all);
      status.refresh();
    }),
  );
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

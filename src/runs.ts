/**
 * Run history: a small record of each run of a runbook (when, who, how far, what failed), kept in
 * workspace state and never in the file. **Show Runs…** lists them and opens the transcript at a
 * run; the status bar tooltip says when the runbook last ran green; lint marks the steps that
 * never ran in any recorded run. The pure parts are in runHistory.ts.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isCodeMeta, stepHistoryKey } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { osGroups } from '@md-runbook/core/os';
import { proposalOf } from '@md-runbook/core/proposal';
import { isCallCopy } from './calls';
import { SECTION } from './config';
import { showRunbook } from './currentRunbook';
import { historyOf } from './estimates';
import { META_KEY } from './outputs';
import type { RunPipeline, RunRecord } from './pipeline';
import { labelOf, notebookProgress } from './progress';
import { RunStore, RunSummary, lastGreenOf, lastGreenText, ranSteps, runItem, transcriptLine, withRun } from './runHistory';
import { NOTEBOOK_TYPE } from './serializer';
import { transcriptPathFor } from './transcript';
import { hostSkipped } from './remoteHosts';

/** Runs per runbook (runHistory.ts RunStore), in workspace state. */
const RUNS_KEY = 'mdRunbook.runHistory';
let memento: vscode.Memento | undefined;
const changed = new vscode.EventEmitter<string>();
/** A run was recorded: the key (runsKeyOf) of the runbook it counts for. */
export const onDidChangeRuns = changed.event;

/** Whose runs a runbook has: its own, or for a run copy its original's (as learned times do). */
export const runsKeyOf = (uri: vscode.Uri): string => historyOf(uri);
/** The steps that ran, per history key: lint asks on every edit, the store changes once a run. */
const ranCache = new Map<string, Set<string>>();

function userName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

/** The runbook's recorded runs, oldest first (a run copy's count for its original). */
export function runsOf(nb: { uri: vscode.Uri }): RunSummary[] {
  return memento?.get<RunStore>(RUNS_KEY)?.[historyOf(nb.uri)] ?? [];
}

/** The last run after which every step of the runbook was done (no failure, nothing to do), or undefined. */
export function lastGreen(nb: vscode.NotebookDocument): { at: number; by?: string } | undefined {
  return lastGreenOf(runsOf(nb));
}

/** `Last ran green: 3 days ago (by smojon)` or `Never ran green`, for the status bar tooltip. */
export function lastGreenLine(nb: vscode.NotebookDocument): string {
  return lastGreenText(lastGreen(nb));
}

const codeInfo = (cell: vscode.NotebookCell): string | undefined => {
  const meta: unknown = cell.metadata?.[META_KEY];
  return cell.kind === vscode.NotebookCellKind.Code && isCodeMeta(meta) ? meta.info : undefined;
};

/** The step key of a code cell, as estimates.ts learns its times by. */
const stepKey = (cell: vscode.NotebookCell): string => stepHistoryKey(codeInfo(cell) ?? '', cell.document.getText());

/**
 * Code steps that never ran in any recorded run and have no output now, for lint's hint. None
 * until the runbook has a run recorded, and never a block that doesn't run here: `skip`, `host=`,
 * another OS's alternative, a proposal waiting for approval.
 */
export function neverRanCells(nb: vscode.NotebookDocument): number[] {
  if (!memento || nb.notebookType !== NOTEBOOK_TYPE) return [];
  const key = historyOf(nb.uri);
  let ran = ranCache.get(key);
  if (!ran) {
    const runs = memento.get<RunStore>(RUNS_KEY)?.[key];
    if (!runs?.length) return [];
    ran = ranSteps(runs);
    ranCache.set(key, ran);
  }
  const optionsOn = vscode.workspace.getConfiguration(SECTION).get<boolean>('cellOptions.enabled', true);
  const cells = nb.getCells();
  const opts = cells.map((c) => {
    const info = codeInfo(c);
    return info !== undefined && optionsOn ? parseCellOptions(info) : undefined;
  });
  const slots = osGroups(cells.map((c, i) => ({ kind: c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup', ...(opts[i]?.os ? { os: opts[i]!.os } : {}) })));
  const hints: number[] = [];
  cells.forEach((c, i) => {
    const info = codeInfo(c);
    if (info === undefined || c.outputs.length > 0 || c.document.getText().trim() === '') return;
    const o = opts[i];
    if (o?.skip || hostSkipped(info, c.notebook) || (slots[i] && !slots[i]!.active) || proposalOf(info).state === 'proposed') return;
    if (!ran!.has(stepKey(c))) hints.push(i);
  });
  return hints;
}

/** The record of a run that just ended, from its cells' results and the runbook's progress now. */
function summarize(nb: vscode.NotebookDocument, runs: readonly RunRecord[], startedAt: number | undefined): RunSummary {
  const p = notebookProgress(nb);
  const ran = runs.map((r) => Date.parse(r.attrs.ran ?? '')).filter((t) => Number.isFinite(t));
  const started = ran.length > 0 ? Math.min(...ran) : (startedAt ?? Date.now());
  const ended = Math.max(Date.now(), started);
  const where = (cell: vscode.NotebookCell): { cell: number; step?: number; label: string } => {
    const step = p.stepOfCell[cell.index];
    return { cell: cell.index, ...(step !== undefined ? { step } : {}), label: labelOf(cell) };
  };
  const failed = runs.find((r) => !r.success && !r.plan.skip);
  const only = runs.length === 1 ? runs[0] : undefined;
  return {
    started,
    ended,
    uri: nb.uri.toString(),
    by: userName(),
    cells: runs.map((r) => r.cell.index),
    // What really ran: not a cell skipped by an option or a declined confirmation.
    steps: [...new Set(runs.filter((r) => !r.plan.skip && r.cell.kind === vscode.NotebookCellKind.Code).map((r) => stepKey(r.cell)))],
    passed: runs.filter((r) => r.success && !r.plan.skip).length,
    failed: runs.filter((r) => !r.success && !r.plan.skip).length,
    skipped: runs.filter((r) => r.plan.skip).length,
    total: p.total,
    complete: p.done + p.skipped,
    green: p.total > 0 && p.pending === 0 && p.failed === 0 && !p.firstFailed,
    ...(failed ? { firstFailed: where(failed.cell) } : {}),
    ...(failed?.result.cancelled ? { stopped: true } : {}),
    ...(only ? { single: where(only.cell) } : {}),
  };
}

async function record(nb: vscode.NotebookDocument, runs: readonly RunRecord[], startedAt: number | undefined): Promise<void> {
  // A runbook call's copy: the calling cell's run is the record.
  if (!memento || runs.length === 0 || nb.notebookType !== NOTEBOOK_TYPE || isCallCopy(nb.uri)) return;
  const key = historyOf(nb.uri);
  await memento.update(RUNS_KEY, withRun(memento.get<RunStore>(RUNS_KEY), key, summarize(nb, runs, startedAt)));
  ranCache.delete(key);
  changed.fire(key);
}

/**
 * Open a run: its transcript at the run's first entry, when the transcript has it (also the
 * rotated `.1`); else the runbook it ran in, at the step that failed.
 */
async function openRun(nb: vscode.NotebookDocument, r: RunSummary): Promise<void> {
  const uri = vscode.Uri.parse(r.uri);
  const file = transcriptPathFor({ uri });
  for (const f of file ? [file, `${file}.1`] : []) {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
    } catch {
      continue;
    }
    const line = transcriptLine(doc.getText(), r.started, r.ended);
    if (line === undefined) continue;
    const at = new vscode.Range(line, 0, line, 0);
    const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside, selection: at });
    editor.revealRange(at, vscode.TextEditorRevealType.AtTop);
    return;
  }
  vscode.window.setStatusBarMessage('md-runbook: the transcript has no entry of this run (it was off, or the file was rotated)', 8000);
  if (r.uri !== nb.uri.toString()) {
    // A run copy: show it, if it is still there.
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE);
      return;
    } catch {
      // Deleted: the runbook it was copied from.
    }
  }
  await showRunbook(nb, r.uri === nb.uri.toString() ? r.firstFailed?.cell : undefined);
}

function notebookOf(arg: unknown): vscode.NotebookDocument | undefined {
  const nb = arg instanceof vscode.Uri ? vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === arg.toString()) : vscode.window.activeNotebookEditor?.notebook;
  return nb?.notebookType === NOTEBOOK_TYPE ? nb : undefined;
}

async function showRuns(arg?: unknown): Promise<void> {
  const nb = notebookOf(arg);
  if (!nb) return void vscode.window.showInformationMessage('md-runbook: open a runbook to see its runs.');
  const runs = [...runsOf(nb)].reverse();
  if (runs.length === 0) return void vscode.window.showInformationMessage('md-runbook: no run of this runbook is recorded yet. Each run from now on is listed here.');
  const now = Date.now();
  const pick = await vscode.window.showQuickPick(
    runs.map((r) => ({ ...runItem(r, now), run: r })),
    {
      title: `Runs of ${path.posix.basename(nb.uri.path)}`,
      placeHolder: `${lastGreenText(lastGreenOf(runsOf(nb)), now)} · newest first · pick one to open its transcript`,
      matchOnDetail: true,
    },
  );
  if (pick) await openRun(nb, pick.run);
}

export function registerRuns(context: vscode.ExtensionContext, pipeline: RunPipeline): void {
  memento = context.workspaceState;
  /** When each runbook's run was asked for, for a run whose cells carry no start time. */
  const asked = new Map<string, number>();
  pipeline.observers.push({
    onWillRunSequence: (nb) => void asked.set(nb.uri.toString(), Date.now()),
    onDidRunSequence: async (nb, runs) => {
      const at = asked.get(nb.uri.toString());
      asked.delete(nb.uri.toString());
      await record(nb, runs, at);
    },
  });
  context.subscriptions.push(
    changed,
    vscode.commands.registerCommand('mdRunbook.showRuns', showRuns),
    // For tests: the runbook's run records (default: the active one), newest first.
    vscode.commands.registerCommand('mdRunbook._runs', (uri?: vscode.Uri) => {
      const nb = uri instanceof vscode.Uri ? { uri } : notebookOf(undefined);
      return nb ? [...runsOf(nb)].reverse() : undefined;
    }),
  );
}

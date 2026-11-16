/**
 * The launch form: before a Run All, one sheet in the Steps view (stepsPage.ts) with what the run
 * will need and do. The parameters (described, a list when the front matter gives choices) and
 * the inputs to type, the secrets to set, the risky steps (each still asks when it runs), the
 * steps done by hand, the time and the context. Start puts the values in the session
 * (secrets.ts setSessionValues) and runs: the values asked up front are then already there.
 */

import * as vscode from 'vscode';
import { formatEstimate, formatLeft, runbookEstimate, withoutEstimate } from '@md-runbook/core/estimate';
import { isCallLanguage } from '@md-runbook/core/call';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { SECTION } from './config';
import { notebookEstimateSteps } from './estimates';
import { cellAttrs } from './progress';
import type { LaunchValues } from './secrets';
import type { StepsRow } from './stepsView';

/** What the form needs from safety.ts and secrets.ts (wired in extension.ts). */
export interface LaunchSources {
  /** undefined if running `source` in the cell won't ask for a confirmation; else the risky words ('' when it always asks). */
  confirmation(cell: vscode.NotebookCell, source: string): string | undefined;
  launchValues(nb: vscode.NotebookDocument, cells: readonly vscode.NotebookCell[]): LaunchValues;
  setSessionValues(nb: vscode.NotebookDocument, values: { params?: Readonly<Record<string, string>>; inputs?: Readonly<Record<string, string>> }): void;
  setSecret(name: string): Promise<void>;
  /** The last context recorded for the runbook (mdRunbook.output.recordContext), if any. */
  context(nb: vscode.NotebookDocument): Record<string, string> | undefined;
}

export interface LaunchModel extends LaunchValues {
  title: string;
  uri: string;
  /** Steps that will ask for a confirmation when they run, with the first lines of their command. */
  risky: { index: number; step?: number; label: string; match: string; lines: string[]; more: number }[];
  /** Unticked checklist items: Run All waits at each, unless the front matter says `manual-steps: continue`. */
  byHand: { index: number; step?: number; label: string }[];
  byHandWaits: boolean;
  /** `about 4 min`, `about 40s · 1 block without an estimate`. */
  time?: string;
  /** What the run records about where it runs (output.recordContext), as last seen. */
  context?: { name: string; value: string }[];
  /** Context recording is on, but nothing is known yet. */
  contextLater?: boolean;
  /** The front matter's kube-context: every step checks it. */
  kubeContext?: string;
  /** Something to type, set or look at: a parameter, an input, a secret not stored, a risky step. */
  needed: boolean;
}

const PREVIEW_LINES = 3;

/** The command as it will run, its first few lines (as the confirmation shows it). */
function preview(source: string): { lines: string[]; more: number } {
  const lines = source.split(/\r?\n/).filter((l) => l.trim() !== '');
  return { lines: lines.slice(0, PREVIEW_LINES), more: Math.max(0, lines.length - PREVIEW_LINES) };
}

/** The time a whole run takes by the estimates (Run All runs every step again). */
function runTime(nb: vscode.NotebookDocument): string | undefined {
  const steps = notebookEstimateSteps(nb, cellAttrs).map((s) => ({
    ...(s.estimateSeconds !== undefined ? { estimateSeconds: s.estimateSeconds } : {}),
    ...(s.part ? { part: s.part } : {}),
    state: 'pending' as const,
  }));
  const e = runbookEstimate(steps);
  if (e.blocks === 0) return undefined;
  const total = e.totalSeconds > 0 ? (e.totalSeconds < 120 ? `about ${formatEstimate(e.totalSeconds)}` : formatLeft(e.totalSeconds)) : '';
  return [total, e.unestimated > 0 ? withoutEstimate(e.unestimated) : ''].filter((s) => s !== '').join(' · ');
}

/** The form's content for a Run All of `nb`; `rows` are the Steps view's (stepsModel). Asks nothing, runs nothing. */
export function launchModel(nb: vscode.NotebookDocument, rows: readonly StepsRow[], sources: LaunchSources): LaunchModel {
  const values = sources.launchValues(nb, nb.getCells());
  const risky: LaunchModel['risky'] = [];
  const byHand: LaunchModel['byHand'] = [];
  for (const r of rows) {
    if (r.kind !== 'step') continue;
    const step = r.step !== undefined ? { step: r.step } : {};
    if (r.task) {
      if (!r.task.checked) byHand.push({ index: r.index, ...step, label: r.detail ?? r.label });
      continue;
    }
    const cell = nb.cellAt(r.index);
    if (cell.kind !== vscode.NotebookCellKind.Code) continue;
    // A runbook call's lines are values passed, not commands: only `confirm` asks (safety.ts).
    const source = cell.document.getText();
    const match = sources.confirmation(cell, isCallLanguage(cell.document.languageId) ? '' : source);
    if (match === undefined) continue;
    risky.push({ index: r.index, ...step, label: r.label, match: match.trim(), ...preview(source) });
  }
  const recording = Object.values(vscode.workspace.getConfiguration(SECTION).get<Record<string, unknown>>('output.recordContext', {})).some((v) => typeof v === 'string' && v.trim() !== '');
  const known = recording ? sources.context(nb) : undefined;
  const first = nb.cellCount > 0 ? nb.cellAt(0) : undefined;
  const fm = first?.kind === vscode.NotebookCellKind.Markup ? parseFrontMatter(first.document.getText()) : undefined;
  const kubeContext = fm?.kubeContext;
  const time = runTime(nb);
  return {
    title: nb.uri.path.split('/').pop() ?? 'runbook',
    uri: nb.uri.toString(),
    ...values,
    risky,
    byHand,
    byHandWaits: fm?.manualSteps !== 'continue',
    ...(time ? { time } : {}),
    ...(known && Object.keys(known).length > 0 ? { context: Object.entries(known).map(([name, value]) => ({ name, value })) } : recording ? { contextLater: true } : {}),
    ...(kubeContext ? { kubeContext } : {}),
    needed: values.params.length > 0 || values.inputs.length > 0 || values.secrets.some((s) => !s.stored) || risky.length > 0,
  };
}

export { startValues } from './launchStart';

/** Runs the form started: the Run All they start doesn't open the form again (for 30 s). */
const started = new Map<string, number>();

export function markStartedFromForm(nb: vscode.NotebookDocument): void {
  started.set(nb.uri.toString(), Date.now());
}

/** True, once, for a run the form just started. */
export function takeStartedFromForm(nb: vscode.NotebookDocument): boolean {
  const at = started.get(nb.uri.toString());
  started.delete(nb.uri.toString());
  return at !== undefined && Date.now() - at < 30_000;
}

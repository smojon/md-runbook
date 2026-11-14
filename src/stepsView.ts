/**
 * The Steps view (its own activity-bar container): the runbook's progress as a rail beside its steps, the same
 * as the app's rail but with room for names. At the top, where the run is (the status bar's
 * words), the bar and the time left; then the chapters (`#`/`##` headings) and the steps, each
 * with its state on the rail, its name and its time; the running one with its bar against its
 * estimate; a pale band for the cells on screen. A row goes to its cell. It shows the current
 * runbook (currentRunbook.ts), and an empty state when there is none. The page is in stepsPage.ts.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatEstimate, formatLearned, isCodeMeta, parseLineSet, runbookEstimate, stepState, taskItems } from '@md-runbook/core';
import { blockProgress, finishTime, overEstimate, remaining, stepLabel, withoutEstimate } from '@md-runbook/core/estimate';
import { headingsOf, withoutFrontMatter } from '@md-runbook/core/title';
import { setContext } from './contextKeys';
import { currentRunbook, editorOf, onDidChangeCurrentRunbook, showRunbook } from './currentRunbook';
import { isCallLanguage } from '@md-runbook/core/call';
import { cellPart } from './controller';
import { blockEstimate, lastDuration, notebookEstimateSteps, notebookPartStates, runningSince } from './estimates';
import { META_KEY, outputMeta } from './outputs';
import { isManualMark } from '@md-runbook/core/progress';
import { proposalOf } from '@md-runbook/core/proposal';
import { cellAttrs, notebookHeadings, notebookProgress, progressStatus, selectRunbookKernel } from './progress';
import { RunPipeline } from './pipeline';
import { isTestMode } from './secrets';
import { stepsPage } from './stepsPage';
import { setTaskBox } from './taskLists';
import { NOTEBOOK_TYPE } from './serializer';
import { onDidChangeWaiting, waitingAnswers, waitingIn } from './waiting';

export const STEPS_VIEW = 'mdRunbook.steps';
const REVEALED_KEY = 'mdRunbook.stepsViewShown';

export type StepRowState = 'done' | 'skipped' | 'failed' | 'running' | 'pending' | 'waiting';

export type StepsRow =
  | { kind: 'chapter'; index: number; title: string; level: number }
  | {
      kind: 'step';
      index: number;
      /** 1-based step number; undefined for the ready check and an offered teardown. */
      step?: number;
      label: string;
      state: StepRowState;
      /** What the time column says: `est. 2m30s`, `took 3m10s (+40s)`, `12s of 1m`. */
      time?: string;
      over?: boolean;
      /** The running step's share of its estimate, 0 to 1. */
      fraction?: number;
      /** A checklist item (a step done by hand): where its box is in the cell, and whether it's ticked. */
      task?: { offset: number; checked: boolean };
      /** A code cell that can be run from the view. */
      runnable?: boolean;
      /** Marked done or skipped by hand (Mark Step): Unmark undoes it. */
      marked?: boolean;
      /** Preflight: what running it will need from you (a confirmation, a secret, a value, an approval). */
      needs?: string[];
      /** The step is the only one under a `#`/`##` heading: one row, named by the heading (its level). */
      chapter?: number;
      /** Such a row's own step name, when it differs from the heading. */
      detail?: string;
      /** A failed step: the last line of its error output (stderr, else the output), cut short. */
      error?: string;
      /** The step waits for a question asked on its cell (waiting.ts askOnCell): its buttons. */
      answers?: { id: string; label: string; icon?: string; tooltip?: string }[];
    };

/** One count of the preflight line, which the view makes a link. */
export interface PreflightPart {
  kind: 'confirmation' | 'secret' | 'value' | 'proposal' | 'byHand';
  /** `2 secrets to set`. */
  text: string;
  /** The first step that needs it (a confirmation, a proposal, a step by hand). */
  index?: number;
  /** The secrets to set, by name. */
  names?: string[];
}

export interface StepsModel {
  title: string;
  headline: string;
  state: 'idle' | 'running' | 'failed' | 'done' | 'waiting';
  /** By the estimates: share done, time left, finish time. */
  fraction?: number;
  /** The share done as shown: never 100 while a step is open. */
  percent?: number;
  left?: string;
  rows: StepsRow[];
  /** Steps still to do or failed (the view's badge). */
  open: number;
  /** Preflight, before a run: what the steps still to do will need, in one line. */
  preflight?: string;
  /** The same line's counts, each a link in the view. */
  preflightParts?: PreflightPart[];
  /** After a failure: the failed step's cell (Retry step). */
  failedCell?: number;
  /** Resume Run has something to do (a step done, and one still to do or failed). */
  canResume: boolean;
  /** The cells on screen, first and last index. */
  visible?: { first: number; last: number };
}

/** What the view can learn about a step before it runs, without asking anything (safety.ts, secrets.ts). */
export interface PreflightSources {
  /** undefined if running `source` won't ask for a confirmation. */
  confirmation(cell: vscode.NotebookCell, source: string): string | undefined;
  /** The step's `${…}` values as they stand now (a `shown` text when there is none yet). */
  values(nb: vscode.NotebookDocument, source: string): { kind: string; name: string; shown?: string }[];
}

/** What running `cell` will need from you, in short phrases; nothing for a step that needs nothing. */
export function stepNeeds(cell: vscode.NotebookCell, info: string, sources: PreflightSources): string[] {
  const needs: string[] = [];
  const source = cell.document.getText();
  if (proposalOf(info).state === 'proposed') needs.push('approval (proposed)');
  if (sources.confirmation(cell, source) !== undefined) needs.push('your confirmation');
  for (const v of sources.values(cell.notebook, source)) {
    if (v.shown === undefined) continue;
    if (v.kind === 'secret') needs.push(`secret ${v.name} (not stored)`);
    else if (v.kind === 'input' || v.kind === 'param') needs.push(`${v.kind === 'param' ? 'parameter' : 'input'} ${v.name}`);
    else if (v.kind === 'out') needs.push(`${v.name} from an earlier step`);
  }
  return needs;
}

const STDERR = 'application/vnd.code.notebook.stderr';
const STDOUT = 'application/vnd.code.notebook.stdout';
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ERROR_MAX = 120;
const decoder = new TextDecoder();

/** Why a step failed, in one line: the last non-empty line of its stderr, else of its output. */
export function errorLine(cell: vscode.NotebookCell): string | undefined {
  const err: string[] = [];
  const out: string[] = [];
  for (const o of cell.outputs) {
    const m = outputMeta(o);
    // The status line, earlier runs and cloud tables are not what the step printed.
    if (m?.status || m?.earlier || m?.cloud) continue;
    for (const item of o.items) {
      if (item.mime !== STDERR && item.mime !== STDOUT && item.mime !== 'text/plain') continue;
      const lines = decoder.decode(item.data).replace(ANSI_RE, '').split(/\r?\n/);
      if (m?.persisted) {
        // Loaded from the file: one text, its stderr lines listed on the output marker.
        const errs = parseLineSet(cellAttrs(cell)?.stderr);
        lines.forEach((l, n) => (errs.has(n) ? err : out).push(l));
      } else (item.mime === STDERR ? err : out).push(...lines);
    }
  }
  const last = (lines: string[]): string | undefined => lines.map((l) => l.trim()).filter(Boolean).pop();
  const line = last(err) ?? last(out);
  return line !== undefined && line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

/** The buttons of a question asked on the cell (Done / Skip / Stop, Take Down / Leave It Up), for its row. */
function answersOf(cell: vscode.NotebookCell): { id: string; label: string; icon?: string; tooltip?: string }[] {
  return waitingAnswers(cell).map((a) => ({ id: a.id, label: a.label, ...(a.icon ? { icon: a.icon } : {}), ...(a.tooltip ? { tooltip: a.tooltip } : {}) }));
}

/** A chapter with only one step under it is one row: the heading, with the step's dot, number and time. */
function mergeLoneSteps(rows: StepsRow[]): StepsRow[] {
  const merged: StepsRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const next = rows[i + 1];
    const after = rows[i + 2];
    // Only a numbered step (not the ready check or an offered teardown), and nothing else before the next chapter.
    if (r.kind === 'chapter' && next?.kind === 'step' && next.step !== undefined && (after === undefined || after.kind === 'chapter')) {
      merged.push({ ...next, label: r.title, chapter: r.level, ...(next.label !== r.title ? { detail: next.label } : {}) });
      i++;
    } else merged.push(r);
  }
  return merged;
}

/** The view's content for a runbook, from the same model as the status bar. */
export function stepsModel(nb: vscode.NotebookDocument, visible?: { first: number; last: number }, now = Date.now(), sources?: PreflightSources): StepsModel {
  const p = notebookProgress(nb);
  const status = progressStatus(nb, p, now);
  const e = runbookEstimate(notebookEstimateSteps(nb, cellAttrs, now), notebookPartStates(nb, cellAttrs));
  const waiting = waitingIn(nb);
  const rows: StepsRow[] = [];
  let anyRunning = false;
  let waitingShown = false;
  /** The last step number given (a block's from the progress, checklist items counted on). */
  let taskStep = 0;
  const headings = notebookHeadings(nb);
  for (const cell of nb.getCells()) {
    const i = cell.index;
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      const text = cell.document.getText();
      const lines = text.split(/\r?\n/);
      // Headings and checklist items in line order, so an item stays under its own heading.
      const body = i === 0 ? withoutFrontMatter(text) : text;
      const above = lines.length - body.split(/\r?\n/).length;
      const marks = [
        ...headingsOf(body)
          .filter((h) => h.level <= 2)
          .map((h) => ({ line: h.line + above, heading: h, item: undefined })),
        ...taskItems(text).map((item) => ({ line: item.line, heading: undefined, item })),
      ].sort((a, b) => a.line - b.line);
      for (const { heading: h, item } of marks) {
        if (h) {
          rows.push({ kind: 'chapter', index: i, title: h.text, level: h.level });
          continue;
        }
        if (!item) continue;
        // Checklist items are steps too (manual ones): numbered in order with the blocks.
        taskStep++;
        // The first unticked item of a cell Run All waits at (controller.ts manualStepsBefore).
        const isWaiting = !item.checked && waiting?.cell === cell && !waitingShown;
        if (isWaiting) waitingShown = true;
        const answers = isWaiting ? answersOf(cell) : [];
        rows.push({
          kind: 'step',
          index: i,
          step: taskStep,
          label: (lines[item.line] ?? '').replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]*/, '') || 'checklist item',
          state: item.checked ? 'done' : isWaiting ? 'waiting' : 'pending',
          time: 'by hand',
          task: { offset: item.offset, checked: item.checked },
          ...(answers.length ? { answers } : {}),
        });
      }
      continue;
    }
    const step = p.stepOfCell[i];
    if (step !== undefined) taskStep = step;
    const meta: unknown = cell.metadata?.[META_KEY];
    const info = isCodeMeta(meta) ? meta.info : '';
    // Not a step: the ready check (a quick look) and a teardown not run yet (offered).
    const part = cellPart(cell);
    const offered = step === undefined && part === 'teardown' && p.resume.includes(i);
    const ready = step === undefined && part === 'ready';
    if (step === undefined && !offered && !ready) continue;
    const since = runningSince(cell);
    const block = blockEstimate(cell);
    const est = block?.seconds;
    const fmtEst = (s: number): string => (block?.learned ? formatLearned(s) : formatEstimate(s));
    const a = cellAttrs(cell);
    const s = stepState(a?.exit, a?.lines !== undefined, a?.check);
    let state: StepRowState = s === 'done' ? 'done' : s === 'skipped' ? 'skipped' : s === 'failed' ? 'failed' : 'pending';
    let time: string | undefined;
    let over = false;
    let fraction: number | undefined;
    if (waiting?.cell === cell) state = 'waiting';
    if (since !== undefined) {
      anyRunning = true;
      state = 'running';
      const elapsed = (now - since) / 1000;
      if (est !== undefined) {
        const b = blockProgress(elapsed, est);
        fraction = b.fraction;
        over = b.overSeconds > 0;
        time = over ? `+${formatEstimate(b.overSeconds)} over ${fmtEst(est)}` : `${formatEstimate(elapsed)} of ${fmtEst(est)}`;
      } else time = formatEstimate(elapsed);
    } else {
      const took = lastDuration(cell);
      const extra = took !== undefined && est !== undefined ? overEstimate(took, est) : undefined;
      if (took !== undefined && extra !== undefined) {
        time = `took ${formatEstimate(took)} (+${formatEstimate(extra)})`;
        over = true;
      } else if (took !== undefined && state !== 'pending') time = formatEstimate(took);
      else if (est !== undefined) time = `est. ${fmtEst(est)}`;
    }
    const label = stepLabel(info, cell.document.getText(), cell.document.languageId, headings[i]) || `cell ${i + 1}`;
    // Preflight: only for a step still to run (or to run again), and not while one runs.
    const needs = sources && (state === 'pending' || state === 'failed') && !ready && !offered ? stepNeeds(cell, info, sources) : [];
    const error = state === 'failed' ? errorLine(cell) : undefined;
    const answers = state === 'waiting' ? answersOf(cell) : [];
    rows.push({
      kind: 'step',
      index: i,
      ...(step !== undefined ? { step } : {}),
      label: offered ? `${label} (teardown, offered)` : ready ? `Ready check: ${label}` : label,
      state,
      ...(time !== undefined ? { time } : {}),
      // The ready check says what it answered, not only how long it took.
      ...(ready && a?.ready ? { time: a.ready === 'up' ? 'already up → setup skipped' : 'not up → setup runs' } : {}),
      ...(over ? { over } : {}),
      ...(fraction !== undefined ? { fraction } : {}),
      runnable: true,
      ...(isManualMark(a) ? { marked: true } : {}),
      ...(needs.length ? { needs } : {}),
      ...(error ? { error } : {}),
      ...(answers.length ? { answers } : {}),
    });
  }
  const done = p.pending === 0 && p.failed === 0 && p.total > 0;
  // Preflight in one line: what the steps still to do will need, before a run.
  const steps = rows.filter((r): r is Extract<StepsRow, { kind: 'step' }> => r.kind === 'step');
  const needing = (test: (n: string) => boolean): string[] => steps.flatMap((r) => (r.needs ?? []).filter(test));
  const first = (test: (r: Extract<StepsRow, { kind: 'step' }>) => boolean): number | undefined => steps.find(test)?.index;
  const isConfirm = (n: string): boolean => n === 'your confirmation';
  const isApproval = (n: string): boolean => n.startsWith('approval');
  const secrets = needing((n) => n.startsWith('secret '));
  const tally: [number, string, string, Omit<PreflightPart, 'text'>][] = [
    [needing(isConfirm).length, 'confirmation', 'confirmations', { kind: 'confirmation', index: first((r) => !!r.needs?.some(isConfirm)) }],
    [secrets.length, 'secret to set', 'secrets to set', { kind: 'secret', names: secrets.map((n) => n.split(' ')[1] ?? n) }],
    [needing((n) => n.startsWith('input ') || n.startsWith('parameter ')).length, 'value to type', 'values to type', { kind: 'value' }],
    [needing(isApproval).length, 'proposal to approve', 'proposals to approve', { kind: 'proposal', index: first((r) => !!r.needs?.some(isApproval)) }],
    [steps.filter((r) => r.task && !r.task.checked).length, 'step by hand', 'steps by hand', { kind: 'byHand', index: first((r) => !!r.task && !r.task.checked) }],
  ];
  const parts: PreflightPart[] = tally.filter(([n]) => n > 0).map(([n, one, many, part]) => ({ ...part, text: `${n} ${n === 1 ? one : many}` }));
  const preflight = sources && !anyRunning && !waiting && parts.length ? `Before you run: ${parts.map((x) => x.text).join(' · ')}` : undefined;
  // Never "100%" or "nothing left" while a step is open (core remaining()).
  const rest = remaining(e, p.pending);
  return {
    title: nb.uri.path.split('/').pop() ?? 'runbook',
    // While the run waits for the reader, say so, as the status bar does.
    headline: waiting ? `Waiting for you: ${waiting.what}` : status.text.replace(/^\$\([^)]+\)\s*/, ''),
    state: waiting ? 'waiting' : anyRunning ? 'running' : p.firstFailed ? 'failed' : done ? 'done' : 'idle',
    ...(e.fraction !== undefined ? { fraction: e.fraction } : {}),
    ...(rest.percent !== undefined
      ? {
          percent: rest.percent,
          left: [rest.left, e.unestimatedLeft > 0 ? withoutEstimate(e.unestimatedLeft) : '', ((t) => (t ? `ends ≈ ${t}` : ''))(finishTime(e, anyRunning, now))].filter((s) => s !== '').join(' · '),
        }
      : {}),
    rows: mergeLoneSteps(rows),
    open: p.pending + p.failed,
    ...(preflight ? { preflight, preflightParts: parts } : {}),
    ...(!waiting && !anyRunning && p.firstFailed ? { failedCell: p.firstFailed.cell } : {}),
    canResume: p.resume.length > 0 && p.done + p.skipped + p.failed > 0,
    ...(visible ? { visible } : {}),
  };
}

class StepsView implements vscode.WebviewViewProvider, vscode.Disposable {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sources?: PreflightSources,
  ) {}
  private view: vscode.WebviewView | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  /** The last model posted (tests read it). */
  last: StepsModel | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // The row buttons are codicons, shipped with the extension (scripts/build.js copies them to out/codicons).
    const codicons = vscode.Uri.joinPath(this.context.extensionUri, 'out', 'codicons');
    view.webview.options = { enableScripts: true, localResourceRoots: [codicons] };
    view.webview.html = stepsPage(view.webview, view.webview.asWebviewUri(vscode.Uri.joinPath(codicons, 'codicon.css')));
    view.webview.onDidReceiveMessage((m: unknown) => {
      const msg = m as {
        ready?: boolean;
        go?: unknown;
        run?: unknown;
        runFrom?: unknown;
        mark?: unknown;
        unmark?: unknown;
        as?: unknown;
        tick?: unknown;
        offset?: unknown;
        checked?: unknown;
        resume?: unknown;
        preflight?: unknown;
        openSample?: unknown;
        openAsRunbook?: unknown;
        answer?: unknown;
        cell?: unknown;
      };
      if (msg.ready) this.refresh();
      if (typeof msg.answer === 'string' && typeof msg.cell === 'number') {
        // A button of the question asked on that cell (waiting.ts): the same as the one on the cell.
        const nb = this.notebook();
        const cell = nb && msg.cell >= 0 && msg.cell < nb.cellCount ? nb.cellAt(msg.cell) : undefined;
        if (cell) void vscode.commands.executeCommand('mdRunbook.answerWaiting', cell.document.uri.toString(), msg.answer);
      }
      if (msg.resume === true) void this.resume();
      if (typeof msg.preflight === 'string') void this.preflight(msg.preflight);
      if (msg.openSample === true) void vscode.commands.executeCommand('mdRunbook.openSample');
      if (msg.openAsRunbook === true) void openAsRunbook();
      if (typeof msg.go === 'number') void this.go(msg.go);
      if (typeof msg.run === 'number') void this.run(msg.run, msg.run + 1);
      if (typeof msg.runFrom === 'number') void this.run(msg.runFrom, Number.MAX_SAFE_INTEGER);
      if (typeof msg.mark === 'number' && (msg.as === 'done' || msg.as === 'skipped')) void this.mark(msg.mark, msg.as);
      if (typeof msg.unmark === 'number') {
        const cell = this.notebook()?.cellAt(msg.unmark);
        if (cell) void vscode.commands.executeCommand('mdRunbook.unmarkStep', cell);
      }
      if (typeof msg.tick === 'number' && typeof msg.offset === 'number' && typeof msg.checked === 'boolean') void this.tick(msg.tick, msg.offset, msg.checked);
    });
    view.onDidChangeVisibility(() => this.refresh());
    view.onDidDispose(() => (this.view = undefined));
  }

  /** The runbook the view shows: the one in front, else one that runs or waits, else the last one (currentRunbook.ts). */
  private notebook(): vscode.NotebookDocument | undefined {
    return currentRunbook();
  }

  /** Goes to the cell, bringing the runbook to front if another file is. */
  private async go(index: number): Promise<void> {
    const nb = this.notebook();
    if (!nb || index < 0 || index >= nb.cellCount) return;
    await showRunbook(nb, index);
  }

  /** Run the code cells from `start` up to (not including) `end`, as Run Below does. */
  async run(start: number, end: number): Promise<void> {
    const nb = this.notebook();
    if (!nb || start < 0 || start >= nb.cellCount) return;
    // The kernel is picked through an editor: bring the runbook to front first if it's behind.
    if (!editorOf(nb)) await showRunbook(nb);
    await selectRunbookKernel(this.context, nb);
    await vscode.commands.executeCommand('notebook.cell.execute', {
      ranges: [{ start, end: Math.min(end, nb.cellCount) }],
      document: nb.uri,
    });
  }

  /** Resume Run for the runbook the view shows (it acts on a runbook on screen). */
  private async resume(): Promise<void> {
    const nb = this.notebook();
    if (!nb) return;
    if (!editorOf(nb)) await showRunbook(nb);
    await vscode.commands.executeCommand('mdRunbook.resumeRun', nb.uri);
  }

  /** A click on a count of the preflight line: set the values or a secret, or go to the first step that needs it. */
  private async preflight(kind: string): Promise<void> {
    const nb = this.notebook();
    const m = this.model();
    const part = m?.preflightParts?.find((p) => p.kind === kind);
    if (!nb || !m || !part) return;
    if (part.index !== undefined) return this.go(part.index);
    if (kind === 'secret') return void (await vscode.commands.executeCommand('mdRunbook.setSecret'));
    if (kind !== 'value') return;
    // Set Parameters and Set Inputs ask for the runbook in front.
    await showRunbook(nb);
    const needs = m.rows.flatMap((r) => (r.kind === 'step' ? (r.needs ?? []) : []));
    if (needs.some((n) => n.startsWith('parameter '))) await vscode.commands.executeCommand('mdRunbook.setParameters');
    if (needs.some((n) => n.startsWith('input '))) await vscode.commands.executeCommand('mdRunbook.setInputs');
  }

  private async mark(index: number, as: 'done' | 'skipped'): Promise<void> {
    const cell = this.notebook()?.cellAt(index);
    if (cell) await vscode.commands.executeCommand(as === 'done' ? 'mdRunbook.markStepDone' : 'mdRunbook.markStepSkipped', cell);
  }

  private async tick(index: number, offset: number, checked: boolean): Promise<void> {
    const cell = this.notebook()?.cellAt(index);
    if (cell?.kind === vscode.NotebookCellKind.Markup) await setTaskBox(cell, offset, checked);
  }

  /** Redraw soon (changes come in bursts), and every second while a block runs. */
  refresh(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.draw();
    }, 150);
  }

  model(): StepsModel | undefined {
    const nb = this.notebook();
    if (!nb) return undefined;
    // The cells on screen, when the runbook is (not while another file is in front).
    const r = editorOf(nb)?.visibleRanges ?? [];
    const visible = r.length > 0 ? { first: Math.min(...r.map((x) => x.start)), last: Math.max(...r.map((x) => x.end - 1)) } : undefined;
    return stepsModel(nb, visible, Date.now(), this.sources);
  }

  private draw(): void {
    const nb = this.notebook();
    setContext('mdRunbook.runbookActive', !!nb);
    // Its name under the view's title: which runbook the steps are of (another file may be in front).
    if (this.view) this.view.description = nb ? path.posix.basename(nb.uri.path) : undefined;
    const m = this.model();
    this.last = m;
    const running = m?.state === 'running' || m?.state === 'waiting';
    setContext('mdRunbook.runbookRunning', running);
    setContext('mdRunbook.canResume', !!m?.canResume);
    if (running && !this.ticker) this.ticker = setInterval(() => this.refresh(), 1000);
    if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    if (!this.view) return;
    // The steps left on the view's icon; its tooltip says what the run waits for or where it failed.
    this.view.badge = m && m.open > 0 ? { value: m.open, tooltip: m.headline } : undefined;
    if (!this.view.visible) return;
    void this.view.webview.postMessage(m ? { model: m } : { empty: true });
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
  }
}

/** The empty view's Open as Runbook: the Markdown file in front, else one picked in a dialog. */
async function openAsRunbook(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  let uri = doc?.languageId === 'markdown' && !doc.isUntitled ? doc.uri : undefined;
  if (!uri) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Markdown: ['md', 'markdown'] }, openLabel: 'Open as Runbook' });
    uri = picked?.[0];
  }
  if (uri) await vscode.commands.executeCommand('mdRunbook.openAsRunbook', uri);
}

export function registerStepsView(context: vscode.ExtensionContext, pipeline?: RunPipeline, sources?: PreflightSources): void {
  const view = new StepsView(context, sources);
  // Shown once, on the first Run All, so it's found; not again (the icon stays in the activity bar).
  pipeline?.observers.push({
    onWillRunSequence: async (_nb, cells) => {
      if (cells.length < 2 || context.globalState.get<boolean>(REVEALED_KEY) || isTestMode(context)) return;
      await context.globalState.update(REVEALED_KEY, true);
      await vscode.commands.executeCommand(`${STEPS_VIEW}.focus`);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    },
  });
  context.subscriptions.push(
    view,
    vscode.window.registerWebviewViewProvider(STEPS_VIEW, view),
    vscode.window.onDidChangeActiveNotebookEditor(() => view.refresh()),
    onDidChangeCurrentRunbook(() => view.refresh()),
    vscode.window.onDidChangeNotebookEditorVisibleRanges(() => view.refresh()),
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.notebookType === NOTEBOOK_TYPE) view.refresh();
    }),
    onDidChangeWaiting(() => view.refresh()),
    // Run ▾ shows the runbook-call items only while a call is selected (they act on it).
    vscode.window.onDidChangeNotebookEditorSelection((e) => {
      const cell = e.notebookEditor.notebook.notebookType === NOTEBOOK_TYPE ? e.notebookEditor.notebook.cellAt(e.selections[0]?.start ?? 0) : undefined;
      setContext('mdRunbook.selectionIsCall', !!cell && cell.kind === vscode.NotebookCellKind.Code && isCallLanguage(cell.document.languageId));
    }),
    vscode.commands.registerCommand('mdRunbook.showSteps', () => vscode.commands.executeCommand(`${STEPS_VIEW}.focus`)),
    vscode.commands.registerCommand('mdRunbook.steps.runAll', async () => {
      await view.run(0, Number.MAX_SAFE_INTEGER);
    }),
    vscode.commands.registerCommand('mdRunbook.steps.stop', () => vscode.commands.executeCommand('notebook.cancelExecution')),
    // For tests: the view's model for the active runbook.
    vscode.commands.registerCommand('mdRunbook._steps', () => view.model()),
  );
  view.refresh();
}

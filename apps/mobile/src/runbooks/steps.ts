/**
 * The runbook's steps by name, as VS Code's Runbook Steps view lists them (src/stepsView.ts):
 * each `#`/`##` chapter, then each step with its state, number, name and time; checklist items
 * are steps done by hand; the ready check says what it answered; a teardown not run yet is
 * offered; a failed step has the last line of its error; a chapter with one step is one row. The Steps view (a phone's Steps tab,
 * the wide screen's side panel) draws these rows.
 */
import { isCodeMeta, parseLineSet, taskItems } from '@md-runbook/core';
import type { ParsedCell, Progress } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { parseInterval } from '@md-runbook/core/checks';
import { blockProgress, formatEstimate, formatLearned, overEstimate, stepHeadings, stepLabel } from '@md-runbook/core/estimate';
import { stepState } from '@md-runbook/core/progress';
import { headingsOf, withoutFrontMatter } from '@md-runbook/core/title';
import { t } from '../i18n';

export type StepRowState = 'done' | 'failed' | 'running' | 'waiting' | 'pending';

export type StepsRow =
  | { kind: 'chapter'; key: string; index: number; title: string; level: number }
  | {
      kind: 'step';
      /** Unique in the list, and the row's testID after `steps-row-`: the cell index, `-n` for one of several checklist items. */
      key: string;
      /** The cell's index in the runbook. */
      index: number;
      /** A checklist item: its place among the cell's items (0-based). */
      item?: number;
      /** 1-based step number; none for the ready check and a teardown offered. */
      step?: number;
      /** The step's name; for a chapter's lone step (mergeLoneSteps), the chapter's heading. */
      label: string;
      /** A chapter's lone step, shown as one row: the chapter's level (1 or 2). */
      chapter?: number;
      /** A chapter's lone step: the step's own name, when it isn't the heading. */
      detail?: string;
      state: StepRowState;
      /** `est. 2m`, `12s of 1m` while it runs, `took 3m10s (+40s)`, `by hand`, `already up`. */
      time?: string;
      /** Over its estimate (the time in amber). */
      over?: boolean;
      /** The running step's share of its estimate, 0 to 1. */
      fraction?: number;
      /** Preflight: what running it will need from you (a step still to do, or failed). */
      needs?: StepNeed[];
      /** A failed step: the last line of its error output (stderr, else its output), cut short. */
      error?: string;
    };

/** Something a step will ask of you when it runs, known before the run (as the extension's Steps view). */
export type StepNeed = { kind: 'approval' } | { kind: 'confirm' } | { kind: 'secret' | 'input'; name: string };

/** A need in a few words: `your confirmation`, `secret API_TOKEN (not stored)`. */
export function needText(n: StepNeed): string {
  return n.kind === 'approval'
    ? t.preflightApprovalNeed
    : n.kind === 'confirm'
      ? t.preflightConfirmNeed
      : n.kind === 'secret'
        ? t.preflightSecretNeed(n.name)
        : t.preflightInputNeed(n.name);
}

/** One count of the preflight line, and the first step it is about (none for values and secrets). */
export interface PreflightPart {
  kind: StepNeed['kind'] | 'byHand';
  /** `2 confirmations`. */
  text: string;
  /** The first step that needs it (its cell): confirmations, proposals, steps by hand. */
  index?: number;
}

/**
 * Preflight, before a run: what the steps still to do will need, count by count (`2
 * confirmations`, `1 secret to set`, `1 step by hand`); empty when they need nothing.
 */
export function preflightParts(rows: readonly StepsRow[]): PreflightPart[] {
  const steps = rows.filter((r): r is Extract<StepsRow, { kind: 'step' }> => r.kind === 'step');
  const count = (kind: StepNeed['kind']): number => steps.reduce((n, r) => n + (r.needs ?? []).filter((x) => x.kind === kind).length, 0);
  const first = (kind: StepNeed['kind']): number | undefined => steps.find((r) => r.needs?.some((x) => x.kind === kind))?.index;
  const open = steps.filter((r) => r.item !== undefined && r.state !== 'done');
  const parts: (PreflightPart | undefined)[] = [
    part('confirm', t.preflightConfirm(count('confirm')), first('confirm')),
    part('secret', t.preflightSecret(count('secret'))),
    part('input', t.preflightInput(count('input'))),
    part('approval', t.preflightApproval(count('approval')), first('approval')),
    part('byHand', t.preflightByHand(open.length), open[0]?.index),
  ];
  return parts.filter((p): p is PreflightPart => p !== undefined);
}

function part(kind: PreflightPart['kind'], text: string | undefined, index?: number): PreflightPart | undefined {
  return text === undefined ? undefined : { kind, text, ...(index !== undefined ? { index } : {}) };
}

/**
 * Preflight in one line, before a run: what the steps still to do will need (`Before you run: 2
 * confirmations · 1 secret to set · 1 step by hand`), or undefined when they need nothing.
 */
export function preflightLine(rows: readonly StepsRow[]): string | undefined {
  const parts = preflightParts(rows);
  return parts.length ? t.preflight(parts.map((p) => p.text).join(' · ')) : undefined;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ERROR_MAX = 120;

/**
 * Why a step failed, in one line (as VS Code's Steps view): the last non-empty line of its saved
 * output's stderr lines (listed on the output marker, `stderr=`), else of its output, cut short.
 */
export function errorLine(output: ParsedCell['output']): string | undefined {
  if (!output) return undefined;
  const errs = parseLineSet(output.attrs.stderr);
  const err: string[] = [];
  const out: string[] = [];
  output.text
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .forEach((l, n) => (errs.has(n) ? err : out).push(l));
  const last = (lines: string[]): string | undefined =>
    lines
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
  const line = last(err) ?? last(out);
  return line !== undefined && line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
}

export interface StepsInput {
  cells: readonly ParsedCell[];
  progress: Progress;
  /** The block running now and when it started (Date.now()). */
  running?: { cellIndex: number; startedAt: number };
  /** Where the run waits for an answer: a cell, or with `item` a checklist item of a Markdown cell. */
  waiting?: { cellIndex: number; item?: number };
  /** A runbook call's estimate on its cell (null: its src= has placeholders). */
  callEstimates?: ReadonlyMap<number, number | null>;
  /** Blocks without estimate=: the usual time of their runs that passed (shown `~1m`). */
  learnedEstimates?: ReadonlyMap<number, number>;
  /** Preflight: what running code cell `index` will need from you now (nothing asked, nothing run). */
  needsOf?: (index: number, cell: ParsedCell) => StepNeed[];
  now: number;
}

const TASK_PREFIX = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]*/;

/** A checklist item's text, without its `- [ ]`. */
export function checklistText(markdown: string, line: number): string {
  return (markdown.split(/\r?\n/)[line] ?? '').replace(TASK_PREFIX, '').trim() || t.stepsChecklistItem;
}

/** The headings that name blocks without a name= (core stepHeadings), one per cell. */
export function cellHeadings(cells: readonly ParsedCell[]): (string | undefined)[] {
  return stepHeadings(cells.map((c) => ({ kind: c.kind === 'markup' ? 'markup' : 'code', text: c.value })));
}

export function stepsRows({ cells, progress, running, waiting, callEstimates, learnedEstimates, needsOf, now }: StepsInput): StepsRow[] {
  const rows: StepsRow[] = [];
  /** The last step number given (a block's from the progress, checklist items counted on). */
  let taskStep = 0;
  const headings = cellHeadings(cells);
  cells.forEach((cell, i) => {
    if (cell.kind === 'markup') {
      const text = i === 0 ? withoutFrontMatter(cell.value) : cell.value;
      headingsOf(text)
        .filter((h) => h.level <= 2)
        .forEach((h, n) =>
          rows.push({ kind: 'chapter', key: n === 0 ? `chapter-${i}` : `chapter-${i}-${n}`, index: i, title: h.text, level: h.level }),
        );
      const items = taskItems(cell.value);
      items.forEach((item, n) => {
        taskStep++;
        rows.push({
          kind: 'step',
          key: items.length > 1 ? `${i}-${n + 1}` : String(i),
          index: i,
          item: n,
          step: taskStep,
          label: checklistText(cell.value, item.line),
          state: item.checked ? 'done' : waiting?.cellIndex === i && waiting.item === n ? 'waiting' : 'pending',
          time: t.stepsByHand,
        });
      });
      return;
    }
    const step = progress.stepOfCell[i];
    if (step !== undefined) taskStep = step;
    const info = isCodeMeta(cell.meta) ? cell.meta.info : '';
    const opts = parseCellOptions(info);
    // Not a step: the ready check (a quick look) and a teardown not run yet (offered).
    const offered = step === undefined && opts.part === 'teardown' && progress.resume.includes(i);
    const ready = step === undefined && opts.part === 'ready';
    if (step === undefined && !offered && !ready) return;
    const declared = callEstimates?.get(i) ?? opts.estimateSeconds ?? undefined;
    const est = declared ?? learnedEstimates?.get(i);
    const fmtEst = declared === undefined && est !== undefined ? formatLearned : formatEstimate;
    const a = cell.output?.attrs;
    const s = stepState(a?.exit, a?.lines !== undefined, a?.check);
    let state: StepRowState = s === 'done' || s === 'skipped' ? 'done' : s === 'failed' ? 'failed' : 'pending';
    let time: string | undefined;
    let over = false;
    let fraction: number | undefined;
    if (waiting?.cellIndex === i && waiting.item === undefined) state = 'waiting';
    if (running?.cellIndex === i) {
      state = 'running';
      const elapsed = Math.max(0, (now - running.startedAt) / 1000);
      if (est !== undefined) {
        const b = blockProgress(elapsed, est);
        fraction = b.fraction;
        over = b.overSeconds > 0;
        time = over ? t.estimateOver(formatEstimate(b.overSeconds), fmtEst(est)) : t.estimateOf(formatEstimate(elapsed), fmtEst(est));
      } else time = formatEstimate(elapsed);
    } else if (ready && a?.ready !== undefined) {
      // What the check answered, not how long it took.
      time = a.ready === 'up' ? t.stepsReadyUp : t.stepsReadyDown;
    } else {
      const ms = a?.duration !== undefined ? parseInterval(a.duration) : undefined;
      const took = ms !== undefined ? ms / 1000 : undefined;
      const extra = took !== undefined && est !== undefined ? overEstimate(took, est) : undefined;
      if (took !== undefined && extra !== undefined) {
        time = t.stepsTookOver(formatEstimate(took), formatEstimate(extra));
        over = true;
      } else if (took !== undefined && state !== 'pending') time = t.stepsTook(formatEstimate(took));
      else if (est !== undefined) time = t.estimate(fmtEst(est));
    }
    const label = stepLabel(info, cell.value, cell.languageId, headings[i]) || t.cellNumber(i + 1);
    // Preflight: for a step still to run (or to run again), not the ready check or a teardown offered.
    const needs = needsOf && (state === 'pending' || state === 'failed') && !ready && !offered ? needsOf(i, cell) : [];
    const error = state === 'failed' ? errorLine(cell.output) : undefined;
    rows.push({
      kind: 'step',
      key: String(i),
      index: i,
      ...(step !== undefined ? { step } : {}),
      label: offered ? t.stepsOffered(label) : ready ? t.stepsReady(label) : label,
      state,
      ...(time !== undefined ? { time } : {}),
      ...(over ? { over } : {}),
      ...(fraction !== undefined ? { fraction } : {}),
      ...(needs.length ? { needs } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  });
  return mergeLoneSteps(rows);
}

/**
 * A chapter with only one step under it is one row (as VS Code's Steps view, src/stepsView.ts):
 * the heading, with the step's state, number and time, and the step's own name under it when it
 * differs. Only a numbered step (not the ready check or a teardown offered), with nothing else
 * before the next chapter; a chapter with no step or several keeps its row.
 */
export function mergeLoneSteps(rows: readonly StepsRow[]): StepsRow[] {
  const merged: StepsRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const next = rows[i + 1];
    const after = rows[i + 2];
    if (r.kind === 'chapter' && next?.kind === 'step' && next.step !== undefined && (after === undefined || after.kind === 'chapter')) {
      merged.push({ ...next, label: r.title, chapter: r.level, ...(next.label !== r.title ? { detail: next.label } : {}) });
      i++;
    } else merged.push(r);
  }
  return merged;
}

/** A checklist item Run all waits at: its Markdown cell, its place there, and its text. */
export interface ManualItem {
  cellIndex: number;
  /** Its place among the cell's checklist items (0-based). */
  item: number;
  text: string;
}

/**
 * The first unticked checklist item between the code cell before `upTo` and `upTo` (the steps done
 * by hand Run all reaches before running cell `upTo`; `cells.length` for those after the last
 * block), leaving out the ones answered Skip (`skipped`: `cell:item`). As VS Code's Run All.
 */
export function uncheckedBefore(cells: readonly ParsedCell[], upTo: number, skipped: ReadonlySet<string>): ManualItem | undefined {
  let from = Math.min(upTo, cells.length) - 1;
  while (from >= 0 && cells[from]!.kind !== 'code') from--;
  for (let i = from + 1; i < Math.min(upTo, cells.length); i++) {
    const cell = cells[i]!;
    if (cell.kind !== 'markup') continue;
    const items = taskItems(cell.value);
    for (let n = 0; n < items.length; n++) {
      if (items[n]!.checked || skipped.has(`${i}:${n}`)) continue;
      return { cellIndex: i, item: n, text: checklistText(cell.value, items[n]!.line) };
    }
  }
  return undefined;
}

/** The index of the runbook's last code cell, or -1. */
export function lastCodeCell(cells: readonly ParsedCell[]): number {
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i]!.kind === 'code') return i;
  return -1;
}

/**
 * The runbook's text with checklist item `item` of Markdown cell `cellIndex` ticked, or undefined
 * when it is ticked already or isn't there (the text changed). Items are counted cell by cell, as
 * the task boxes on screen are.
 */
export function withItemTicked(text: string, cells: readonly ParsedCell[], cellIndex: number, item: number): string | undefined {
  return withItemSet(text, cells, cellIndex, item, true);
}

/**
 * The runbook's text with checklist item `item` of Markdown cell `cellIndex` ticked (`checked`)
 * or unticked, or undefined when it is that way already or isn't there (the text changed): the
 * Steps view's tick box.
 */
export function withItemSet(
  text: string,
  cells: readonly ParsedCell[],
  cellIndex: number,
  item: number,
  checked: boolean,
): string | undefined {
  let k = item;
  for (let i = 0; i < cellIndex; i++) if (cells[i]!.kind === 'markup') k += taskItems(cells[i]!.value).length;
  const found = taskItems(text)[k];
  const own = taskItems(cells[cellIndex]?.value ?? '')[item];
  if (!found || found.checked === checked || !own) return undefined;
  // The same item: its line reads the same in the cell and in the file.
  const line = (s: string, n: number): string => (s.split('\n')[n] ?? '').replace(/\r$/, '');
  if (line(text, found.line) !== line(cells[cellIndex]!.value, own.line)) return undefined;
  return text.slice(0, found.offset) + (checked ? 'x' : ' ') + text.slice(found.offset + 1);
}

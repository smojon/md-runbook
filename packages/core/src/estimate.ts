/**
 * `estimate=`: how long a block takes, as measured on a real run (`estimate=2m30s`). It never
 * changes how a block runs; it tells the reader how long a block, a section and the runbook take,
 * and drives the progress bars of a running block and of the runbook.
 */

import { MAX_CALL_DEPTH, isCallLanguage, isDynamicSrc, parseCall } from './call';
import { locateCodeCells } from './locate';
import { inSections, sectionHeadings } from './sections';
import { parseCellOptions } from './cellOptions';
import { isCodeMeta } from './model';
import { OsName, osGroups } from './os';
import { parse } from './parser';
import { stepState } from './progress';
import { headingsOf, withoutFrontMatter } from './title';

/** `2m30s`, `45s`, `1h5m`, `0.5s`: the shortest form parseInterval reads back. */
export function formatEstimate(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 1) return `${Math.round(s * 1000) / 1000}s`;
  const whole = Math.round(s);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  return [h ? `${h}h` : '', m ? `${m}m` : '', sec || (!h && !m) ? `${sec}s` : ''].join('');
}

/** "about 6 min", "about 1 h 10 min", "under a minute": a rough time left. */
export function formatLeft(seconds: number): string {
  const min = Math.round(Math.max(0, seconds) / 60);
  if (min < 1) return 'under a minute';
  if (min < 60) return `about ${min} min`;
  const h = Math.floor(min / 60);
  return `about ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

/**
 * The run took much longer than its estimate: more than twice it and more than a minute over
 * (a 5 s block taking 12 s is no news; a 2 min block taking 6 is).
 */
export function isOverEstimate(actualSeconds: number, estimateSeconds: number): boolean {
  return actualSeconds > 2 * estimateSeconds && actualSeconds - estimateSeconds > 60;
}

export interface BlockProgress {
  /** Elapsed over the estimate, 0 to 1 (full at the estimate and after it). */
  fraction: number;
  /** Seconds past the estimate, 0 while within it. */
  overSeconds: number;
}

/** A running block against its estimate: the bar is full at the estimate and stays full after it. */
export function blockProgress(elapsedSeconds: number, estimateSeconds: number): BlockProgress {
  const elapsed = Math.max(0, elapsedSeconds);
  if (estimateSeconds <= 0) return { fraction: 1, overSeconds: elapsed };
  return { fraction: Math.min(1, elapsed / estimateSeconds), overSeconds: Math.max(0, elapsed - estimateSeconds) };
}

/** `[####......]` for 0.4 (width 10); clamped to 0..1. */
export function progressBar(fraction: number, width = 10): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const full = Math.round(f * width);
  return `[${'#'.repeat(full)}${'.'.repeat(width - full)}]`;
}

/**
 * A running block's state in one line: `[####......] 1m10s of 2m30s`, or past its estimate
 * `[##########] +1m20s over 2m30s`.
 */
export function formatBlockProgress(elapsedSeconds: number, estimateSeconds: number, width = 10): string {
  const p = blockProgress(elapsedSeconds, estimateSeconds);
  const bar = progressBar(p.fraction, width);
  return p.overSeconds > 0
    ? `${bar} +${formatEstimate(p.overSeconds)} over ${formatEstimate(estimateSeconds)}`
    : `${bar} ${formatEstimate(elapsedSeconds)} of ${formatEstimate(estimateSeconds)}`;
}

export type EstimateState = 'done' | 'running' | 'pending';

export interface EstimateStep {
  /** undefined: the block has no estimate. */
  estimateSeconds?: number;
  /** done: finished (passed or skipped); pending: still to run (a failed block runs again). */
  state: EstimateState;
  /** For the running block: how long it has run. */
  elapsedSeconds?: number;
  /** The block's cell index, where known (textEstimateSteps). */
  cell?: number;
}

export interface RunbookEstimate {
  /** Sum of all estimates. */
  totalSeconds: number;
  /** Sum of the estimates of the finished blocks. */
  doneSeconds: number;
  /** Sum of the estimates still to run; the running block counts what is left of its own (never below 0). */
  leftSeconds: number;
  /** doneSeconds / totalSeconds, 0 to 1; undefined when no block has an estimate. */
  fraction?: number;
  blocks: number;
  /** Blocks without an estimate (not guessed). */
  unestimated: number;
  /** Of those, the ones not finished yet. */
  unestimatedLeft: number;
}

/** Done so far over the total, by estimates, and the time left. */
export function runbookEstimate(steps: readonly EstimateStep[]): RunbookEstimate {
  const r: RunbookEstimate = { totalSeconds: 0, doneSeconds: 0, leftSeconds: 0, blocks: steps.length, unestimated: 0, unestimatedLeft: 0 };
  for (const s of steps) {
    if (s.estimateSeconds === undefined) {
      r.unestimated++;
      if (s.state !== 'done') r.unestimatedLeft++;
      continue;
    }
    r.totalSeconds += s.estimateSeconds;
    if (s.state === 'done') r.doneSeconds += s.estimateSeconds;
    else if (s.state === 'running') r.leftSeconds += Math.max(0, s.estimateSeconds - (s.elapsedSeconds ?? 0));
    else r.leftSeconds += s.estimateSeconds;
  }
  if (r.totalSeconds > 0) r.fraction = r.doneSeconds / r.totalSeconds;
  return r;
}

/**
 * The runbook's progress in one line: `[####......] 40% · about 6 min left · 2 blocks without an
 * estimate`; undefined when no block has an estimate.
 */
export function formatRunbookEstimate(e: RunbookEstimate, width = 10): string | undefined {
  if (e.fraction === undefined) return undefined;
  const parts = [`${progressBar(e.fraction, width)} ${Math.floor(e.fraction * 100)}%`, e.leftSeconds > 0 ? `${formatLeft(e.leftSeconds)} left` : 'nothing left'];
  if (e.unestimatedLeft > 0) parts.push(withoutEstimate(e.unestimatedLeft));
  return parts.join(' · ');
}

/** "1 block without an estimate", "3 blocks without an estimate". */
export function withoutEstimate(n: number): string {
  return `${n} block${n === 1 ? '' : 's'} without an estimate`;
}

export interface SectionEstimate {
  /** The `#` or `##` heading; undefined for the blocks before the first heading. */
  heading?: string;
  /** 1 or 2; 0 before the first heading. */
  level: number;
  /** Index of the Markdown cell holding the heading (-1 before the first heading). */
  cell: number;
  /** Sum of the estimates of the blocks up to the next `#`/`##` heading (`###` and below stay in it). */
  seconds: number;
  blocks: number;
  unestimated: number;
}

export interface EstimateSummary {
  sections: SectionEstimate[];
  totalSeconds: number;
  blocks: number;
  unestimated: number;
  /** Per cell: the block's estimate in seconds (undefined: none, or not a block that counts). */
  perCell: (number | undefined)[];
  /** Per cell: the block counts (a code cell, not `skip`, one per `os=` group). */
  counts: boolean[];
}

/**
 * The estimates of a runbook, per `#`/`##` section and in all. A block is a code cell; `skip`
 * blocks don't count, and `os=` alternatives count once (the one for `here`, else the longest).
 * An invalid `estimate=` counts as none (lint reports it).
 */
export function estimateRunbook(text: string, here?: OsName, callEstimate?: (info: string, source: string) => number | undefined): EstimateSummary {
  const cells = parse(text).cells;
  const opts = cells.map((c) => (c.kind === 'code' && isCodeMeta(c.meta) ? parseCellOptions(c.meta.info) : undefined));
  // A runbook call without estimate= takes as long as what it runs (when that can be read).
  cells.forEach((c, i) => {
    const o = opts[i];
    if (!callEstimate || !o || o.estimateSeconds !== undefined || !isCodeMeta(c.meta) || !isCallLanguage(c.languageId)) return;
    const e = callEstimate(c.meta.info, c.value);
    if (e !== undefined) opts[i] = { ...o, estimateSeconds: e };
  });
  const slots = osGroups(
    cells.map((c, i) => ({ kind: c.kind, ...(opts[i]?.os ? { os: opts[i]!.os } : {}) })),
    here,
  );
  // An os= group is one step: the alternative for this system when one is, else the longest.
  const groupEstimate = new Map<number, number | undefined>();
  const groups = new Map<number, { active: boolean; e?: number }[]>();
  slots.forEach((slot, i) => {
    if (slot) groups.set(slot.group, [...(groups.get(slot.group) ?? []), { active: slot.active, e: opts[i]?.estimateSeconds }]);
  });
  for (const [group, alts] of groups) {
    const active = here !== undefined ? alts.find((a) => a.active) : undefined;
    const known = alts.flatMap((a) => (a.e === undefined ? [] : [a.e]));
    groupEstimate.set(group, active ? active.e : known.length ? Math.max(...known) : undefined);
  }
  const counted = new Set<number>();
  const perCell: (number | undefined)[] = [];
  const counts: boolean[] = [];
  const sections: SectionEstimate[] = [];
  let current: SectionEstimate | undefined;
  cells.forEach((c, i) => {
    if (c.kind !== 'code') {
      perCell.push(undefined);
      counts.push(false);
      for (const h of headingsOf(i === 0 ? withoutFrontMatter(c.value) : c.value)) {
        if (h.level > 2) continue;
        current = { heading: h.text, level: h.level, cell: i, seconds: 0, blocks: 0, unestimated: 0 };
        sections.push(current);
      }
      return;
    }
    const o = opts[i];
    const slot = slots[i];
    let countsHere = o !== undefined && !o.skip;
    let e = o?.estimateSeconds;
    if (countsHere && slot) {
      if (counted.has(slot.group)) countsHere = false;
      else {
        counted.add(slot.group);
        e = groupEstimate.get(slot.group);
      }
    }
    perCell.push(o?.estimateSeconds);
    counts.push(countsHere);
    if (!countsHere) return;
    if (!current) {
      current = { level: 0, cell: -1, seconds: 0, blocks: 0, unestimated: 0 };
      sections.unshift(current);
    }
    current.blocks++;
    if (e === undefined) current.unestimated++;
    else current.seconds += e;
  });
  return {
    sections,
    totalSeconds: sections.reduce((t, s) => t + s.seconds, 0),
    blocks: sections.reduce((t, s) => t + s.blocks, 0),
    unestimated: sections.reduce((t, s) => t + s.unestimated, 0),
    perCell,
    counts,
  };
}

/**
 * A runbook's blocks as estimate steps from its text, for the app (cells run over SSH): every
 * code cell but `skip` blocks and the `os=` alternatives for another system (`here`, the
 * remote's), each done by its output's exit (stepState); `running` is the cell running now.
 * `host=` blocks count: they run there.
 */
export function textEstimateSteps(
  text: string,
  running?: { cellIndex: number; elapsedSeconds: number },
  here: OsName = 'linux',
  callEstimateOf?: (info: string, source: string) => number | undefined,
): EstimateStep[] {
  const cells = parse(text).cells;
  const opts = cells.map((c) => (c.kind === 'code' && isCodeMeta(c.meta) ? parseCellOptions(c.meta.info) : undefined));
  // A runbook call without estimate= takes as long as what it runs (when that can be read).
  cells.forEach((c, i) => {
    const o = opts[i];
    if (!callEstimateOf || !o || o.estimateSeconds !== undefined || !isCodeMeta(c.meta) || !isCallLanguage(c.languageId)) return;
    const e = callEstimateOf(c.meta.info, c.value);
    if (e !== undefined) opts[i] = { ...o, estimateSeconds: e };
  });
  const slots = osGroups(
    cells.map((c, i) => ({ kind: c.kind, ...(opts[i]?.os ? { os: opts[i]!.os } : {}) })),
    here,
  );
  const steps: EstimateStep[] = [];
  cells.forEach((c, i) => {
    const o = opts[i];
    if (c.kind !== 'code' || o?.skip || (slots[i] && !slots[i]!.active)) return;
    const e = o?.estimateSeconds !== undefined ? { estimateSeconds: o.estimateSeconds } : {};
    if (running?.cellIndex === i) return void steps.push({ ...e, cell: i, state: 'running', elapsedSeconds: running.elapsedSeconds });
    const a = c.output?.attrs;
    const state = stepState(a?.exit, a?.lines !== undefined, a?.check);
    steps.push({ ...e, cell: i, state: state === 'done' || state === 'skipped' ? 'done' : 'pending' });
  });
  return steps;
}

/** Reads a runbook a call names: src= as written, from the file the call is in (undefined: the first). */
export type CallReader = (src: string, from: string | undefined) => { text: string; at?: string } | undefined;

/**
 * How long a runbook call takes: its estimate=, else the estimates of what it runs (its selected
 * sections; calls in it too), read with `read`. Undefined when that can't be known before the run
 * (src= has placeholders, the file can't be read) or nothing in it has an estimate.
 */
export function callEstimate(info: string, source: string, read: CallReader, here?: OsName, depth = 0, from?: string): number | undefined {
  const own = parseCellOptions(info).estimateSeconds;
  if (own !== undefined) return own;
  const call = parseCall(info, source);
  if (call.src === undefined || isDynamicSrc(call.src) || depth >= MAX_CALL_DEPTH) return undefined;
  const got = read(call.src, from);
  if (!got) return undefined;
  const e = estimateRunbook(got.text, here, (i, s) => (got.at === undefined ? undefined : callEstimate(i, s, read, here, depth + 1, got.at)));
  if (call.sections.length === 0) return e.blocks > e.unestimated ? e.totalSeconds : undefined;
  const inPart = inSections(sectionHeadings(got.text), call.sections);
  let sum: number | undefined;
  for (const loc of locateCodeCells(parse(got.text))) {
    const seconds = e.perCell[loc.cellIndex];
    if (e.counts[loc.cellIndex] && seconds !== undefined && inPart(loc.line)) sum = (sum ?? 0) + seconds;
  }
  return sum;
}

/**
 * Runbook progress: which steps are done, failed, skipped or still pending. A step is a code
 * cell (judged by its output's exit attribute) or a GitHub task-list item in a markup cell.
 */

import { isFenceClose, matchFenceOpen } from './fence';
import type { FenceOpen } from './fence';
import { OUTPUT_START_RE, parseAttrs } from './outputBlock';

export type StepState = 'done' | 'failed' | 'skipped' | 'pending';

export interface ProgressCell {
  kind: 'code' | 'markup';
  /** Exit attribute of the code cell's output; undefined = no output (or still running). */
  exit?: string;
  /** Task-list items of a markup cell, in order: true = checked. */
  tasks?: boolean[];
}

export interface Progress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  pending: number;
  /** Cell index and 1-based step number of the first failed step. */
  firstFailed?: { cell: number; step: number };
  /** Cell index and 1-based step number of the first pending step (code or checklist). */
  firstPending?: { cell: number; step: number };
  /** Code cells Resume Run executes: failed or pending ones from the first such cell on. */
  resume: number[];
}

/** State of a code cell from its output's exit attribute. */
export function stepState(exit: string | undefined): StepState {
  // declined (confirmation answered No) and proposed (waiting for approval) are not done yet.
  if (exit === undefined || exit === 'running' || exit === 'declined' || exit === 'proposed') return 'pending';
  if (exit === '0' || exit === 'done') return 'done';
  if (exit === 'skipped') return 'skipped';
  return 'failed';
}

/** Output written by Mark Step Done/Skipped (it carries `by=`), not a real run that was skipped. */
export function isManualMark(attrs: Record<string, string> | undefined): boolean {
  return !!attrs && (attrs.exit === 'done' || attrs.exit === 'skipped') && attrs.by !== undefined;
}

export function computeProgress(cells: readonly ProgressCell[]): Progress {
  const p: Progress = { total: 0, done: 0, failed: 0, skipped: 0, pending: 0, resume: [] };
  cells.forEach((c, i) => {
    if (c.kind === 'markup') {
      for (const checked of c.tasks ?? []) {
        p.total++;
        if (checked) p.done++;
        else {
          p.pending++;
          p.firstPending ??= { cell: i, step: p.total };
        }
      }
      return;
    }
    p.total++;
    const state = stepState(c.exit);
    p[state]++;
    if (state === 'failed') p.firstFailed ??= { cell: i, step: p.total };
    if (state === 'pending') p.firstPending ??= { cell: i, step: p.total };
    if (state === 'failed' || state === 'pending') p.resume.push(i);
  });
  return p;
}

/** Status bar text, e.g. `$(checklist) 4/7 · ✗ step 5`; skipped steps count as complete. */
export function formatProgress(p: Progress): string {
  const head = `${p.pending === 0 && p.failed === 0 ? '$(pass)' : '$(checklist)'} ${p.done + p.skipped}/${p.total}`;
  return p.firstFailed ? `${head} · ✗ step ${p.firstFailed.step}` : head;
}

/** `- [ ] item`, `* [x] item`, `1. [X] item`; group 1 is the box character. */
const TASK_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/;

/** A task-list item: its line (0-based), the offset of its box character and whether it is checked. */
interface TaskItem {
  line: number;
  offset: number;
  checked: boolean;
}

/** Task-list items outside fenced code blocks. */
function taskItems(text: string): TaskItem[] {
  const items: TaskItem[] = [];
  let fence: FenceOpen | null = null;
  let pos = 0;
  text.split('\n').forEach((line, n) => {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (fence) {
      if (isFenceClose(l, fence)) fence = null;
    } else if ((fence = matchFenceOpen(l)) === null) {
      const m = TASK_RE.exec(l);
      if (m) items.push({ line: n, offset: pos + m[0].length - 2, checked: m[1] !== ' ' });
    }
    pos += line.length + 1;
  });
  return items;
}

/** The task-list item on `line` (0-based) of a markup cell, if there is one. */
export function taskItemAtLine(text: string, line: number): { offset: number; checked: boolean } | undefined {
  const item = taskItems(text).find((i) => i.line === line);
  return item && { offset: item.offset, checked: item.checked };
}

/** Task-list items of a markup cell in order: true = checked. */
export function checklist(text: string): boolean[] {
  return taskItems(text).map((i) => i.checked);
}

/** Offset of the space in the first unchecked `[ ]`, or undefined if every item is checked. */
export function nextUncheckedOffset(text: string): number | undefined {
  return taskItems(text).find((i) => !i.checked)?.offset;
}

/** Text with the first unchecked item checked, or undefined if there is none. */
export function checkNextItem(text: string): string | undefined {
  const at = nextUncheckedOffset(text);
  return at === undefined ? undefined : text.slice(0, at) + 'x' + text.slice(at + 1);
}

/** Marker attributes of a raw output block (as kept in code cell metadata). */
export function outputBlockAttrs(raw: string): Record<string, string> | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const m = OUTPUT_START_RE.exec(line);
    if (m) return parseAttrs(m[1] ?? '');
  }
  return undefined;
}

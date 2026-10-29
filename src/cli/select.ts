/**
 * Part of a runbook for `md-runbook run`: `--from N`, `--to N` (step numbers as the run's
 * `▶ Step N` lines show them) and `--section TEXT` (the steps under a heading). And the checks
 * made before the first step, so a long run doesn't stop halfway on something known at the
 * start: a selection that selects nothing, a `${out:NAME}` whose capture is left out, cells that
 * need `--yes`.
 */

import { CodeCellLocation, splitLines } from '@md-runbook/core';
import { isFenceClose, matchFenceOpen } from '@md-runbook/core/fence';

/** A problem found before the first step: nothing ran (exit code 2). */
export class RunUsageError extends Error {}

export interface Selection {
  from?: number;
  to?: number;
  /** Heading prefixes (case-sensitive); a step under any of them is selected. */
  sections?: string[];
}

export interface Heading {
  /** 0-based line. */
  line: number;
  level: number;
  /** After the `#`s and spaces, without a closing `#` sequence. */
  text: string;
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** The ATX headings of a runbook, outside the front matter and fenced blocks (code, outputs). */
export function headingsOf(text: string): Heading[] {
  const lines = splitLines(text.replace(/^﻿/, '')).map((l) => l.text);
  const out: Heading[] = [];
  let i = 0;
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const open = matchFenceOpen(lines[i]!);
    if (open) {
      while (i + 1 < lines.length && !isFenceClose(lines[i + 1]!, open)) i++;
      i++;
      continue;
    }
    const m = ATX_RE.exec(lines[i]!);
    if (!m) continue;
    const content = (m[2] ?? '').replace(/(^|[ \t]+)#+$/, '').trim();
    out.push({ line: i, level: m[1]!.length, text: content });
  }
  return out;
}

/** "1–3, 5, 7–9" */
export function formatSteps(steps: readonly number[]): string {
  const sorted = [...steps].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let k = 0; k < sorted.length; ) {
    let e = k;
    while (e + 1 < sorted.length && sorted[e + 1] === sorted[e]! + 1) e++;
    parts.push(e === k ? `${sorted[k]}` : `${sorted[k]}–${sorted[e]}`);
    k = e + 1;
  }
  return parts.join(', ');
}

/** The options as written, for messages: `--from 6 --section "3."`. */
export function selectionLabel(s: Selection): string {
  return [
    ...(s.from !== undefined ? [`--from ${s.from}`] : []),
    ...(s.to !== undefined ? [`--to ${s.to}`] : []),
    ...(s.sections ?? []).map((t) => `--section ${JSON.stringify(t)}`),
  ].join(' ');
}

/**
 * The selected step numbers, or undefined without a selection. `numbers[i]` is the step of
 * `locs[i]`. A range outside the runbook, a section without a heading, or a selection with no
 * step in it is a RunUsageError.
 */
export function selectSteps(text: string, locs: readonly CodeCellLocation[], numbers: readonly number[], s: Selection): Set<number> | undefined {
  const sections = s.sections ?? [];
  if (s.from === undefined && s.to === undefined && sections.length === 0) return undefined;
  const count = Math.max(0, ...numbers);
  for (const [flag, v] of [['--from', s.from], ['--to', s.to]] as const) {
    if (v !== undefined && (v < 1 || v > count)) {
      throw new RunUsageError(`${flag} ${v} is outside the runbook: it has ${count === 0 ? 'no steps' : count === 1 ? 'one step' : `steps 1 to ${count}`}`);
    }
  }
  if (s.from !== undefined && s.to !== undefined && s.from > s.to) throw new RunUsageError(`--from ${s.from} is after --to ${s.to}`);
  const from = s.from ?? 1;
  const to = s.to ?? count;
  let under: (line: number) => boolean = () => true;
  if (sections.length > 0) {
    const headings = headingsOf(text);
    const missing = sections.filter((t) => !headings.some((h) => h.text.startsWith(t)));
    if (missing.length > 0) {
      throw new RunUsageError(`no heading starts with ${missing.map((t) => JSON.stringify(t)).join(', ')} (--section matches the heading text after the #s, case-sensitive)`);
    }
    // The runbook's title (its one top-level heading) holds every step, so a section matching it
    // selects them all: "6." for "## 6. The scheduled check" also matches "# 6. Are the backends up?".
    const top = Math.min(...headings.map((h) => h.level));
    const tops = headings.filter((h) => h.level === top);
    if (tops.length === 1 && headings.length > 1) {
      const title = tops[0]!;
      const onTitle = sections.filter((t) => title.text.startsWith(t));
      if (onTitle.length > 0) {
        const t = onTitle[0]!;
        const others = headings.filter((h) => h !== title && h.text.startsWith(t)).map((h) => h.text);
        const hint = others.length > 0 ? `; for ${JSON.stringify(others[0])}, give more of it, e.g. --section ${JSON.stringify(others[0]!.split(/\s+/).slice(0, 2).join(' '))}` : '';
        throw new RunUsageError(`--section ${JSON.stringify(t)} matches the runbook's title ${JSON.stringify(title.text)}, which holds every step${hint}`);
      }
    }
    // A block is in a section while that heading is open: until the next heading of its level or higher.
    under = (line) => {
      const open: Heading[] = [];
      for (const h of headings) {
        if (h.line >= line) break;
        while (open.length > 0 && open[open.length - 1]!.level >= h.level) open.pop();
        open.push(h);
      }
      return open.some((h) => sections.some((t) => h.text.startsWith(t)));
    };
  }
  const selected = new Set<number>();
  locs.forEach((loc, i) => {
    const n = numbers[i]!;
    if (n >= from && n <= to && under(loc.line)) selected.add(n);
  });
  if (selected.size === 0) throw new RunUsageError(`${selectionLabel(s)} selects no step`);
  return selected;
}

/** A block of the run with what the checks need to know about it. */
export interface PlannedBlock {
  n: number;
  loc: CodeCellLocation;
  /** It would run here: selected, for this OS, not host=, not skip, valid, not an assistant's. */
  runs: boolean;
  /** selected (whether or not it runs here) */
  selected: boolean;
  /** ${out:NAME} it uses, and capture= names it sets. */
  uses: readonly string[];
  captures: readonly string[];
}

/**
 * `${out:NAME}` in a block that runs, captured only by earlier blocks left out of the selection:
 * the value can't be there (a run starts with no captures). One message per such use.
 */
export function missingCaptures(blocks: readonly PlannedBlock[], fileName: string): string[] {
  const problems: string[] = [];
  blocks.forEach((b, i) => {
    if (!b.runs) return;
    for (const name of new Set(b.uses)) {
      const providers = blocks.slice(0, i).filter((p) => p.captures.includes(name));
      if (providers.length === 0 || providers.some((p) => p.selected)) continue;
      const by = providers[providers.length - 1]!;
      problems.push(`step ${b.n} (${fileName}:${b.loc.line + 1}) uses \${out:${name}}, captured by step ${by.n} (${fileName}:${by.loc.line + 1}), which is not selected`);
    }
  });
  return problems;
}

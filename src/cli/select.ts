/**
 * Part of a runbook for `md-runbook run`: `--from N`, `--to N` (step numbers as the run's
 * `▶ Step N` lines show them) and `--section TEXT` (the steps under a heading). And the checks
 * made before the first step, so a long run doesn't stop halfway on something known at the
 * start: a selection that selects nothing, a `${out:NAME}` whose capture is left out, cells that
 * need `--yes`.
 */

import { CodeCellLocation } from '@md-runbook/core';
import { SectionHeading, inSections, missingSections, sectionHeadings, sectionOnTitle } from '@md-runbook/core/sections';

/** A problem found before the first step: nothing ran (exit code 2). */
export class RunUsageError extends Error {}

export interface Selection {
  from?: number;
  to?: number;
  /** Heading prefixes (case-sensitive); a step under any of them is selected. */
  sections?: string[];
}

/** The ATX headings of a runbook, outside the front matter and fenced blocks (code, outputs). */
export type Heading = SectionHeading;
export const headingsOf = sectionHeadings;

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

/** A task-list item (`- [ ] Check the canary`): a step a person does, which nothing runs. */
export interface ManualStep {
  /** 0-based line. */
  line: number;
  /** The step of the block before it (0: none), which --from/--to select it with. */
  step: number;
  text: string;
  ticked: boolean;
}

/**
 * The selected step numbers, or undefined without a selection. `numbers[i]` is the step of
 * `locs[i]`. A range outside the runbook, a section without a heading, or a selection with no
 * step in it (no block, and none of `manual`) is a RunUsageError.
 */
export function selectSteps(
  text: string,
  locs: readonly CodeCellLocation[],
  numbers: readonly number[],
  s: Selection,
  manual: readonly ManualStep[] = [],
): Set<number> | undefined {
  const has = selectionFilter(text, numbers, s);
  if (!has) return undefined;
  const selected = new Set<number>();
  locs.forEach((loc, i) => {
    const n = numbers[i]!;
    if (has(n, loc.line)) selected.add(n);
  });
  if (selected.size === 0 && !manual.some((m) => has(Math.max(m.step, 1), m.line))) throw new RunUsageError(`${selectionLabel(s)} selects no step`);
  return selected;
}

/** The manual steps a selection holds: under its sections, after a block in its range (all without a selection). */
export function selectManual(text: string, numbers: readonly number[], s: Selection, manual: readonly ManualStep[]): ManualStep[] {
  const has = selectionFilter(text, numbers, s);
  return has ? manual.filter((m) => has(Math.max(m.step, 1), m.line)) : [...manual];
}

/** Whether step `n` at a 0-based line is selected; undefined without a selection. Throws RunUsageError for a bad one. */
function selectionFilter(text: string, numbers: readonly number[], s: Selection): ((n: number, line: number) => boolean) | undefined {
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
    const missing = missingSections(headings, sections);
    if (missing.length > 0) {
      throw new RunUsageError(`no heading starts with ${missing.map((t) => JSON.stringify(t)).join(', ')} (--section matches the heading text after the #s, case-sensitive)`);
    }
    // The runbook's title (its one top-level heading) holds every step, so a section matching it
    // selects them all: "6." for "## 6. The scheduled check" also matches "# 6. Are the backends up?".
    const onTitle = sectionOnTitle(headings, sections);
    if (onTitle) {
      const hint = onTitle.other !== undefined ? `; for ${JSON.stringify(onTitle.other)}, give more of it, e.g. --section ${JSON.stringify(onTitle.other.split(/\s+/).slice(0, 2).join(' '))}` : '';
      throw new RunUsageError(`--section ${JSON.stringify(onTitle.section)} matches the runbook's title ${JSON.stringify(onTitle.title)}, which holds every step${hint}`);
    }
    under = inSections(headings, sections);
  }
  return (n, line) => n >= from && n <= to && under(line);
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

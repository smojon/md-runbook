/**
 * A cell named by what it is, not by where it is. Everything that acts on a cell later holds one:
 * a card waiting for an answer (confirm, another host, a host key, values, a review), a cell's ⋯
 * sheet, Run all's queue, a group run, a run's output and a runbook call's result. Right before it
 * acts, it finds the cell again in the text as it is then (resolveCell). A cell that changed, went,
 * or can no longer be told from one alike is not acted on: the caller refuses and says why.
 *
 * The identity is stepMarks.ts cellIdentities: kind, fence options and code (Markdown: its text),
 * and which of the cells alike it is. `alike` counts those cells when the ref was taken: a copy
 * added or removed elsewhere would make "the second one" another cell, so the ref no longer holds.
 * `rules` is the front matter the ref was taken under (runRules): a run asked under one
 * practice:, kube-context:, shell: or mode: doesn't go on under another.
 */
import { parse } from '@md-runbook/core';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { sha256Hex } from '@md-runbook/core/sha256';
import { cellIdentities } from './stepMarks';

export interface CellRef {
  /** cellIdentities' id of the cell. */
  readonly id: string;
  /** How many cells had the same kind, options and code when the ref was taken. */
  readonly alike: number;
  /** runRules of the text the ref was taken from. */
  readonly rules: string;
}

const baseOf = (id: string): string => id.slice(0, id.lastIndexOf('\u0000'));

/** A digest of the parsed front matter: what the run's rules are (practice:, kube-context:, shell:, mode:, …). */
export function runRules(text: string): string {
  let fm: unknown;
  try {
    fm = parseFrontMatter(text) ?? null;
  } catch {
    fm = 'unreadable';
  }
  return sha256Hex(JSON.stringify(fm));
}

/** The identities of the cells of `text` (cellIdentities of its parse). */
export function idsOf(text: string): string[] {
  return cellIdentities(parse(text).cells);
}

/** The ref of cell `index` among cells with identities `ids`, taken under `rules`. */
export function cellRefIn(ids: readonly string[], index: number, rules: string): CellRef | undefined {
  const id = ids[index];
  if (id === undefined) return undefined;
  const base = baseOf(id);
  return { id, alike: ids.filter((x) => baseOf(x) === base).length, rules };
}

/** The ref of cell `index` of `text`. */
export function cellRef(text: string, index: number): CellRef | undefined {
  return cellRefIn(idsOf(text), index, runRules(text));
}

/** Where the cell of `ref` is among cells with identities `ids`, or undefined (changed, gone, or no longer told apart). */
export function resolveIn(ids: readonly string[], ref: CellRef): number | undefined {
  const at = ids.indexOf(ref.id);
  if (at < 0) return undefined;
  const base = baseOf(ref.id);
  return ids.filter((x) => baseOf(x) === base).length === ref.alike ? at : undefined;
}

/** Where the cell of `ref` is in `text` now, or undefined. The front matter is not looked at: see sameRules. */
export function resolveCell(text: string, ref: CellRef): number | undefined {
  return resolveIn(idsOf(text), ref);
}

/** Whether `text` has the front matter `ref` was taken under. */
export function sameRules(text: string, ref: Pick<CellRef, 'rules'>): boolean {
  return runRules(text) === ref.rules;
}

/**
 * The launch form, as VS Code's (src/launch.ts): before a Run all, one sheet with what the run
 * will need and do. The parameters (described, with their choices from `One of:`) and the inputs
 * to type, the secrets not stored yet (Set each), the risky steps with their commands (each still
 * asks when it runs), the steps done by hand, the time and where it runs. Start keeps the values
 * (parameters for the runbook, inputs for the session): the run then asks for none of them.
 * Pure: the screen gives it the text and the values it has.
 */
import { isCodeMeta, parse, shellKindForLanguage } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { EstimateStep, formatEstimate, formatLeft, runbookEstimate, stepLabel, withoutEstimate } from '@md-runbook/core/estimate';
import { proposalOf } from '@md-runbook/core/proposal';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { signedStatus } from '@md-runbook/core/signing';
import { refsOf } from './params';
import type { StepsRow } from './steps';

export interface LaunchParam {
  name: string;
  description?: string;
  choices?: string[];
  default?: string;
  /** What the field starts with, and where it comes from. */
  value?: string;
  from?: 'typed' | 'default';
}

export interface LaunchInput {
  name: string;
  /** Masked, never filled in or remembered; `set`: this session has a value for it. */
  secret: boolean;
  value?: string;
  set?: boolean;
}

export interface LaunchModel {
  params: LaunchParam[];
  inputs: LaunchInput[];
  secrets: { name: string; stored: boolean }[];
  /** Steps that ask for a confirmation when they run, with the first lines of their command. */
  risky: { index: number; step?: number; label: string; match: string; lines: string[]; more: number }[];
  /** Unticked checklist items: Run all waits at each, unless the front matter says `manual-steps: continue`. */
  byHand: { index: number; step?: number; label: string }[];
  byHandWaits: boolean;
  /** `about 4 min`, `about 40s · 1 block without an estimate`. */
  time?: string;
  /** The front matter's kube-context: every step checks it. */
  kubeContext?: string;
  /** Something to type, set or look at: a parameter, an input, a secret not stored, a risky step. */
  needed: boolean;
}

export interface LaunchSources {
  text: string;
  /** The code cells Run all runs, in order. */
  cells: readonly number[];
  /** The Steps rows (labels and step numbers, the checklist items). */
  rows: readonly StepsRow[];
  /** Parameter values typed for this runbook. */
  params: Readonly<Record<string, string>>;
  /** Inputs typed this session. */
  inputs: Readonly<Record<string, { value: string; masked: boolean }>>;
  /** The last value typed for each input (not masked ones), as the values card fills them in. */
  lastInputs?: Readonly<Record<string, string>>;
  secretNames: readonly string[];
  /** The risky words a run of `source` asks about ('' when the cell always asks), else undefined. */
  confirmation(source: string, info: string): string | undefined;
  /** The run's estimate steps (core textEstimateSteps). */
  estimateSteps: readonly EstimateStep[];
}

const PREVIEW_LINES = 3;

function preview(source: string): { lines: string[]; more: number } {
  const lines = source.split(/\r?\n/).filter((l) => l.trim() !== '');
  return { lines: lines.slice(0, PREVIEW_LINES), more: Math.max(0, lines.length - PREVIEW_LINES) };
}

/** A whole run's time by the estimates (Run all runs every step again). */
function runTime(steps: readonly EstimateStep[]): string | undefined {
  const e = runbookEstimate(steps.map(({ elapsedSeconds: _running, ...s }) => ({ ...s, state: 'pending' as const })));
  if (e.blocks === 0) return undefined;
  const total = e.totalSeconds > 0 ? (e.totalSeconds < 120 ? `about ${formatEstimate(e.totalSeconds)}` : formatLeft(e.totalSeconds)) : '';
  return [total, e.unestimated > 0 ? withoutEstimate(e.unestimated) : ''].filter((s) => s !== '').join(' · ');
}

/** The form's content for a Run all. Asks nothing, runs nothing. */
export function launchModel(s: LaunchSources): LaunchModel {
  const fm = parseFrontMatter(s.text);
  const declared = fm?.params ?? [];
  const cells = parse(s.text).cells;
  const signed = signedStatus(s.text);
  const params: LaunchParam[] = [];
  const inputs: LaunchInput[] = [];
  const secrets: LaunchModel['secrets'] = [];
  const seen = new Set<string>();
  // The values a run of these cells asks for, as VS Code's upFrontRefs: not the setup, ready check
  // and teardown (they may not run), skipped cells, cells for another host, or an assistant's cells.
  for (const i of s.cells) {
    const c = cells[i];
    if (!c || c.kind !== 'code' || !isCodeMeta(c.meta) || !shellKindForLanguage(c.languageId)) continue;
    const info = c.meta.info;
    const o = parseCellOptions(info);
    if (o.skip || o.part !== undefined || o.host !== undefined || proposalOf(info).by !== undefined) continue;
    for (const r of refsOf(c.value, info, fm)) {
      if (r.kind === 'out' || seen.has(`${r.kind}:${r.name}`)) continue;
      seen.add(`${r.kind}:${r.name}`);
      if (r.kind === 'param') {
        const p = declared.find((d) => d.name === r.name);
        const typed = s.params[r.name];
        // A signed cell doesn't take the front matter's default (runCell): the field starts empty.
        const def = signed?.cells.has(i) ? undefined : p?.default;
        const value = typed !== undefined && typed !== '' ? typed : def;
        params.push({
          name: r.name,
          ...(p?.description ? { description: p.description } : {}),
          ...(p?.choices ? { choices: p.choices } : {}),
          ...(p?.default !== undefined ? { default: p.default } : {}),
          ...(value !== undefined ? { value, from: value === typed ? 'typed' : 'default' } : {}),
        });
      } else if (r.kind === 'input') {
        const now = s.inputs[r.name];
        if (r.secret || now?.masked) inputs.push({ name: r.name, secret: true, ...(now !== undefined ? { set: true } : {}) });
        else {
          const value = now?.value ?? s.lastInputs?.[r.name];
          inputs.push({ name: r.name, secret: false, ...(value !== undefined ? { value } : {}) });
        }
      } else if (!secrets.some((x) => x.name === r.name)) secrets.push({ name: r.name, stored: s.secretNames.includes(r.name) });
    }
  }
  // Declared first, in the front matter's order, then the others in the order of use.
  const order = (name: string): number => {
    const i = declared.findIndex((d) => d.name === name);
    return i < 0 ? declared.length : i;
  };
  params.sort((a, b) => order(a.name) - order(b.name));

  const risky: LaunchModel['risky'] = [];
  const byHand: LaunchModel['byHand'] = [];
  const rowOf = new Map<number, { step?: number; label: string }>();
  for (const r of s.rows) {
    if (r.kind !== 'step') continue;
    const step = r.step !== undefined ? { step: r.step } : {};
    if (r.item !== undefined) {
      if (r.state !== 'done') byHand.push({ index: r.index, ...step, label: r.detail ?? r.label });
    } else if (!rowOf.has(r.index)) rowOf.set(r.index, { ...step, label: r.label });
  }
  // Every cell Run all runs, a row in Steps or not (the setup, the ready check, the teardown).
  for (const i of s.cells) {
    const c = cells[i];
    if (!c || c.kind !== 'code' || !isCodeMeta(c.meta)) continue;
    // A runbook call's lines are values passed, not commands: only its `confirm` asks.
    const match = s.confirmation(shellKindForLanguage(c.languageId) ? c.value : '', c.meta.info);
    if (match === undefined) continue;
    const row = rowOf.get(i) ?? { label: stepLabel(c.meta.info, c.value, c.languageId) };
    risky.push({ index: i, ...row, match: match.trim(), ...preview(c.value) });
  }
  const time = runTime(s.estimateSteps);
  return {
    params,
    inputs,
    secrets,
    risky,
    byHand,
    byHandWaits: fm?.manualSteps !== 'continue',
    ...(time ? { time } : {}),
    ...(fm?.kubeContext ? { kubeContext: fm.kubeContext } : {}),
    needed: params.length > 0 || inputs.length > 0 || secrets.some((x) => !x.stored) || risky.length > 0,
  };
}

export type LaunchError = { field: string; kind: 'choice' | 'missing'; name: string };

/**
 * The values typed at Start, checked against the form: a choice for a parameter that has
 * choices, and a value for one without a default (the run would stop at it). An empty secret
 * input is not a value: the run asks for it, or keeps the one this session has.
 */
export function startValues(
  m: LaunchModel,
  typed: { params: Readonly<Record<string, string>>; inputs: Readonly<Record<string, string>> },
): { params: Record<string, string>; inputs: Record<string, string> } | { error: LaunchError } {
  const params: Record<string, string> = {};
  const inputs: Record<string, string> = {};
  for (const p of m.params) {
    const v = typed.params[p.name] ?? p.value ?? '';
    if (p.choices && !p.choices.includes(v)) return { error: { field: `param:${p.name}`, kind: 'choice', name: p.name } };
    if (v === '' && p.default === undefined) return { error: { field: `param:${p.name}`, kind: 'missing', name: p.name } };
    params[p.name] = v;
  }
  for (const i of m.inputs) {
    const v = typed.inputs[i.name] ?? (i.secret ? '' : (i.value ?? ''));
    if (v === '' && (i.secret || i.value === undefined)) continue;
    inputs[i.name] = v;
  }
  return { params, inputs };
}

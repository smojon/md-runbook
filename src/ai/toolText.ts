/**
 * The pure part of the agent-mode tools (tools.ts): the run state as plain text for a model, the
 * tail of a failed step's output, checking a proposed step's input, and finding a runbook named
 * by path. No VS Code here, so it is unit-tested (test/lmTools.test.ts).
 *
 * What a tool returns goes to a model: step names, states, times and what a step needs, by name
 * only. Never a secret or a value typed in; output only redacted, and marked as untrusted data.
 */

import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '@md-runbook/core/aiContext';
import { PROPOSAL_LANGS } from '@md-runbook/core/aiPrompt';
import { redactLeaks } from '@md-runbook/core/leaks';

/** How many lines of a failed step's output the run state shows. */
export const FAILURE_TAIL_LINES = 20;
/** A proposed step longer than this is refused: a step is a command or a short group. */
export const MAX_PROPOSAL_CHARS = 10000;
/** At most this many failed steps get their code and output (the first ones). */
export const MAX_FAILURES_SHOWN = 3;

export type RunStepState = 'done' | 'skipped' | 'failed' | 'running' | 'pending' | 'waiting';

export interface RunStateStep {
  kind: 'step';
  /** 1-based step number; undefined for the ready check and an offered teardown. */
  step?: number;
  /** Cell index (0-based). */
  index: number;
  label: string;
  state: RunStepState;
  /** `est. 2m`, `took 3m10s (+40s)`, `12s of 1m`, `by hand`. */
  time?: string;
  /** What running it will need from the reader, by name only (stepsView.ts stepNeeds). */
  needs?: string[];
}

/** A `#`/`##` heading between the steps. */
export interface RunStateChapter {
  kind: 'chapter';
  title: string;
  level: number;
}

export interface RunStateFailure {
  step?: number;
  index: number;
  label: string;
  language: string;
  /** The step's code, redacted. */
  code: string;
  /** Its last output lines, redacted (failureTail). */
  tail: string[];
  /** Output lines before the tail that were left out. */
  omitted: number;
}

export interface RunStateView {
  /** File name, e.g. `deploy-checkout.md`. */
  name: string;
  /** Path as the workspace shows it. */
  path: string;
  /** Where the run is, in the status bar's words: `Step 4/6 failed`. */
  headline: string;
  state: 'idle' | 'running' | 'failed' | 'done' | 'waiting';
  /** `41%` or `2 of 6 steps`, and the time left, when the estimates can say. */
  share?: string;
  left?: string;
  /** What the run waits for, if anything: what is asked, on which step, and where. */
  waiting?: { what: string; label: string; step?: number; where: 'box' | 'dialog' | 'cell' };
  /** The "Before you run" line (stepsView.ts), without secret or input values. */
  preflight?: string;
  rows: (RunStateStep | RunStateChapter)[];
  failures: RunStateFailure[];
  /** Cells waiting for approval. */
  proposals: number;
  /** Other runbooks open as runbooks, by path (the model can name one). */
  others: string[];
}

const WHERE = { box: "VS Code's input box at the top of the window", dialog: 'a dialog', cell: 'buttons on the cell' } as const;

/** A fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const stepName = (s: { step?: number; label: string }): string => (s.step !== undefined ? `step ${s.step} (${s.label})` : s.label);

/** The run state as plain text for a model. */
export function formatRunState(v: RunStateView): string {
  const out: string[] = [];
  out.push(`Runbook: ${v.name} (${v.path})`);
  out.push(`Status: ${v.headline}`);
  const progress = [v.share, v.left].filter((s): s is string => !!s);
  if (progress.length) out.push(`Progress: ${progress.join(' · ')}`);
  out.push(v.waiting ? `Waiting for: ${v.waiting.what}, on ${stepName(v.waiting)}, asked in ${WHERE[v.waiting.where]}. The run goes on once the user answers there.` : 'Waiting for: nothing');
  if (v.preflight) out.push(v.preflight);
  if (v.proposals > 0) out.push(`Proposed steps awaiting approval: ${v.proposals}`);
  out.push('');
  if (!v.rows.some((r) => r.kind === 'step')) out.push('Steps: none (no runnable code blocks or checklist items).');
  else out.push('Steps (number. name: state, time):');
  for (const s of v.rows) {
    if (s.kind === 'chapter') {
      out.push(`${'#'.repeat(Math.max(1, s.level))} ${s.title}`);
      continue;
    }
    // The ready check and an offered teardown have no number.
    const num = s.step !== undefined ? `${s.step}.` : '-';
    const tail = [s.state, s.time].filter(Boolean).join(', ');
    const needs = s.needs?.length ? `; needs ${s.needs.join(', ')}` : '';
    out.push(`${num} ${s.label}: ${tail}${needs}`);
  }
  for (const f of v.failures) {
    out.push('', `Failed ${stepName(f)}, cell ${f.index + 1}, ${f.language}:`);
    const code = f.code.replace(/\s+$/, '');
    const fc = fenceFor(code);
    out.push(`${fc}${f.language}`, code, fc);
    if (f.tail.length === 0) out.push('It printed nothing.');
    else {
      out.push(`Last ${f.tail.length} line${f.tail.length === 1 ? '' : 's'} of its output${f.omitted > 0 ? ` (${f.omitted} earlier line${f.omitted === 1 ? '' : 's'} left out)` : ''}, redacted:`);
      out.push(UNTRUSTED_OPEN, ...f.tail, UNTRUSTED_CLOSE);
    }
  }
  if (v.others.length) out.push('', `Other open runbooks: ${v.others.join(', ')}`);
  out.push(
    '',
    'To suggest a command, use the md-runbook_proposeStep tool: it adds a proposed step that the user reviews and approves before it can run. Nothing here runs commands.',
  );
  return out.join('\n');
}

/**
 * Redaction for text a tool hands to a model: the secret values seen this session first (exact),
 * then the patterns, then whatever Check for Leaks would flag. Copy for AI asks before sharing a
 * possible leak; a tool can't ask, so it redacts those too.
 */
export function redactForModel(known: (s: string) => string, patterns: (s: string) => string, internalDomains: string[] = []): (s: string) => string {
  return (s) => redactLeaks(patterns(known(s)), { internalDomains });
}

const ANSI_RE =/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * The last `max` lines of an output, redacted. The whole text is redacted before it is cut, so a
 * pattern that needs context (a Kubernetes Secret's `data:` block) still sees it.
 */
export function failureTail(text: string, redact: (s: string) => string, max = FAILURE_TAIL_LINES): { lines: string[]; omitted: number } {
  const lines = redact(text.replace(ANSI_RE, '').replace(/\r\n?/g, '\n')).split('\n');
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  while (lines.length && lines[0]!.trim() === '') lines.shift();
  // A line that only imitates the markers can't close the untrusted block early.
  const safe = lines.map((l) => (l.includes('<<<') ? l.replace(/<<</g, '‹‹‹') : l));
  const n = Math.max(0, Math.floor(max));
  return { lines: n === 0 ? [] : safe.slice(-n), omitted: Math.max(0, safe.length - n) };
}

export interface ProposeStepInput {
  code: string;
  language: string;
  reason: string;
  afterStep?: number;
  name?: string;
  runbook?: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Languages a proposed step may use (the same as Suggest Next Steps). */
export const PROPOSE_LANGUAGES: readonly string[] = PROPOSAL_LANGS;

/** Check the input of md-runbook_proposeStep; the errors are written for the model. */
export function checkProposeInput(raw: unknown): Checked<ProposeStepInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'The input must be an object with code and reason.' };
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== 'string' || r.code.trim() === '') return { ok: false, error: 'code must be the command(s) to propose, as a non-empty string.' };
  const code = r.code.replace(/\r\n?/g, '\n').replace(/\s+$/, '').replace(/^(?:[ \t]*\n)+/, '');
  if (code.length > MAX_PROPOSAL_CHARS) return { ok: false, error: `code is ${code.length} characters; propose one command or a short group (at most ${MAX_PROPOSAL_CHARS}).` };
  const language = r.language === undefined ? 'bash' : typeof r.language === 'string' ? r.language.trim().toLowerCase() : '';
  if (!PROPOSE_LANGUAGES.includes(language)) return { ok: false, error: `language must be one of ${PROPOSE_LANGUAGES.join(', ')}.` };
  if (typeof r.reason !== 'string' || r.reason.trim() === '') return { ok: false, error: 'reason must say in a few words what the step checks or does, and why; the user sees it when approving.' };
  const value: ProposeStepInput = { code, language, reason: r.reason.trim() };
  if (r.afterStep !== undefined && r.afterStep !== null) {
    if (typeof r.afterStep !== 'number' || !Number.isInteger(r.afterStep) || r.afterStep < 1) {
      return { ok: false, error: 'afterStep must be a step number (1 or more) as the md-runbook_runState tool lists them; leave it out to add the step after the failed step, else at the end.' };
    }
    value.afterStep = r.afterStep;
  }
  if (r.name !== undefined && r.name !== null) {
    if (typeof r.name !== 'string') return { ok: false, error: 'name must be a short string.' };
    if (r.name.trim()) value.name = r.name.trim();
  }
  if (r.runbook !== undefined && r.runbook !== null) {
    if (typeof r.runbook !== 'string') return { ok: false, error: 'runbook must be the path of an open runbook.' };
    if (r.runbook.trim()) value.runbook = r.runbook.trim();
  }
  return { ok: true, value };
}

/** Where a proposal goes: after the cell of `afterStep`, else after the first failed step, else at the end. */
export function proposalTarget(
  steps: readonly { step?: number; index: number; state: RunStepState }[],
  cellCount: number,
  afterStep?: number,
): Checked<{ at: number; after?: number }> {
  if (afterStep !== undefined) {
    // A checklist cell holds several steps: after the cell, whichever item it was.
    const hit = steps.find((s) => s.step === afterStep);
    if (!hit) {
      const last = Math.max(0, ...steps.map((s) => s.step ?? 0));
      return { ok: false, error: last ? `There is no step ${afterStep}; the steps are numbered 1 to ${last}.` : `There is no step ${afterStep}: the runbook has no steps yet; leave afterStep out.` };
    }
    return { ok: true, value: { at: hit.index + 1, after: afterStep } };
  }
  const failed = steps.find((s) => s.state === 'failed');
  if (failed) return { ok: true, value: { at: failed.index + 1, ...(failed.step !== undefined ? { after: failed.step } : {}) } };
  return { ok: true, value: { at: cellCount } };
}

export interface RunbookCandidate {
  /** Absolute file path (or URI for an unsaved one). */
  path: string;
  /** Path relative to the workspace folder. */
  relative: string;
}

const norm = (p: string): string =>
  p
    .trim()
    .replace(/^file:\/\/\/?/i, '')
    .replace(/\\/g, '/')
    .replace(/^\/(?=[a-z]:)/i, '')
    .replace(/^\.\//, '')
    .toLowerCase();
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const noExt = (p: string): string => p.replace(/\.(md|markdown)$/, '');

/**
 * The open runbook `query` names: its path, its workspace-relative path, its file name, with or
 * without `.md` (case-insensitive: the model may not match the case). Index into `candidates`.
 */
export function pickRunbook(query: string, candidates: readonly RunbookCandidate[]): Checked<number> {
  const q = norm(decodeURIComponentSafe(query));
  const list = candidates.map((c) => ({ path: norm(c.path), relative: norm(c.relative) }));
  const tries: ((c: { path: string; relative: string }) => boolean)[] = [
    (c) => c.path === q,
    (c) => c.relative === q,
    (c) => c.path.endsWith(`/${q}`),
    (c) => noExt(c.relative) === noExt(q),
    (c) => base(c.path) === base(q),
    (c) => noExt(base(c.path)) === noExt(base(q)),
  ];
  for (const t of tries) {
    const hits = list.map((c, i) => (t(c) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return { ok: true, value: hits[0]! };
    if (hits.length > 1) return { ok: false, error: `"${query}" matches more than one open runbook: ${hits.map((i) => candidates[i]!.relative).join(', ')}. Give its path.` };
  }
  const open = candidates.map((c) => c.relative);
  return {
    ok: false,
    error: `No open runbook matches "${query}". ${open.length ? `Open runbooks: ${open.join(', ')}.` : 'No runbook is open.'} Ask the user to open it as a runbook (md-runbook: Open as Runbook).`,
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return /^file:/i.test(s) ? decodeURIComponent(s) : s;
  } catch {
    return s;
  }
}

/**
 * The confirmation proposeStep shows before it adds anything (the code follows it as a code
 * block). `message` is Markdown: what the model wrote is escaped, so it can't add links or
 * formatting to the question.
 */
export function proposeConfirmation(runbook: string, p: ProposeStepInput, after: string | undefined): { title: string; message: string } {
  return {
    title: `Add a proposed step to ${runbook} ${after ? `after ${after}` : 'at the end'}?`,
    message: [
      `It is added as a **proposal**${p.name ? ` named “${escapeMarkdown(p.name)}”` : ''}: it can't run until you approve it on the cell. Nothing runs now.`,
      '',
      `Reason: ${escapeMarkdown(p.reason)}`,
    ].join('\n'),
  };
}

/** Markdown special characters escaped, for names that come from a runbook. */
export function escapeMarkdown(t: string): string {
  return t.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

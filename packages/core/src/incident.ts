/**
 * The run record of a runbook as a timeline, for audit evidence and postmortems: every recorded
 * run of every step (the latest output and the earlier ones kept in its history), steps marked
 * done or skipped by hand, and notes (Add Note) with their milestones, in time order; and a
 * summary: the incident and its severity, start, end, failed attempts, time to mitigate and to
 * resolve, and the `rto:` target. Export Report shows it, and the JSON export carries it.
 */

import { parseCellOptions } from './cellOptions';
import { isCodeMeta } from './model';
import { stepNumbers } from './os';
import { formatAttrs, formatLocalIso, parseAttrs } from './outputBlock';
import { parse } from './parser';
import { parseFrontMatter } from './secrets';

export const MILESTONES = ['detected', 'mitigated', 'resolved'] as const;
export type Milestone = (typeof MILESTONES)[number];

export interface TimelineEvent {
  /** When it happened: the run's start, the note's time (ISO, local time with offset, as written). */
  at: string;
  kind: 'run' | 'mark' | 'note';
  /** For runs and marks: the step number (1-based, as Export Report numbers runnable blocks) and its label. */
  step?: number;
  label?: string;
  /** Who ran it or wrote it (`by=`), and where it ran (`on=`), when recorded. */
  by?: string;
  on?: string;
  /** For runs and marks: the exit as written (`0`, `1`, `timeout`, `done`, `skipped`, …) and the check result. */
  exit?: string;
  check?: string;
  ok?: boolean;
  duration?: string;
  /** An earlier attempt (from the history), not the step's latest result. */
  earlier?: boolean;
  /** For notes: the text and the milestone it marks. */
  text?: string;
  milestone?: Milestone;
}

export interface TimelineSummary {
  incident?: string;
  severity?: string;
  /** First and last event, and the time between. */
  start?: string;
  end?: string;
  durationSeconds?: number;
  runs: number;
  failedAttempts: number;
  /** The first note of each milestone. */
  milestones: Partial<Record<Milestone, string>>;
  /** From `detected` (else the first event) to `mitigated` / `resolved`. */
  timeToMitigateSeconds?: number;
  timeToResolveSeconds?: number;
  rtoSeconds?: number;
  /** Whether the record (first event to `resolved`, else to the last event) met the `rto:`. */
  rtoMet?: boolean;
  /** People and places seen in the record. */
  people: string[];
  places: string[];
}

export interface Timeline {
  events: TimelineEvent[];
  summary: TimelineSummary;
}

const NOTE_RE = /^[ \t]*<!--[ \t]*md-runbook:note\b(.*?)-->[ \t]*\r?\n((?:[ \t]*>.*(?:\r?\n|$))*)/gm;

/** A note for the record (Add Note): a marker with its time, author and milestone, then a quote. */
export function formatNote(note: { at: Date; by?: string; milestone?: Milestone; text: string }, eol = '\n'): string {
  const attrs: Record<string, string> = { at: formatLocalIso(note.at) };
  if (note.by) attrs.by = note.by;
  if (note.milestone) attrs.milestone = note.milestone;
  const hhmm = formatLocalIso(note.at).slice(11, 16);
  const head = [hhmm, note.milestone, note.by].filter(Boolean).join(' · ');
  const lines = note.text.trim().split(/\r?\n/);
  return [`<!-- md-runbook:note${formatAttrs(attrs)} -->`, `> **${head}:** ${lines[0] ?? ''}`, ...lines.slice(1).map((l) => `> ${l}`)].join(eol) + eol;
}

/** Notes written by formatNote, wherever they are in the text. */
export function parseNotes(text: string): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const m of text.matchAll(NOTE_RE)) {
    const attrs = parseAttrs(m[1] ?? '');
    if (!attrs.at || Number.isNaN(Date.parse(attrs.at))) continue;
    const quote = (m[2] ?? '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^[ \t]*>[ \t]?/, ''))
      .join('\n')
      .trim()
      .replace(/^\*\*[^*]*:\*\*\s*/, '');
    const milestone = (MILESTONES as readonly string[]).includes(attrs.milestone ?? '') ? (attrs.milestone as Milestone) : undefined;
    out.push({ at: attrs.at, kind: 'note', text: quote, ...(attrs.by ? { by: attrs.by } : {}), ...(milestone ? { milestone } : {}) });
  }
  return out;
}

const FAILED = (exit: string | undefined, check: string | undefined): boolean =>
  check === 'failed' || (exit !== undefined && !['0', 'done', 'skipped', 'running', 'proposed', 'declined'].includes(exit) && check !== 'ok');

function event(attrs: Record<string, string>, step: number, label: string, earlier: boolean): TimelineEvent | undefined {
  if (!attrs.ran || Number.isNaN(Date.parse(attrs.ran))) return undefined;
  const manual = attrs.exit === 'done' || attrs.exit === 'skipped';
  return {
    at: attrs.ran,
    kind: manual && attrs.duration === undefined ? 'mark' : 'run',
    step,
    label,
    ...(attrs.by ? { by: attrs.by } : {}),
    ...(attrs.on ? { on: attrs.on } : {}),
    ...(attrs.exit !== undefined ? { exit: attrs.exit } : {}),
    ...(attrs.check ? { check: attrs.check } : {}),
    ok: !FAILED(attrs.exit, attrs.check),
    ...(attrs.duration ? { duration: attrs.duration } : {}),
    ...(earlier ? { earlier: true } : {}),
  };
}

const seconds = (from: string, to: string): number => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));

/** The timeline and its summary. Runnable blocks are numbered as in Export Report. */
export function buildTimeline(text: string): Timeline {
  const fm = parseFrontMatter(text);
  const events: TimelineEvent[] = [];
  const doc = parse(text);
  const options = doc.cells.map((c) => (isCodeMeta(c.meta) ? parseCellOptions(c.meta.info) : undefined));
  const steps = stepNumbers(doc.cells.map((c, i) => (isCodeMeta(c.meta) ? { kind: 'code' as const, os: options[i]?.os } : { kind: 'markup' as const })));
  for (const [i, cell] of doc.cells.entries()) {
    const step = steps[i];
    if (step === undefined || !isCodeMeta(cell.meta)) continue;
    const label = options[i]?.name ?? cell.value.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? `step ${step}`;
    if (cell.output) {
      const e = event(cell.output.attrs, step, label, false);
      if (e) events.push(e);
    }
    for (const h of cell.meta.history?.entries ?? []) {
      const e = event(h.attrs, step, label, true);
      if (e) events.push(e);
    }
  }
  events.push(...parseNotes(text));
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.step ?? 0) - (b.step ?? 0));

  const milestones: Partial<Record<Milestone, string>> = {};
  for (const e of events) if (e.milestone && !milestones[e.milestone]) milestones[e.milestone] = e.at;
  const runs = events.filter((e) => e.kind === 'run');
  const start = events[0]?.at;
  const end = events[events.length - 1]?.at;
  const from = milestones.detected ?? start;
  const summary: TimelineSummary = {
    ...(fm?.incident ? { incident: fm.incident } : {}),
    ...(fm?.severity ? { severity: fm.severity } : {}),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(start && end ? { durationSeconds: seconds(start, end) } : {}),
    runs: runs.length,
    failedAttempts: runs.filter((e) => !e.ok).length,
    milestones,
    ...(from && milestones.mitigated ? { timeToMitigateSeconds: seconds(from, milestones.mitigated) } : {}),
    ...(from && milestones.resolved ? { timeToResolveSeconds: seconds(from, milestones.resolved) } : {}),
    people: [...new Set(events.flatMap((e) => (e.by ? [e.by] : [])))],
    places: [...new Set(events.flatMap((e) => (e.on ? [e.on] : [])))],
  };
  if (fm?.rtoSeconds !== undefined) {
    summary.rtoSeconds = fm.rtoSeconds;
    const until = milestones.resolved ?? end;
    if (start && until) summary.rtoMet = seconds(start, until) <= fm.rtoSeconds;
  }
  return { events, summary };
}

/** `95` → `1 min 35 s`, `7200` → `2 h`, for the report. */
export function formatSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : '', sec || (!h && !m) ? `${sec} s` : ''].filter(Boolean).join(' ');
}

/** Earlier runs kept per step while a runbook keeps evidence: every attempt, within reason. */
export const EVIDENCE_HISTORY_SIZE = 100;

/**
 * `by=` (who ran it) and `on=` (where it ran) for a run's output marker, when the runbook keeps
 * evidence (`incident:` or `evidence: true` in its front matter) or the client always records them.
 */
export function runnerAttrs(text: string, who: { by?: string; on?: string }, always = false): Record<string, string> {
  if (!always && !parseFrontMatter(text)?.evidence) return {};
  return { ...(who.by ? { by: who.by } : {}), ...(who.on ? { on: who.on } : {}) };
}

/** How many earlier runs to keep per step: the setting, or every attempt while keeping evidence. */
export function historySizeFor(text: string, configured: number): number {
  return parseFrontMatter(text)?.evidence ? Math.max(configured, EVIDENCE_HISTORY_SIZE) : configured;
}

/**
 * The text with these top-level front matter keys set (replaced when present, added otherwise; a
 * front matter is added when there is none). Values are written as YAML strings.
 */
export function withFrontMatterValues(text: string, values: Record<string, string>): string {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? text.slice(1) : text;
  const quote = (v: string): string => (/^[\w.@:/+ -]*$/.test(v) && !/^\s|\s$|: /.test(v) ? v : JSON.stringify(v));
  const lines = body.split(/\r?\n/);
  const end = lines[0]?.trimEnd() === '---' ? lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l)) : -1;
  if (end < 0) {
    const fm = ['---', ...Object.entries(values).map(([k, v]) => `${k}: ${quote(v)}`), '---', ''];
    return bom + fm.join(eol) + eol + body;
  }
  const head = lines.slice(1, end);
  for (const [k, v] of Object.entries(values)) {
    const at = head.findIndex((l) => new RegExp(`^${k}\s*:`).test(l));
    if (at >= 0) head[at] = `${k}: ${quote(v)}`;
    else head.push(`${k}: ${quote(v)}`);
  }
  return bom + ['---', ...head, ...lines.slice(end)].join(eol);
}

/** The text with `block` (a note) right after its front matter, else at the start; blank lines around it. */
export function withBlockAfterFrontMatter(text: string, block: string): string {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const end = lines[0]?.replace(/^\uFEFF/, '').trimEnd() === '---' ? lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l)) : -1;
  const at = end + 1;
  const piece = block.replace(/\r?\n$/, '').split(/\r?\n/);
  return [...lines.slice(0, at), ...(at > 0 ? [''] : []), ...piece, '', ...lines.slice(at).join(eol).replace(/^(\r?\n)+/, '').split(/\r?\n/)].join(eol);
}

/** The text with `block` (a note) at its end, after a blank line. */
export function withBlockAtEnd(text: string, block: string): string {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  return `${text.replace(/(\r?\n)*$/, '')}${eol}${eol}${block.replace(/\r?\n/g, eol).replace(/(\r?\n)*$/, '')}${eol}`;
}

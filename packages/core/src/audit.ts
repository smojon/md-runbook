/**
 * md-runbook audit: what servers with md-runbook-gate say happened, from their log (one JSON line
 * per event: syslog with the tag md-runbook-gate, or the gate's log file). For each run: when, who
 * (the key's fingerprint or the name the gate was given), from where, as which account, which
 * signed runbook (name, version, manifest hash, the signer the gate accepted), which block and
 * step, the parameter values, the exit code and how long it took. Refusals and unsigned runs are
 * listed as findings. A saved run record (the runbook with its outputs) can be matched against it:
 * each recorded step the log confirms, and the ones it doesn't.
 *
 * The gate writes these events (apps/gate/md-runbook-gate): session, load, param, run, end (by the
 * account's shell: time, id, exit), unsigned, refused, stop, end-session.
 */

import { isCodeMeta } from './model';
import { stepNumbers } from './os';
import { escapeHtml } from './markdown';
import { formatLocalIso } from './outputBlock';
import { REPORT_CSS } from './report';
import { parseCellOptions } from './cellOptions';
import { parse } from './parser';
import { signedStatus } from './signing';

export interface GateEvent {
  time: string;
  event: string;
  account?: string;
  who?: string;
  client?: string;
  [key: string]: unknown;
}

export interface AuditRun {
  /** Start (UTC, as the gate wrote it) and end, when the account's shell logged one. */
  time: string;
  ended?: string;
  durationSeconds?: number;
  account: string;
  who: string;
  client: string;
  runbook: string;
  version: string;
  hash: string;
  signer: string;
  /** The block's number in the manifest, and the step in it ('' for the whole block). */
  cell: string;
  step: string;
  /** Parameter values loaded for this runbook in the session before the run. */
  params: Record<string, string>;
  exit?: number;
  /** Set by matchRecord: where this run is in the saved record. */
  matched?: { file: string; step: number };
}

export interface AuditFinding {
  time: string;
  kind: 'refused' | 'unsigned' | 'stop';
  account: string;
  who: string;
  client: string;
  detail: string;
}

export interface Audit {
  runs: AuditRun[];
  findings: AuditFinding[];
  sessions: number;
  /** Lines that were not gate events (other syslog lines): skipped, counted. */
  skipped: number;
}

/** The gate events in a log: JSON lines, alone or after a syslog prefix ("… md-runbook-gate[42]: {…}"). */
export function parseGateLog(text: string): { events: GateEvent[]; skipped: number } {
  const events: GateEvent[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const at = line.indexOf('{');
    if (at < 0) {
      skipped++;
      continue;
    }
    try {
      const e = JSON.parse(line.slice(at)) as GateEvent;
      if (typeof e.time === 'string' && typeof e.event === 'string') events.push(e);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { events, skipped };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : String(v));

/**
 * Runs and findings, in time order. Events of a session share its account, key and client; an
 * `end` (written by the account's shell, without those) closes the latest open run of its id.
 */
export function buildAudit(events: readonly GateEvent[], skipped = 0): Audit {
  const sorted = [...events].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const runs: AuditRun[] = [];
  const findings: AuditFinding[] = [];
  /** Per session (account, key, client): parameter values by runbook. */
  const params = new Map<string, Map<string, Record<string, string>>>();
  const open = new Map<string, AuditRun>();
  let sessions = 0;
  const sessionOf = (e: GateEvent): string => `${str(e.account)}\n${str(e.who)}\n${str(e.client)}`;
  for (const e of sorted) {
    const s = sessionOf(e);
    switch (e.event) {
      case 'session':
        sessions++;
        params.set(s, new Map());
        break;
      case 'load':
        if (!params.has(s)) params.set(s, new Map());
        params.get(s)!.set(str(e.runbook), {});
        break;
      case 'param': {
        const byRunbook = params.get(s) ?? new Map<string, Record<string, string>>();
        params.set(s, byRunbook);
        const p = byRunbook.get(str(e.runbook)) ?? {};
        p[str(e.name)] = str(e.value);
        byRunbook.set(str(e.runbook), p);
        break;
      }
      case 'run': {
        const run: AuditRun = {
          time: e.time,
          account: str(e.account),
          who: str(e.who),
          client: str(e.client),
          runbook: str(e.runbook),
          version: str(e.version),
          hash: str(e.hash),
          signer: str(e.signer),
          cell: str(e.cell),
          step: str(e.step),
          params: { ...(params.get(s)?.get(str(e.runbook)) ?? {}) },
        };
        runs.push(run);
        open.set(str(e.id), run);
        break;
      }
      case 'end': {
        const run = open.get(str(e.id));
        if (!run) break;
        open.delete(str(e.id));
        run.ended = e.time;
        run.durationSeconds = Math.max(0, Math.round((Date.parse(e.time) - Date.parse(run.time)) / 1000));
        if (typeof e.exit === 'number') run.exit = e.exit;
        break;
      }
      case 'refused':
      case 'unsigned':
      case 'stop':
        findings.push({
          time: e.time,
          kind: e.event,
          account: str(e.account),
          who: str(e.who),
          client: str(e.client),
          detail: e.event === 'refused' ? str(e.reason) : e.event === 'unsigned' ? `unsigned code, sha256 ${str(e.hash)}` : `stopped (${str(e.signal)})`,
        });
        break;
    }
  }
  return { runs, findings, sessions, skipped };
}

/** Keep the runs and findings in a time range and, optionally, of one runbook or one key. */
export function filterAudit(a: Audit, f: { since?: Date; until?: Date; runbook?: string; who?: string }): Audit {
  const inRange = (t: string): boolean => (!f.since || Date.parse(t) >= f.since.getTime()) && (!f.until || Date.parse(t) <= f.until.getTime());
  return {
    ...a,
    runs: a.runs.filter((r) => inRange(r.time) && (!f.runbook || r.runbook === f.runbook) && (!f.who || r.who === f.who)),
    findings: a.findings.filter((x) => inRange(x.time) && (!f.who || x.who === f.who)),
  };
}

export interface RecordMatch {
  file: string;
  runbook: string;
  /** Recorded runs of signed blocks the log confirms, and those it doesn't show. */
  confirmed: { step: number; ran: string }[];
  missing: { step: number; ran: string }[];
}

/**
 * Match a saved run record (a signed runbook with its outputs) against the log: a recorded run of
 * a signed block is confirmed when the log has a run of that runbook's block within `slackSeconds`
 * of its `ran=` (clocks differ a little; the gate logs in UTC, the record in local time).
 */
export function matchRecord(a: Audit, file: string, text: string, slackSeconds = 120): RecordMatch {
  // Which file cell is which signed block (as clients and the gate compare them).
  const signed = signedStatus(text);
  const name = signed?.manifest.name ?? '';
  const doc = parse(text);
  const options = doc.cells.map((c) => (isCodeMeta(c.meta) ? parseCellOptions(c.meta.info) : undefined));
  const steps = stepNumbers(doc.cells.map((c, i) => (isCodeMeta(c.meta) ? { kind: 'code' as const, os: options[i]?.os } : { kind: 'markup' as const })));
  const confirmed: RecordMatch['confirmed'] = [];
  const missing: RecordMatch['missing'] = [];
  const used = new Set<AuditRun>();
  for (const [i, cell] of doc.cells.entries()) {
    const step = steps[i];
    if (step === undefined || !isCodeMeta(cell.meta)) continue;
    const ran = cell.output?.attrs.ran;
    if (!ran || Number.isNaN(Date.parse(ran))) continue;
    const n = signed?.cells.get(i)?.n;
    if (n === undefined) continue; // not a signed block (or changed since): the gate never ran it as one
    const hit = a.runs.find(
      (r) => !used.has(r) && r.runbook === name && r.cell === String(n) && Math.abs(Date.parse(r.time) - Date.parse(ran)) <= slackSeconds * 1000,
    );
    if (hit) {
      used.add(hit);
      hit.matched = { file, step };
      confirmed.push({ step, ran });
    } else missing.push({ step, ran });
  }
  return { file, runbook: name, confirmed, missing };
}

const when = (iso: string): string => iso.replace('T', ' ').replace(/Z$/, ' UTC');

/**
 * The audit as a self-contained HTML page (the reports' style; no scripts): the period and
 * totals, the runbooks run, every run with who, from where, the parameters, exit and duration,
 * the findings (refused, unsigned, stopped), and each run record matched against the log.
 */
export function renderAuditReport(a: Audit, matches: readonly RecordMatch[], opts: { generatedAt: Date; sources: string[] }): string {
  const runs = a.runs;
  const failed = runs.filter((r) => r.exit !== undefined && r.exit !== 0).length;
  const people = new Set(runs.map((r) => r.who));
  const period = runs.length ? `${when(runs[0]!.time)} – ${when(runs[runs.length - 1]!.time)}` : 'no runs';
  const byRunbook = new Map<string, { version: string; signer: string; runs: number; failed: number }>();
  for (const r of runs) {
    const k = `${r.runbook} v${r.version}`;
    const e = byRunbook.get(k) ?? { version: r.version, signer: r.signer, runs: 0, failed: 0 };
    e.runs++;
    if (r.exit !== undefined && r.exit !== 0) e.failed++;
    byRunbook.set(k, e);
  }
  const td = (s: string): string => `<td>${escapeHtml(s)}</td>`;
  const exitBadge = (r: AuditRun): string =>
    r.exit === undefined ? '<span class="badge none">no end logged</span>' : `<span class="badge ${r.exit === 0 ? 'ok' : 'fail'}">exit ${r.exit}</span>`;
  const runRows = runs
    .map(
      (r) =>
        `<tr>${td(when(r.time))}${td(r.who)}${td(`${r.account} from ${r.client}`)}${td(`${r.runbook} v${r.version}`)}${td(`${r.cell}${r.step ? `.${r.step}` : ''}`)}` +
        `${td(Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' '))}<td>${exitBadge(r)}</td>${td(r.durationSeconds === undefined ? '' : `${r.durationSeconds} s`)}` +
        `${td(r.matched ? `${r.matched.file}, step ${r.matched.step}` : '')}</tr>\n`,
    )
    .join('');
  const findingRows = a.findings.map((f) => `<tr>${td(when(f.time))}${td(f.kind)}${td(f.who)}${td(`${f.account} from ${f.client}`)}${td(f.detail)}</tr>\n`).join('');
  const runbookRows = [...byRunbook.entries()]
    .map(([k, e]) => `<tr>${td(k)}${td(e.signer)}${td(String(e.runs))}${td(String(e.failed))}</tr>\n`)
    .join('');
  const matchHtml = matches
    .map(
      (m) =>
        `<h3>${escapeHtml(m.file)}${m.runbook ? ` (${escapeHtml(m.runbook)})` : ''}</h3>\n<p>${m.confirmed.length} recorded run${m.confirmed.length === 1 ? '' : 's'} of signed blocks confirmed by the log` +
        (m.missing.length
          ? `; <strong>not in the log</strong>: ${m.missing.map((x) => `step ${x.step} at ${escapeHtml(x.ran)}`).join(', ')} (ran elsewhere, unsigned, or the log is incomplete)`
          : '') +
        '.</p>\n',
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="md-runbook audit">
<title>Gate audit</title>
<style>${REPORT_CSS}@page{@bottom-right{content:"Page " counter(page) " of " counter(pages);font:10px sans-serif;color:#656d76}}</style>
</head>
<body>
<header>
<h1 class="title">Gate audit</h1>
<p class="meta">Generated ${escapeHtml(formatLocalIso(opts.generatedAt))} from ${escapeHtml(opts.sources.join(', '))} · ${a.sessions} session${a.sessions === 1 ? '' : 's'} · ${runs.length} run${runs.length === 1 ? '' : 's'} by ${people.size} ${people.size === 1 ? 'key' : 'keys'} · ${failed} failed · ${a.findings.length} finding${a.findings.length === 1 ? '' : 's'}</p>
</header>
<section class="record">
<dl class="facts"><div><dt>Period</dt><dd>${escapeHtml(period)}</dd></div><div><dt>Runs</dt><dd>${runs.length}${failed ? ` · ${failed} failed` : ''}</dd></div><div><dt>Findings</dt><dd>${a.findings.length}</dd></div>${a.skipped ? `<div><dt>Other log lines</dt><dd>${a.skipped} skipped</dd></div>` : ''}</dl>
</section>
<h2>Runbooks</h2>
<table class="timeline"><thead><tr><th>Runbook</th><th>Signer (as the gate accepted)</th><th>Runs</th><th>Failed</th></tr></thead><tbody>
${runbookRows}</tbody></table>
<h2>Runs</h2>
<table class="timeline"><thead><tr><th>Time</th><th>Who (key)</th><th>Account, client</th><th>Runbook</th><th>Block</th><th>Parameters</th><th>Result</th><th>Duration</th><th>In run record</th></tr></thead><tbody>
${runRows}</tbody></table>
<h2>Findings</h2>
${findingRows ? `<table class="timeline"><thead><tr><th>Time</th><th>What</th><th>Who (key)</th><th>Account, client</th><th>Detail</th></tr></thead><tbody>\n${findingRows}</tbody></table>` : '<p>None: no refusals, no unsigned code, no stopped runs.</p>'}
${matches.length ? `<h2>Run records</h2>\n${matchHtml}` : ''}</body>
</html>
`;
}

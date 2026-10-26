/**
 * A runbook as one self-contained HTML report: a summary table of the steps, then the whole
 * document with each step's stored output. No scripts and no external resources.
 */

import { stripAnsi } from './ansi';
import { escapeHtml, renderCodeBlock, renderInline, renderMarkdown } from './markdown';
import { parseCellOptions } from './cellOptions';
import { isCodeMeta } from './model';
import { osGroups, osLabel, stepNumbers } from './os';
import { formatLocalIso } from './outputBlock';
import { parse } from './parser';
import { MILESTONES, Timeline, buildTimeline, formatSeconds } from './incident';
import { recordSigners, recordStatus } from './record';

export interface ReportOptions {
  generatedAt: Date;
  /** Used when the document has no heading. */
  fallbackTitle?: string;
  /**
   * Applied to stored outputs once more (they were already redacted when written), to the code of
   * every step and fenced block, and to front matter.
   */
  redact?: (text: string) => string;
}

type Status = 'ok' | 'fail' | 'skip' | 'none';

/** `lines` set: only some lines of the step ran (a line run); it is not done yet. */
function statusOf(exit: string | undefined, lines?: string, check?: string): Status {
  if (exit === undefined) return 'none';
  if (check === 'failed') return 'fail';
  if (check === 'ok') return lines === undefined ? 'ok' : 'none';
  if (exit === '0' || exit === 'done') return lines === undefined ? 'ok' : 'none';
  if (exit === 'running' || exit === 'declined' || exit === 'proposed') return 'none';
  return exit === 'skipped' ? 'skip' : 'fail';
}

function badge(exit: string | undefined, lines?: string, check?: string): string {
  if (lines !== undefined && statusOf(exit, lines, check) === 'none') return `<span class="badge none">${escapeHtml(`– lines ${lines} ran`)}</span>`;
  if (check === 'failed') return `<span class="badge fail">${escapeHtml('✗ check failed')}</span>`;
  if (check === 'ok') return `<span class="badge ok">${escapeHtml(`✓ ${/^-?\d+$/.test(exit ?? '') ? `exit ${exit}` : (exit ?? '')}`)}</span>`;
  const st = statusOf(exit);
  const named = exit !== undefined && !/^-?\d+$/.test(exit);
  const text = st === 'none' ? (named ? `– ${exit}` : 'not run') : st === 'ok' ? (named ? `✓ ${exit}` : '✓ exit 0') : st === 'skip' ? '– skipped' : `✗ ${/^-?\d+$/.test(exit!) ? `exit ${exit}` : exit}`;
  return `<span class="badge ${st}">${escapeHtml(text)}</span>`;
}

function firstHeading(markdown: string): string | undefined {
  for (const line of markdown.split('\n')) {
    const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (m?.[1]) return m[1].replace(/[*_`]/g, '');
  }
  return undefined;
}

/** YAML front matter (`---` ... `---` at the very top of the document) and the text after it. */
function splitFrontMatter(value: string): { yaml: string; rest: string } | undefined {
  const lines = value.split('\n');
  if (lines[0]?.replace(/^\uFEFF/, '').trimEnd() !== '---') return undefined;
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
  if (end < 0) return undefined;
  return { yaml: lines.slice(1, end).join('\n'), rest: lines.slice(end + 1).join('\n') };
}

export function renderReport(text: string, opts: ReportOptions): string {
  const doc = parse(text);
  const redact = (s: string): string => (opts.redact ? opts.redact(s) : s);
  let title: string | undefined;
  let rows = '';
  let body = '';
  let step = 0;
  const counts: Record<Status, number> = { ok: 0, fail: 0, skip: 0, none: 0 };

  // os= alternatives are one step: the one that ran (has output) stands for the group, the
  // others are shown as alternatives for another OS.
  const osOf = (i: number) => {
    const meta = doc.cells[i]!.meta;
    return isCodeMeta(meta) ? parseCellOptions(meta.info).os : undefined;
  };
  const slots = osGroups(doc.cells.map((c, i) => (isCodeMeta(c.meta) ? { kind: 'code' as const, os: osOf(i) } : { kind: 'markup' as const })));
  const primary = new Map<number, number>();
  slots.forEach((slot, i) => {
    if (!slot) return;
    const current = primary.get(slot.group);
    if (current === undefined || (!doc.cells[current]!.output && doc.cells[i]!.output)) primary.set(slot.group, i);
  });
  /** Step number of each code cell: the alternatives of a group share one (as the run timeline numbers them). */
  const numbers = stepNumbers(doc.cells.map((c, i) => (isCodeMeta(c.meta) ? { kind: 'code' as const, os: osOf(i) } : { kind: 'markup' as const })));
  const stepOf = new Map<number, number>();
  numbers.forEach((n, i) => n !== undefined && stepOf.set(i, n));
  step = Math.max(0, ...numbers.filter((n): n is number => n !== undefined));

  for (const [index, cell] of doc.cells.entries()) {
    if (!isCodeMeta(cell.meta)) {
      let value = cell.value;
      if (index === 0) {
        const fm = splitFrontMatter(value);
        if (fm) {
          body += `<div class="front-matter">${renderCodeBlock(redact(fm.yaml), 'front matter')}</div>\n`;
          value = fm.rest;
        }
      }
      title ??= firstHeading(value);
      body += renderMarkdown(value, redact);
      continue;
    }
    const slot = slots[index];
    const alternative = slot !== undefined && primary.get(slot.group) !== index;
    const n = stepOf.get(index)!;
    const a = cell.output?.attrs ?? {};
    const st: Status = alternative ? 'skip' : statusOf(a.exit, a.lines, a.check);
    if (!alternative) counts[st]++;
    const mark = alternative ? `<span class="badge skip">${escapeHtml(`– for ${osLabel(osOf(index) ?? [])}`)}</span>` : badge(a.exit, a.lines, a.check);
    const anchor = alternative ? `step-${n}-${index}` : `step-${n}`;
    const shell = cell.meta.lang;
    const code = redact(cell.value);
    const firstLine = code.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    rows +=
      `<tr class="${st}"><td><a href="#${anchor}">${n}</a></td><td><code>${escapeHtml(firstLine)}</code></td>` +
      `<td>${escapeHtml(shell)}</td><td>${mark}</td>` +
      `<td>${escapeHtml(a.ran ?? '')}</td><td>${escapeHtml(a.duration ?? '')}</td></tr>\n`;

    body += `<section class="step ${st}" id="${anchor}">\n<div class="step-head">Step ${n}${alternative ? ' (alternative)' : ''}</div>\n`;
    body += renderCodeBlock(code, shell);
    if (cell.output) {
      const meta = [a.ran && `ran ${a.ran}`, a.duration].filter(Boolean).map((s) => escapeHtml(s as string));
      body +=
        `<div class="output"><div class="output-head">${mark} ${meta.join(' · ')}</div>` +
        `<pre>${escapeHtml(redact(stripAnsi(cell.output.text)))}</pre></div>\n`;
    }
    body += '</section>\n';
  }

  const docTitle = title ?? opts.fallbackTitle ?? 'Runbook report';
  const summary = [`${step} step${step === 1 ? '' : 's'}`, `${counts.ok} passed`, `${counts.fail} failed`];
  if (counts.skip) summary.push(`${counts.skip} skipped`);
  if (counts.none) summary.push(`${counts.none} not run`);
  const record = renderRecord(buildTimeline(text), recordStatus(text), redact);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="md-runbook">
<title>${escapeHtml(docTitle)}</title>
<style>${CSS}${record.pageCss}</style>
</head>
<body>
<header>
<h1 class="title">${renderInline(docTitle)}</h1>
<p class="meta">Generated ${escapeHtml(formatLocalIso(opts.generatedAt))} · ${summary.join(' · ')}</p>
</header>
${record.html}<table class="summary">
<thead><tr><th>#</th><th>Command</th><th>Shell</th><th>Exit</th><th>Ran</th><th>Duration</th></tr></thead>
<tbody>
${rows}</tbody>
</table>
<main>
${body}</main>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--code:#f6f8fa;--ok:#1a7f37;--fail:#cf222e;--skip:#9a6700;--link:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--border:#30363d;--code:#161b22;--ok:#3fb950;--fail:#f85149;--skip:#d29922;--link:#4493f8}}
*{box-sizing:border-box}
body{margin:0 auto;max-width:960px;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:var(--link)}
.meta{color:var(--muted);margin-top:-8px}
h1,h2,h3{border-bottom:1px solid var(--border);padding-bottom:.25em}
h1.title{border:0}
code,pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:not(pre)>code{background:var(--code);padding:.1em .35em;border-radius:4px}
@media print{:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--code:#f6f8fa;--ok:#1a7f37;--fail:#cf222e;--skip:#9a6700;--link:#0969da}body{max-width:none;padding:0;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}tr,.step-head{break-inside:avoid}.step-head{break-after:avoid}}
pre{background:var(--code);border:1px solid var(--border);border-radius:6px;padding:10px 12px;overflow:auto;margin:0;white-space:pre}
.code{position:relative;margin:12px 0}
.lang{position:absolute;top:4px;right:8px;font-size:11px;color:var(--muted)}
table{border-collapse:collapse;margin:12px 0;width:100%}
th,td{border:1px solid var(--border);padding:4px 8px;text-align:left;vertical-align:top}
.summary td:nth-child(2){max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:0 8px;border-radius:10px;border:1px solid currentColor;white-space:nowrap}
.badge.ok{color:var(--ok)}.badge.fail{color:var(--fail)}.badge.skip{color:var(--skip)}.badge.none{color:var(--muted)}
.step{border-left:3px solid var(--border);padding-left:12px;margin:20px 0}
.step.ok{border-color:var(--ok)}.step.fail{border-color:var(--fail)}.step.skip{border-color:var(--skip)}
.step-head{font-weight:600;color:var(--muted);font-size:13px}
.output-head{margin:6px 0 4px;color:var(--muted);font-size:13px}
.output pre{white-space:pre-wrap;word-break:break-word}
li.task{list-style:none}
blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--border)}
.record{margin:16px 0 24px}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px 16px;margin:12px 0}
.facts div{border:1px solid var(--border);border-radius:6px;padding:6px 10px}
.facts dt{font-size:12px;color:var(--muted)}.facts dd{margin:0;font-weight:600}
.facts div.changed{border-color:var(--fail);color:var(--fail)}
.timeline td:first-child{white-space:nowrap;font-variant-numeric:tabular-nums}
.timeline tr.note td{background:var(--code)}
.badge.milestone{color:var(--link)}
.earlier{font-size:12px;color:var(--muted)}
@media print{.facts div,.timeline tr{break-inside:avoid}.timeline tr.note td{background:none}}
`;

/** `2026-10-26T22:05:00+01:00` → `2026-10-26 22:05:00 +01:00`. */
const when = (iso: string): string => iso.replace('T', ' ').replace(/([+-]\d\d:\d\d|Z)$/, ' $1');

/**
 * The run record above the steps, for audit evidence and postmortems: the incident's facts
 * (start, end, time to mitigate and resolve, the RTO, failed attempts, people and places), then
 * every run, attempt, mark and note in time order. Nothing when the runbook has no recorded times.
 * In print, every page says the incident and its page number.
 */
function renderRecord(
  t: Timeline,
  signed: ReturnType<typeof recordStatus>,
  redact: (s: string) => string,
): { html: string; pageCss: string } {
  const s = t.summary;
  if (t.events.length === 0 && !s.incident && !signed) return { html: '', pageCss: '' };
  const facts: [string, string][] = [];
  if (s.incident) facts.push(['Incident', [s.incident, s.severity].filter(Boolean).join(' · ')]);
  if (s.start) facts.push(['Start', when(s.start)]);
  if (s.end) facts.push(['End', when(s.end)]);
  if (s.durationSeconds !== undefined) facts.push(['Duration', formatSeconds(s.durationSeconds)]);
  for (const m of MILESTONES) if (s.milestones[m]) facts.push([m[0]!.toUpperCase() + m.slice(1), when(s.milestones[m])]);
  if (s.timeToMitigateSeconds !== undefined) facts.push(['Time to mitigate', formatSeconds(s.timeToMitigateSeconds)]);
  if (s.timeToResolveSeconds !== undefined) facts.push(['Time to resolve', formatSeconds(s.timeToResolveSeconds)]);
  if (s.rtoSeconds !== undefined)
    facts.push(['RTO', `${formatSeconds(s.rtoSeconds)}${s.rtoMet === undefined ? '' : s.rtoMet ? ' · met' : ' · missed'}`]);
  facts.push(['Runs', `${s.runs}${s.failedAttempts ? ` · ${s.failedAttempts} failed` : ''}`]);
  if (s.people.length) facts.push(['People', s.people.join(', ')]);
  if (s.places.length) facts.push(['Ran on', s.places.join(', ')]);
  // Sign Run Record: who vouched for the record, and whether it changed since (the signature
  // itself is checked against the signers' keys by md-runbook verify).
  if (signed) {
    const by = recordSigners(signed.block).join(', ');
    facts.push(['Record signed', signed.unchanged ? `by ${by} · unchanged since` : `by ${by} · CHANGED since signing`]);
  }
  const factsHtml = facts
    .map(([k, v]) => `<div${k === 'Record signed' && signed && !signed.unchanged ? ' class="changed"' : ''}><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(redact(v))}</dd></div>`)
    .join('');

  const rows = t.events
    .map((e) => {
      const what =
        e.kind === 'note'
          ? `${e.milestone ? `<span class="badge milestone">${escapeHtml(e.milestone)}</span> ` : ''}${escapeHtml(redact(e.text ?? '')).replace(/\n/g, '<br>')}`
          : `<a href="#step-${e.step}">${e.step}</a> <code>${escapeHtml(redact(e.label ?? ''))}</code>${e.earlier ? ' <span class="earlier">earlier attempt</span>' : ''}`;
      const result =
        e.kind === 'note' ? '' : `<span class="badge ${e.ok ? (e.exit === 'skipped' ? 'skip' : 'ok') : 'fail'}">${escapeHtml(e.check === 'failed' ? 'check failed' : e.exit === '0' ? 'exit 0' : /^-?\d+$/.test(e.exit ?? '') ? `exit ${e.exit}` : (e.exit ?? ''))}</span>`;
      return (
        `<tr class="${e.kind}"><td>${escapeHtml(when(e.at))}</td><td>${what}</td><td>${escapeHtml(redact(e.by ?? ''))}</td>` +
        `<td>${escapeHtml(redact(e.on ?? ''))}</td><td>${result}</td><td>${escapeHtml(e.duration ?? '')}</td></tr>\n`
      );
    })
    .join('');
  const html =
    `<section class="record">\n<h2>${s.incident ? 'Incident record' : 'Run record'}</h2>\n<dl class="facts">${factsHtml}</dl>\n` +
    (rows
      ? `<table class="timeline">\n<thead><tr><th>Time</th><th>What</th><th>By</th><th>On</th><th>Result</th><th>Duration</th></tr></thead>\n<tbody>\n${rows}</tbody>\n</table>\n`
      : '') +
    `</section>\n`;
  const label = s.incident ? `${s.incident}${s.severity ? ` · ${s.severity}` : ''}` : '';
  // Chrome prints page margin boxes (the PDF export prints with Chrome or Edge).
  const pageCss = `@page{@bottom-right{content:"Page " counter(page) " of " counter(pages);font:10px sans-serif;color:#656d76}${
    label ? `@top-right{content:${JSON.stringify(label)};font:10px sans-serif;color:#656d76}` : ''
  }}`;
  return { html, pageCss };
}

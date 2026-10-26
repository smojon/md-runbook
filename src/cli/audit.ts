/**
 * `md-runbook audit`: a report of what servers with md-runbook-gate ran, from their logs (core
 * audit.ts), optionally matched against saved run records. HTML, PDF (an installed Chrome, Edge or
 * Chromium) or JSON; a summary on the terminal. Exit code 1 when there are findings (refusals,
 * unsigned code, stopped runs) or a record has runs the log doesn't show, so CI can flag them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Audit, RecordMatch, buildAudit, filterAudit, matchRecord, parseGateLog, renderAuditReport } from '@md-runbook/core/audit';
import { findBrowser, htmlToPdf } from './pdf';

export const AUDIT_USAGE = `Usage: md-runbook audit <gate log>... [options]

Reads md-runbook-gate's log (its log file, or syslog: journalctl -t md-runbook-gate -o cat, or
/var/log/syslog lines with the tag) and reports every run of a signed runbook: when, the key
(its fingerprint, or the gate's --who name), the account and client, the runbook, version and
signer, the block, the parameter values, the exit code and duration; and the findings: refused
requests, unsigned code (where allowed) and stopped runs. "-" reads standard input.

  --record FILE.md     A saved run record (the runbook with its outputs, e.g. an incident's
                       copy) to match: each recorded run of a signed block the log confirms, and
                       the ones it doesn't show (repeatable)
  --since DATE         Only from this time on (2026-10-26, or 2026-10-26T22:00:00Z)
  --until DATE         Only up to this time
  --runbook NAME       Only this runbook (its signed name, e.g. ops/restart-api)
  --who KEY            Only this key (its fingerprint or --who name, as the log has it)
  --out FILE           .html (default: gate-audit.html), .pdf or .json
  --browser PATH       Browser for a .pdf (default: CHROME_PATH, else one found on this machine)

Exit code 0: nothing to flag; 1: findings, or recorded runs the log doesn't show; 2: usage.
`;

class AuditUsageError extends Error {}
type Out = (line: string) => void;
const stdout: Out = (l) => void process.stdout.write(l + '\n');

export interface AuditArgs {
  logs: string[];
  records: string[];
  since?: Date;
  until?: Date;
  runbook?: string;
  who?: string;
  out: string;
  browser?: string;
}

function date(flag: string, v: string): Date {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw new AuditUsageError(`${flag} expects a date or time, got "${v}"`);
  return d;
}

export function parseAuditArgs(argv: readonly string[]): AuditArgs {
  const args = [...argv];
  const a: AuditArgs = { logs: [], records: [], out: 'gate-audit.html' };
  const value = (flag: string): string => {
    const v = args.shift();
    if (v === undefined || v.startsWith('--')) throw new AuditUsageError(`${flag} needs a value`);
    return v;
  };
  while (args.length > 0) {
    const x = args.shift()!;
    switch (x) {
      case '--record': a.records.push(value(x)); break;
      case '--since': a.since = date(x, value(x)); break;
      case '--until': a.until = date(x, value(x)); break;
      case '--runbook': a.runbook = value(x); break;
      case '--who': a.who = value(x); break;
      case '--out': a.out = value(x); break;
      case '--browser': a.browser = value(x); break;
      default:
        if (x.startsWith('--')) throw new AuditUsageError(`unknown option ${x}`);
        a.logs.push(x);
    }
  }
  if (a.logs.length === 0) throw new AuditUsageError('missing the gate log (a file, or - for standard input)');
  if (!/\.(html?|pdf|json)$/i.test(a.out)) throw new AuditUsageError('--out must end in .html, .pdf or .json');
  return a;
}

export async function auditCommand(argv: readonly string[], out: Out = stdout, readStdin = (): string => fs.readFileSync(0, 'utf8')): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) return void process.stdout.write(AUDIT_USAGE), 0;
  let a: AuditArgs;
  try {
    a = parseAuditArgs(argv);
  } catch (e) {
    if (!(e instanceof AuditUsageError)) throw e;
    process.stderr.write(`md-runbook: ${e.message}\n\n${AUDIT_USAGE}`);
    return 2;
  }
  for (const f of [...a.logs.filter((l) => l !== '-'), ...a.records]) {
    if (!fs.existsSync(f)) {
      process.stderr.write(`md-runbook: no such file: ${f}\n`);
      return 2;
    }
  }
  let skipped = 0;
  const events = a.logs.flatMap((f) => {
    const r = parseGateLog(f === '-' ? readStdin() : fs.readFileSync(f, 'utf8'));
    skipped += r.skipped;
    return r.events;
  });
  const audit: Audit = filterAudit(buildAudit(events, skipped), a);
  const matches: RecordMatch[] = a.records.map((f) => matchRecord(audit, path.basename(f), fs.readFileSync(f, 'utf8')));

  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  if (/\.json$/i.test(a.out)) {
    fs.writeFileSync(a.out, JSON.stringify({ format: 'md-runbook gate audit v1', sources: a.logs, ...audit, records: matches }, null, 2) + '\n', 'utf8');
  } else {
    const html = renderAuditReport(audit, matches, { generatedAt: new Date(), sources: a.logs.map((l) => (l === '-' ? 'standard input' : path.basename(l))) });
    if (/\.pdf$/i.test(a.out)) {
      const browser = findBrowser(a.browser ?? process.env.CHROME_PATH);
      if (!browser) {
        process.stderr.write('md-runbook: a .pdf needs Chrome, Edge or Chromium; none was found (use --browser PATH or CHROME_PATH), or write .html\n');
        return 2;
      }
      await htmlToPdf(html, a.out, browser);
    } else fs.writeFileSync(a.out, html, 'utf8');
  }

  const failed = audit.runs.filter((r) => r.exit !== undefined && r.exit !== 0).length;
  const missing = matches.reduce((n, m) => n + m.missing.length, 0);
  out(`${audit.runs.length} run${audit.runs.length === 1 ? '' : 's'} in ${audit.sessions} session${audit.sessions === 1 ? '' : 's'}, ${failed} failed, ${audit.findings.length} finding${audit.findings.length === 1 ? '' : 's'}`);
  for (const f of audit.findings) out(`  ${f.time} ${f.kind}: ${f.who} (${f.account} from ${f.client}): ${f.detail}`);
  for (const m of matches) {
    out(`  ${m.file}: ${m.confirmed.length} recorded run${m.confirmed.length === 1 ? '' : 's'} confirmed by the log${m.missing.length ? `, ${m.missing.length} not in it (steps ${m.missing.map((x) => x.step).join(', ')})` : ''}`);
  }
  const flagged = audit.findings.length > 0 || missing > 0;
  out(`${flagged ? '✗' : '✓'} ${a.out}`);
  return flagged ? 1 : 0;
}

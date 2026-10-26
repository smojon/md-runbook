/**
 * `md-runbook qr`: QR codes of runbook links (core/runbookLink.ts) for labels on machines. One
 * code as SVG, or with `--labels hosts.csv` a printable sheet with one code per machine (HTML, or
 * PDF through an installed Chrome, Edge or Chromium). The app's Scan a code opens them.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clearOutputBlocks } from '@md-runbook/core';
import { QrLabel, parseCsv, qrLabelSheet, qrMatrix, qrSvg } from '@md-runbook/core/qr';
import { APP_LINK_BASE, RunbookLink, formatRunbookLink, parseRunbookLink, runbookDigest } from '@md-runbook/core/runbookLink';
import { VAR_NAME_RE } from '@md-runbook/core/secrets';
import { fileWebUrl } from '../appLink';
import { findBrowser, htmlToPdf } from './pdf';

export const QR_USAGE = `Usage: md-runbook qr <file.md> [options]
       md-runbook link <file.md> [options]       (prints the link: a pager alert, a chat)
       md-runbook qr <file.md> --labels hosts.csv [options]

Makes a QR code that opens the runbook in the md-runbook app (Scan a code). It carries the
runbook's address, or the runbook itself; nothing runs from a code, and only a signed runbook
says who approved it.

  --embed              Put the runbook itself in the code, without outputs: no network needed
                       (a code holds about 2 KB). Default: its address
  --url URL            The runbook's https address. Default: its file on GitHub or GitLab, from
                       the Git remote, pinned (sha256=) to the pushed file
  --pin                With --url: pin the address to this file's content
  --host NAME          The host in the app to run on
  --param NAME=VALUE   A parameter value (repeatable)
  --cosign             Open on Co-sign Runbook
  --web-app URL        Make https links on the web app (https://…/open) instead of mdrunbook://
  --labels FILE.csv    One label per row: column host (the app's host name), optional label
                       (printed under it) and p.NAME columns (parameter values)
  --out FILE           .svg (one code), .html or .pdf (labels). Default: next to the runbook
  --browser PATH       Browser for a .pdf (default: CHROME_PATH, else one found on this machine)
  --link               Print the link too
`;

class QrUsageError extends Error {}
type Out = (line: string) => void;
const stdout: Out = (l) => void process.stdout.write(l + '\n');

export interface QrArgs {
  file: string;
  embed: boolean;
  url?: string;
  pin: boolean;
  host?: string;
  params: Record<string, string>;
  cosign: boolean;
  webApp?: string;
  labels?: string;
  out?: string;
  browser?: string;
  printLink: boolean;
}

export function parseQrArgs(argv: readonly string[]): QrArgs {
  const args = [...argv];
  const a: QrArgs = { file: '', embed: false, pin: false, params: {}, cosign: false, printLink: false };
  const value = (flag: string): string => {
    const v = args.shift();
    if (v === undefined || v.startsWith('--')) throw new QrUsageError(`${flag} needs a value`);
    return v;
  };
  while (args.length > 0) {
    const x = args.shift()!;
    switch (x) {
      case '--embed': a.embed = true; break;
      case '--url': a.url = value(x); break;
      case '--pin': a.pin = true; break;
      case '--host': a.host = value(x); break;
      case '--param': {
        const v = value(x);
        const eq = v.indexOf('=');
        if (eq <= 0 || !VAR_NAME_RE.test(v.slice(0, eq))) throw new QrUsageError(`--param expects NAME=VALUE, got "${v}"`);
        a.params[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
      case '--cosign': a.cosign = true; break;
      case '--web-app': a.webApp = value(x); break;
      case '--labels': a.labels = value(x); break;
      case '--out': a.out = value(x); break;
      case '--browser': a.browser = value(x); break;
      case '--link': a.printLink = true; break;
      default:
        if (x.startsWith('-')) throw new QrUsageError(`unknown option ${x}`);
        if (a.file) throw new QrUsageError(`one runbook at a time (got ${a.file} and ${x})`);
        a.file = x;
    }
  }
  if (!a.file) throw new QrUsageError('missing the runbook file');
  if (a.embed && a.url) throw new QrUsageError('--embed and --url: choose one');
  if (a.pin && !a.url) throw new QrUsageError('--pin goes with --url (the Git address is pinned anyway)');
  if (a.webApp && !/^https:\/\/[^/]+\/(?:.*\/)?open$/.test(a.webApp)) throw new QrUsageError('--web-app expects https://<web app>/open');
  return a;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });

/** The file on GitHub or GitLab and the pin of its pushed version, as Open in the App makes them. */
function pushedFile(file: string): { web: string; sha256?: string } | string {
  const dir = path.dirname(path.resolve(file));
  let root: string;
  let remote: string;
  let branch: string;
  try {
    root = git(dir, ['rev-parse', '--show-toplevel']).trim();
    remote = git(dir, ['remote', 'get-url', 'origin']).trim();
    branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    return 'not in a Git repository with a remote: use --embed, or --url';
  }
  const rel = path.relative(root, path.resolve(file)).split(path.sep).join('/');
  const web = fileWebUrl(remote, branch, rel);
  if (!web) return `the app opens GitHub and GitLab addresses; this repository's remote is ${remote}: use --embed, or --url`;
  try {
    // The blob, as the phone downloads it (a CRLF checkout would not match).
    return { web, sha256: runbookDigest(git(root, ['show', `origin/${branch}:${rel}`])) };
  } catch {
    return { web };
  }
}

/**
 * `md-runbook qr`, or with `linkOnly` `md-runbook link`: the same link printed instead of a code (a
 * pager alert's runbook field, a chat message, a template); with --labels one `host<TAB>link` line
 * per row.
 */
export async function qrCommand(argv: readonly string[], out: Out = stdout, linkOnly = false): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) return void process.stdout.write(QR_USAGE), 0;
  let a: QrArgs;
  try {
    a = parseQrArgs(argv);
  } catch (e) {
    if (!(e instanceof QrUsageError)) throw e;
    process.stderr.write(`md-runbook: ${e.message}\n\n${QR_USAGE}`);
    return 2;
  }
  if (!fs.existsSync(a.file)) {
    process.stderr.write(`md-runbook: no such file: ${a.file}\n`);
    return 2;
  }
  const text = fs.readFileSync(a.file, 'utf8');
  const base: RunbookLink = { params: { ...a.params }, ...(a.cosign ? { action: 'cosign' as const } : {}) };
  if (a.embed) base.text = clearOutputBlocks(text);
  else if (a.url) {
    base.url = a.url;
    if (a.pin) base.sha256 = runbookDigest(text);
  } else {
    const pushed = pushedFile(a.file);
    if (typeof pushed === 'string') {
      process.stderr.write(`md-runbook: ${pushed}\n`);
      return 2;
    }
    base.url = pushed.web;
    if (pushed.sha256) base.sha256 = pushed.sha256;
    // On stderr: `md-runbook link` prints into configs and templates.
    else process.stderr.write('md-runbook: the file is not pushed yet (no origin version): the link is not pinned\n');
  }
  const linkOf = (l: RunbookLink): string => formatRunbookLink(l, a.webApp ?? APP_LINK_BASE);
  // What the app will read: refuse anything it would refuse (a bad host name, an http address).
  const check = (link: string): string | undefined => {
    const r = parseRunbookLink(link);
    return r.ok ? undefined : r.problem;
  };
  const name = path.basename(a.file).replace(/\.md$/i, '');
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name;

  if (!a.labels) {
    if (a.host) base.host = a.host;
    const link = linkOf(base);
    const problem = check(link);
    if (problem) {
      process.stderr.write(`md-runbook: the app would refuse this link (${problem})\n`);
      return 2;
    }
    if (linkOnly) return out(link), 0;
    const m = qrMatrix(link);
    if (!m) {
      process.stderr.write(`md-runbook: too much for a QR code (${Buffer.byteLength(link)} bytes; 2953 at most): use its address instead of --embed\n`);
      return 1;
    }
    const target = a.out ?? path.join(path.dirname(a.file), `${name}.qr.svg`);
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, qrSvg(m, { scale: 8, caption: a.host ?? title }) + '\n', 'utf8');
    if (a.printLink) out(link);
    out(`✓ ${target}: QR code (${m.size}×${m.size}, level ${m.level}) for ${a.host ? `${title} on ${a.host}` : title}`);
    return 0;
  }

  if (a.host) {
    process.stderr.write('md-runbook: --host and --labels: the hosts come from the CSV\n');
    return 2;
  }
  const rows = parseCsv(fs.readFileSync(a.labels, 'utf8'));
  if (rows.length === 0 || !('host' in rows[0]!)) {
    process.stderr.write(`md-runbook: ${a.labels}: expected a header row with a host column (and optional label, p.NAME columns)\n`);
    return 2;
  }
  const labels: QrLabel[] = [];
  for (const [i, row] of rows.entries()) {
    const params = { ...base.params };
    for (const [k, v] of Object.entries(row)) if (k.startsWith('p.') && v !== '') params[k.slice(2)] = v;
    const link = linkOf({ ...base, ...(row.host ? { host: row.host } : {}), params });
    const problem = check(link);
    if (problem) {
      process.stderr.write(`md-runbook: ${a.labels} row ${i + 2}: the app would refuse its link (${problem})\n`);
      return 2;
    }
    if (linkOnly) out(`${row.host}\t${link}`);
    else if (a.printLink) out(link);
    labels.push({ link, title: row.host || title, subtitle: row.label || (row.host ? title : undefined) });
  }
  if (linkOnly) return 0;
  const { html, tooLong } = qrLabelSheet(title, labels);
  if (tooLong.length > 0) {
    process.stderr.write(`md-runbook: too much for a QR code: ${tooLong.join(', ')} (use its address instead of --embed)\n`);
    return 1;
  }
  const target = a.out ?? path.join(path.dirname(a.file), `${name}.labels.html`);
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  if (/\.pdf$/i.test(target)) {
    const browser = findBrowser(a.browser ?? process.env.CHROME_PATH);
    if (!browser) {
      process.stderr.write('md-runbook: a .pdf needs Chrome, Edge or Chromium; none was found (use --browser PATH or CHROME_PATH), or write .html\n');
      return 1;
    }
    await htmlToPdf(html, target, browser);
  } else fs.writeFileSync(target, html, 'utf8');
  out(`✓ ${target}: ${labels.length} label${labels.length === 1 ? '' : 's'}`);
  return 0;
}

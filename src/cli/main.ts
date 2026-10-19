/**
 * `md-runbook run <file.md>`: run a runbook outside VS Code and write its outputs into the file.
 * Exit code 0 when every step passed (or was skipped), 1 when a step failed or could not run,
 * 2 for a usage error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderReport } from '@md-runbook/core';
import { formatProblem, lintRunbook } from '@md-runbook/core/lint';
import { CliOptions, junitReport, markdownSummary, runRunbook } from './run';
import { notifyConfig, notifyText, runLink, sendNotification } from './notify';
import { findBrowser, htmlToPdf } from './pdf';

declare const MD_RUNBOOK_VERSION: string | undefined;

const USAGE = `Usage: md-runbook run <file.md> [options]
       md-runbook lint <file.md>... [--strict]

Runs the bash, pwsh/powershell and cmd blocks of a Markdown runbook in order and writes their
output into the file, as the VS Code extension does. Stops at the first failed step.

Options:
  --check              Run, but don't write the outputs into the file
  --out FILE           Write the runbook with its outputs to FILE instead
  --report FILE.html   Also write the HTML report
  --pdf FILE.pdf       Also write the report as PDF (needs Chrome, Edge or Chromium)
  --browser PATH       Browser for --pdf (default: CHROME_PATH, else one found on this machine)
  --junit FILE.xml     Also write a JUnit report (one test case per step)
  --json FILE.json     Also write the step results as JSON (status, exit, message, output)
  --param NAME=VALUE   Value for \${param:NAME} (repeatable; default: the front matter's)
  --input NAME=VALUE   Value for \${input:NAME} (repeatable; default: environment variable NAME)
  --yes                Run blocks that ask for confirmation in VS Code (risky commands, confirm)
  --keep-going         Carry on after a failed step
  --session            Run all blocks of a shell in one process (like session mode)
  --isolated           One process per block, even with "mode: session" in the front matter
  --timeout SECONDS    Default timeout per block (the front matter and timeout= win)
  --bash PATH          bash to use (e.g. Git Bash on Windows)
  --pwsh PATH          PowerShell to use
  --notify URL         Post a summary to a chat webhook (Slack, Teams Workflows, Discord, Google
                       Chat); better: the environment variable MD_RUNBOOK_NOTIFY_URL
  --notify-on WHEN     failure (default) or always; or MD_RUNBOOK_NOTIFY_ON
  --quiet              Only print the summary
  -h, --help           Show this help
  --version            Show the version

lint checks runbooks without running them (invalid or unknown cell options, \${out:NAME}
without an earlier capture=NAME, undeclared \${param:NAME}, ignored front matter values) and
exits with 1 when it finds an error (with --strict: also a warning).

\${secret:NAME} values come from the environment variable NAME and are redacted from output.
On GitHub Actions, a summary table is added to the job summary.
`;

class UsageError extends Error {}

/** Write a file, creating its folder first (e.g. a fresh CI temp folder). */
function writeFile(file: string, data: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, data, 'utf8');
}

export interface ParsedArgs {
  options: Omit<CliOptions, 'env' | 'signal'>;
  pdf?: string;
  browser?: string;
  notify?: string;
  notifyOn?: string;
  quiet: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs | 'help' | 'version' {
  const args = [...argv];
  // Only as the first argument: a value such as a parameter `-h` must not turn a run into help.
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') return 'help';
  if (args[0] === '--version') return 'version';
  if (args[0] !== 'run') throw new UsageError(`unknown command "${args[0]}" (expected "run" or "lint")`);
  args.shift();
  const o: ParsedArgs['options'] = { file: '', write: true, params: {}, inputs: {}, yes: false, keepGoing: false, shell: {} };
  let pdf: string | undefined;
  let browser: string | undefined;
  let notify: string | undefined;
  let notifyOn: string | undefined;
  let quiet = false;
  const value = (flag: string): string => {
    const v = args.shift();
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  const pair = (flag: string, into: Record<string, string>): void => {
    const v = value(flag);
    const eq = v.indexOf('=');
    if (eq <= 0) throw new UsageError(`${flag} expects NAME=VALUE, got "${v}"`);
    into[v.slice(0, eq)] = v.slice(eq + 1);
  };
  while (args.length > 0) {
    const a = args.shift()!;
    switch (a) {
      case '--check': o.write = false; break;
      case '--out': o.out = value(a); break;
      case '--report': o.report = value(a); break;
      case '--pdf': pdf = value(a); break;
      case '--browser': browser = value(a); break;
      case '--notify': notify = value(a); break;
      case '--notify-on': notifyOn = value(a); break;
      case '--junit': o.junit = value(a); break;
      case '--json': o.json = value(a); break;
      case '--param': pair(a, o.params); break;
      case '--input': pair(a, o.inputs); break;
      case '--yes': o.yes = true; break;
      case '--keep-going': o.keepGoing = true; break;
      case '--session': o.session = true; break;
      case '--isolated': o.session = false; break;
      case '--timeout': {
        const s = Number(value(a));
        if (!Number.isFinite(s) || s < 0) throw new UsageError('--timeout expects seconds (0 = none)');
        o.timeoutSeconds = s;
        break;
      }
      case '--bash': o.shell.bashPath = value(a); break;
      case '--pwsh': o.shell.pwshPath = value(a); break;
      case '--quiet': quiet = true; break;
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
        if (o.file) throw new UsageError(`only one runbook per run (got "${o.file}" and "${a}")`);
        o.file = a;
    }
  }
  if (!o.file) throw new UsageError('missing the runbook file');
  return { options: o, ...(pdf ? { pdf } : {}), ...(browser ? { browser } : {}), ...(notify ? { notify } : {}), ...(notifyOn ? { notifyOn } : {}), quiet };
}

/** `md-runbook lint`: print the problems of each file; 1 if any is an error (or, strict, a warning). */
export function lint(argv: readonly string[], out: (line: string) => void = (l) => void process.stdout.write(l + '\n')): number {
  const strict = argv.includes('--strict');
  const files = argv.filter((a) => a !== '--strict');
  const unknown = files.find((f) => f.startsWith('-'));
  if (unknown || files.length === 0) {
    process.stderr.write(`md-runbook: ${unknown ? `unknown option ${unknown}` : 'missing the runbook file(s)'}\n\n${USAGE}`);
    return 2;
  }
  // On GitHub Actions, also annotations: they show on the file in pull requests.
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  let failed = false;
  let count = 0;
  for (const file of files) {
    if (!fs.existsSync(file)) {
      out(`${file}: error: no such file`);
      failed = true;
      continue;
    }
    for (const p of lintRunbook(fs.readFileSync(file, 'utf8'))) {
      count++;
      out(formatProblem(file, p));
      if (annotate) out(`::${p.severity} file=${file},line=${p.line + 1}::${p.message.replace(/\r?\n/g, ' ')}`);
      if (p.severity === 'error' || strict) failed = true;
    }
  }
  out(`${failed ? '✗' : '✓'} ${files.length} runbook${files.length === 1 ? '' : 's'} checked, ${count} problem${count === 1 ? '' : 's'}`);
  return failed ? 1 : 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'lint') return lint(argv.slice(1));
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`md-runbook: ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed === 'help') return void process.stdout.write(USAGE), 0;
  if (parsed === 'version') return void process.stdout.write(`${typeof MD_RUNBOOK_VERSION === 'string' ? MD_RUNBOOK_VERSION : 'dev'}\n`), 0;

  const { options, quiet } = parsed;
  if (!fs.existsSync(options.file)) {
    process.stderr.write(`md-runbook: no such file: ${options.file}\n`);
    return 2;
  }
  // Checked before the run, so a typo doesn't surface only after a long runbook.
  const notify = notifyConfig(parsed.notify ?? process.env.MD_RUNBOOK_NOTIFY_URL, parsed.notifyOn ?? process.env.MD_RUNBOOK_NOTIFY_ON);
  if (typeof notify === 'string') {
    process.stderr.write(`md-runbook: ${notify}\n`);
    return 2;
  }
  // The cells don't need the webhook: keep it out of their environment, and redact it.
  delete process.env.MD_RUNBOOK_NOTIFY_URL;
  const send = async (text: string): Promise<void> => {
    if (!notify) return;
    try {
      await sendNotification(notify.url, text);
    } catch (e) {
      // A failed notification doesn't change the result of the run.
      process.stderr.write(`md-runbook: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };
  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let summary: Awaited<ReturnType<typeof runRunbook>>;
  try {
    summary = await runRunbook(
      { ...options, env: process.env, signal: abort.signal, ...(notify ? { extraSecrets: [notify.url] } : {}) },
      { out: (t) => void (quiet || process.stdout.write(t)), log: (l) => void (quiet || process.stdout.write(l + '\n')) },
    );
  } catch (e) {
    // A run that breaks still raises the alarm.
    await send(`✗ ${path.basename(options.file)}: the run stopped with an error${runLink(process.env) ? `\n${runLink(process.env)}` : ''}`);
    throw e;
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  const file = path.basename(options.file);
  const target = options.out ?? options.file;
  if (options.write) writeFile(target, summary.text);
  const html = (): string => renderReport(summary.text, { generatedAt: new Date(), fallbackTitle: file, redact: summary.redact });
  if (options.report) writeFile(options.report, html());
  if (options.junit) writeFile(options.junit, junitReport(file, summary.steps));
  if (options.json) writeFile(options.json, JSON.stringify({ file, ok: summary.ok, steps: summary.steps }, null, 2) + '\n');
  const ghSummary = process.env.GITHUB_STEP_SUMMARY;
  if (ghSummary) fs.appendFileSync(ghSummary, markdownSummary(file, summary.steps) + '\n');
  let pdfFailed = false;
  if (parsed.pdf) {
    const browser = findBrowser(parsed.browser ?? process.env.CHROME_PATH);
    if (!browser) {
      process.stderr.write('md-runbook: --pdf needs Chrome, Edge or Chromium; none was found (use --browser PATH or CHROME_PATH)\n');
      pdfFailed = true;
    } else {
      try {
        fs.mkdirSync(path.dirname(path.resolve(parsed.pdf)), { recursive: true });
        await htmlToPdf(html(), parsed.pdf, browser);
      } catch (e) {
        process.stderr.write(`md-runbook: PDF export failed: ${e instanceof Error ? e.message : String(e)}\n`);
        pdfFailed = true;
      }
    }
  }

  if (notify && (notify.on === 'always' || !summary.ok)) await send(notifyText(file, summary, runLink(process.env)));

  const count = (s: string): number => summary.steps.filter((x) => x.status === s).length;
  const parts = [`${count('passed')} passed`, `${count('failed')} failed`];
  if (count('skipped')) parts.push(`${count('skipped')} skipped`);
  if (count('not run')) parts.push(`${count('not run')} not run`);
  process.stdout.write(
    `\n${summary.ok ? '✓' : '✗'} ${file}: ${summary.steps.length} step${summary.steps.length === 1 ? '' : 's'}, ${parts.join(', ')}` +
      `${options.write ? ` · outputs written to ${target}` : ''}\n`,
  );
  return summary.ok && !pdfFailed ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e: unknown) => {
      process.stderr.write(`md-runbook: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

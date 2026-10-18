/**
 * `md-runbook run <file.md>`: run a runbook outside VS Code and write its outputs into the file.
 * Exit code 0 when every step passed (or was skipped), 1 when a step failed or could not run,
 * 2 for a usage error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderReport } from '../core';
import { CliOptions, junitReport, markdownSummary, runRunbook } from './run';
import { findBrowser, htmlToPdf } from './pdf';

declare const MD_RUNBOOK_VERSION: string | undefined;

const USAGE = `Usage: md-runbook run <file.md> [options]

Runs the bash, pwsh/powershell and cmd blocks of a Markdown runbook in order and writes their
output into the file, as the VS Code extension does. Stops at the first failed step.

Options:
  --check              Run, but don't write the outputs into the file
  --out FILE           Write the runbook with its outputs to FILE instead
  --report FILE.html   Also write the HTML report
  --pdf FILE.pdf       Also write the report as PDF (needs Chrome, Edge or Chromium)
  --browser PATH       Browser for --pdf (default: CHROME_PATH, else one found on this machine)
  --junit FILE.xml     Also write a JUnit report (one test case per step)
  --param NAME=VALUE   Value for \${param:NAME} (repeatable; default: the front matter's)
  --input NAME=VALUE   Value for \${input:NAME} (repeatable; default: environment variable NAME)
  --yes                Run blocks that ask for confirmation in VS Code (risky commands, confirm)
  --keep-going         Carry on after a failed step
  --session            Run all blocks of a shell in one process (like session mode)
  --isolated           One process per block, even with "mode: session" in the front matter
  --timeout SECONDS    Default timeout per block (the front matter and timeout= win)
  --bash PATH          bash to use (e.g. Git Bash on Windows)
  --pwsh PATH          PowerShell to use
  --quiet              Only print the summary
  -h, --help           Show this help
  --version            Show the version

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
  quiet: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs | 'help' | 'version' {
  const args = [...argv];
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) return 'help';
  if (args.includes('--version')) return 'version';
  if (args[0] !== 'run') throw new UsageError(`unknown command "${args[0]}" (expected "run")`);
  args.shift();
  const o: ParsedArgs['options'] = { file: '', write: true, params: {}, inputs: {}, yes: false, keepGoing: false, shell: {} };
  let pdf: string | undefined;
  let browser: string | undefined;
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
      case '--junit': o.junit = value(a); break;
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
  return { options: o, ...(pdf ? { pdf } : {}), ...(browser ? { browser } : {}), quiet };
}

export async function main(argv: readonly string[]): Promise<number> {
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
  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const summary = await runRunbook(
    { ...options, env: process.env, signal: abort.signal },
    { out: (t) => void (quiet || process.stdout.write(t)), log: (l) => void (quiet || process.stdout.write(l + '\n')) },
  );
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);

  const file = path.basename(options.file);
  const target = options.out ?? options.file;
  if (options.write) writeFile(target, summary.text);
  const html = (): string => renderReport(summary.text, { generatedAt: new Date(), fallbackTitle: file });
  if (options.report) writeFile(options.report, html());
  if (options.junit) writeFile(options.junit, junitReport(file, summary.steps));
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

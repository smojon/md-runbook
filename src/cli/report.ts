/**
 * Run reports from the command line (core/runReport.ts, docs/features/run-reports.md). The command
 * line asks nothing: a runbook's `report-runs:` address gets the run summary only when it is
 * allowed with `--report-to-allowed ADDRESS` (or MD_RUNBOOK_REPORT_ALLOWED, comma-separated).
 * A runbook signed as a whole by a signer of `--allowed-signers FILE` may require the report (it
 * then doesn't run unless the address is allowed: exit 2) and require it signed (`--key KEY`). The
 * summary is signed whenever `--key` is given. Sending is tried 3 times; a required report that
 * could not be sent makes the exit code 3 (the run itself passed), any other failure is a warning.
 *
 * `md-runbook verify-run ENVELOPE.json --allowed-runners FILE`: check a signed summary as a server
 * would, print its runner and the summary; exit 0 when good.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { ReportPlan, RunStepState, addressAllowed, buildRunSummary, postRunReport, reportBody, reportPlan, REPORTED_FIELDS, SEPARATED_REQUIRED_TEXT } from '@md-runbook/core/runReport';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { signRunSummary, trustedRunbookSigner, verifyRunEnvelope } from '@md-runbook/core/node';
import type { ManualStep } from './select';
import type { StepResult } from './run';

export interface CliReportOptions {
  /** --report-to-allowed and MD_RUNBOOK_REPORT_ALLOWED: addresses the summary may go to. */
  allowed: string[];
  /** --key: the runner's SSH key, to sign the summary (namespace md-runbook-run). */
  key?: string;
  /** --allowed-signers: the signers whose runbook signatures count (else nothing can be required). */
  allowedSigners?: string;
}

export interface PreparedReport {
  plan: ReportPlan;
  signer?: string;
  /** Whether the summary goes out (the address is allowed). */
  send: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The addresses allowed by --report-to-allowed (repeatable, comma-separated) and the environment. */
export function allowedAddresses(flags: readonly string[], env: NodeJS.ProcessEnv): string[] {
  return [...flags, env.MD_RUNBOOK_REPORT_ALLOWED ?? ''].flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');
}

/**
 * Before the run: where the summary goes, and whether the run may start (a string: why not, for
 * exit 2). Undefined when the runbook names no address.
 */
export async function prepareReport(text: string, o: CliReportOptions, log: (line: string) => void): Promise<PreparedReport | string | undefined> {
  if (!parseFrontMatter(text)?.reportRuns) return undefined;
  const signer = o.allowedSigners ? await trustedRunbookSigner(text, o.allowedSigners) : undefined;
  const plan = reportPlan(text, signer);
  if (!plan) return undefined;
  const send = addressAllowed(plan.url, o.allowed);
  if (plan.required && !send) {
    return `this signed runbook runs only if its run is reported to ${plan.host} (${REPORTED_FIELDS}) Allow it with --report-to-allowed ${plan.host}.${plan.separated ? ` ${SEPARATED_REQUIRED_TEXT}` : ''}`;
  }
  if (plan.signed && !o.key) {
    return `this signed runbook runs only if its run summary is signed with your SSH key: add --key KEY (a key file, or a .pub whose key is in the agent), and give your server's allowed runners file its line (namespace md-runbook-run).`;
  }
  if (!send) log(`ℹ the runbook reports its runs to ${plan.host}: not sent (allow it with --report-to-allowed ${plan.host})`);
  else if (plan.ignored && (parseFrontMatter(text)?.reportRunsRequired || parseFrontMatter(text)?.reportRunsSigned)) log(`ℹ report-runs-required/-signed ignored: ${plan.ignored}`);
  else if (plan.separated) log(`ℹ report-runs-required: separated: ${SEPARATED_REQUIRED_TEXT}`);
  return { plan, ...(signer ? { signer } : {}), send };
}

function userName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

const STATE: Record<StepResult['status'], RunStepState> = { passed: 'passed', failed: 'failed', skipped: 'skipped', 'not run': 'not-run' };

/** The summary's steps: the blocks and the checklist items, in the runbook's order. */
export function summarySteps(steps: readonly StepResult[], manual: readonly ManualStep[]): { label: string; state: RunStepState; ms?: number; ran?: boolean }[] {
  const all = [
    ...steps.map((s) => {
      const ran = s.status === 'passed' || s.status === 'failed';
      return { at: s.line - 1, label: s.title, state: STATE[s.status], ...(ran ? { ms: s.durationMs, ran } : {}) };
    }),
    ...manual.map((m) => ({ at: m.line, label: m.text, state: (m.ticked ? 'by-hand' : 'not-run') as RunStepState })),
  ];
  return all.sort((a, b) => a.at - b.at).map(({ at: _at, ...s }) => s);
}

/**
 * After the run: build, sign (with --key) and send the summary, tried 3 times. True when sent (or
 * nothing to send), false when it could not be.
 */
export async function sendCliReport(
  r: PreparedReport,
  run: { file: string; text: string; started: number; ended: number; steps: readonly StepResult[]; manual: readonly ManualStep[]; params: Readonly<Record<string, string>> },
  o: CliReportOptions,
  env: NodeJS.ProcessEnv,
  warn: (line: string) => void,
  waits: readonly number[] = [1000, 3000],
): Promise<boolean> {
  if (!r.send) return true;
  const summary = buildRunSummary({
    file: run.file,
    text: run.text,
    who: userName(),
    client: 'cli',
    started: run.started,
    ended: run.ended,
    steps: summarySteps(run.steps, run.manual),
    ...(r.signer ? { trustedSigner: r.signer } : {}),
    alertParams: run.params,
  });
  let body: string;
  try {
    body = o.key ? reportBody(summary, { signature: await signRunSummary(summary, o.key) }) : reportBody(summary);
  } catch (e) {
    warn(`run report to ${r.plan.host}: signing failed: ${e instanceof Error ? e.message : String(e)}`);
    if (r.plan.signed) return false;
    body = reportBody(summary);
  }
  const token = r.plan.token ? env[r.plan.token] : undefined;
  if (r.plan.token && token === undefined) {
    warn(`run report to ${r.plan.host}: not sent: the environment variable ${r.plan.token} (report-runs-token) is not set`);
    return false;
  }
  let why = '';
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    if (attempt > 0) await sleep(waits[attempt - 1]!);
    const outcome = await postRunReport({ url: r.plan.url, body, ...(token ? { token } : {}) });
    if (outcome.ok) return true;
    why = outcome.why;
    if (!outcome.retry) break;
  }
  warn(`run report to ${r.plan.host}: not sent (${why})`);
  return false;
}

export const VERIFY_RUN_USAGE = `Usage: md-runbook verify-run <envelope.json> --allowed-runners FILE

Checks a signed run summary as a server would: the signature (namespace md-runbook-run) is good
by a key in FILE (OpenSSH allowed_signers format, e.g.
  ana@example.net namespaces="md-runbook-run" ssh-ed25519 AAAA…)
and covers the summary as it is. Prints the runner and the summary; exit 0 when good, 1 when not,
2 for a usage error. "-" reads the envelope from standard input.
`;

/** `md-runbook verify-run`. */
export async function verifyRunCommand(argv: readonly string[], out: (line: string) => void = (l) => void process.stdout.write(l + '\n')): Promise<number> {
  const args = [...argv];
  let file: string | undefined;
  let allowed: string | undefined;
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === '-h' || a === '--help') return void process.stdout.write(VERIFY_RUN_USAGE), 0;
    if (a === '--allowed-runners') allowed = args.shift();
    else if (a.startsWith('-') && a !== '-') {
      process.stderr.write(`md-runbook: unknown option ${a}\n\n${VERIFY_RUN_USAGE}`);
      return 2;
    } else file = a;
  }
  if (!file || !allowed) {
    process.stderr.write(`md-runbook: ${file ? '--allowed-runners needs a file' : 'missing the envelope file'}\n\n${VERIFY_RUN_USAGE}`);
    return 2;
  }
  let json: string;
  try {
    json = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (e) {
    process.stderr.write(`md-runbook: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  try {
    const { signer, envelope } = await verifyRunEnvelope(json, allowed);
    out(`✓ signed by ${signer} (${allowed})`);
    out(JSON.stringify(envelope.summary, null, 2));
    return 0;
  } catch (e) {
    out(`✗ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/**
 * Run a runbook outside VS Code (CI, scheduled checks, servers): the same parser, shells, cell
 * options, checks, redaction and output format as the extension, with no prompts. What needs a
 * person in VS Code fails clearly here instead: a missing `${input:}`, a risky command without
 * `--yes`, a proposed or assistant-written cell.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_PATTERNS,
  ExecuteResult,
  LineBuffer,
  WriteOptions,
  createRedactor,
  exitLabel,
  formatDurationAttr,
  formatLocalIso,
  isSuccess,
  locateCodeCells,
  outputSummary,
  parse,
  setCellOutput,
  shellKindForLanguage,
} from '@md-runbook/core';
import { executeCell } from '@md-runbook/core/node';
import type { ShellSettings } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { CheckOutcome, evaluateChecks, hasChecks } from '@md-runbook/core/checks';
import { DEFAULT_CONFIRM_PATTERNS, compileConfirmPatterns, confirmationFor } from '@md-runbook/core/confirm';
import { currentOs, osGroups, osLabel } from '@md-runbook/core/os';
import { proposalOf } from '@md-runbook/core/proposal';
import { REDACTED } from '@md-runbook/core/redact';
import { findRefs, parseFrontMatter, rewriteRefs } from '@md-runbook/core/secrets';
import { SessionPool } from '@md-runbook/core/node/session';

export interface CliOptions {
  file: string;
  /** Write the outputs into the runbook (or `out`); false for --check. */
  write: boolean;
  out?: string;
  report?: string;
  junit?: string;
  /** Also write the step results as JSON (for scripts). */
  json?: string;
  /** Values for `${param:NAME}` (else the front matter default). */
  params: Record<string, string>;
  /** Values for `${input:NAME}` (else the environment variable NAME). */
  inputs: Record<string, string>;
  /** Run cells that would ask for a confirmation in VS Code (risky commands, `confirm`). */
  yes: boolean;
  /** Carry on after a failed step. */
  keepGoing: boolean;
  /** undefined: the front matter's `mode:`, else isolated. */
  session?: boolean;
  /** Default timeout; the front matter and cell options win. */
  timeoutSeconds?: number;
  shell: ShellSettings;
  /** Where `${secret:NAME}` and `${input:NAME}` values come from (process.env). */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** More values to redact everywhere (e.g. the notification URL). */
  extraSecrets?: string[];
}

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'not run';

export interface StepResult {
  step: number;
  /** 1-based line of the opening fence. */
  line: number;
  language: string;
  title: string;
  status: StepStatus;
  exit: string;
  durationMs: number;
  /** Why it failed or was not run. */
  message?: string;
  output: string;
}

export interface RunSummary {
  steps: StepResult[];
  /** The runbook with the new outputs. */
  text: string;
  ok: boolean;
  /** The run's redaction (patterns and every secret seen), for the reports. */
  redact: (text: string) => string;
}

export interface CliIO {
  /** Live output of the cells (already redacted). */
  out(text: string): void;
  /** Progress lines (▶ step, ✓ exit 0, …). */
  log(line: string): void;
}

const MIN_SECRET = 4;
const sleep = (ms: number, signal?: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve(false)), { once: true });
  });

export async function runRunbook(o: CliOptions, io: CliIO): Promise<RunSummary> {
  const original = fs.readFileSync(o.file, 'utf8');
  const fileName = path.basename(o.file);
  const mdDir = path.dirname(path.resolve(o.file));
  const fm = parseFrontMatter(original);
  const baseCwd = fm?.cwd ? path.resolve(mdDir, fm.cwd) : mdDir;
  const session = o.session ?? fm?.mode === 'session';
  const pool = session ? new SessionPool() : undefined;

  // Redaction: the default patterns, plus every secret value seen (exact match).
  const known = new Set<string>();
  const patterns = createRedactor(DEFAULT_PATTERNS);
  const redact = (s: string): string => {
    let out = patterns.redact(s);
    for (const v of [...known].sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
    return out;
  };
  const addSecret = (v: string): void => void (v.length >= MIN_SECRET && known.add(v));
  const writeOpts: WriteOptions = { persistOutputs: true, maxOutputLines: 2000, stripAnsi: true, redact };
  const { regexes } = compileConfirmPatterns(DEFAULT_CONFIRM_PATTERNS);
  const captures = new Map<string, { value: string; secret: boolean }>();

  let text = original;
  const doc = parse(original);
  const locs = locateCodeCells(doc);
  for (const v of o.extraSecrets ?? []) addSecret(v);
  // Every secret the runbook uses is known before the first step: a step that prints the
  // environment (env, set -x) before the step that references it must not show it either.
  for (const loc of locs) {
    if (!shellKindForLanguage(loc.language)) continue;
    let refs: ReturnType<typeof findRefs> = [];
    try {
      refs = findRefs(loc.source);
    } catch {
      continue; // reported when the step runs
    }
    for (const ref of refs) {
      if (!ref.secret) continue;
      const v = ref.kind === 'secret' ? o.env[ref.name] : ref.kind === 'input' ? (o.inputs[ref.name] ?? o.env[ref.name]) : undefined;
      if (v !== undefined) addSecret(v);
    }
  }

  const slots = osGroups(doc.cells.map((c) => (c.kind === 'code' ? { kind: 'code' as const, os: parseCellOptions(c.meta.kind === 'code' ? c.meta.info : '').os } : { kind: 'markup' as const })));
  const activeGroups = new Set(slots.filter((s) => s?.active).map((s) => s!.group));
  const stepOfGroup = new Map<number, number>();
  const steps: StepResult[] = [];
  let step = 0;
  let stopped = false;

  try {
    for (const loc of locs) {
      const slot = slots[loc.cellIndex];
      if (slot && stepOfGroup.has(slot.group)) {
        // Another alternative of a step already counted.
        if (!slot.active) continue;
      } else {
        step++;
        if (slot) stepOfGroup.set(slot.group, step);
      }
      const n = slot ? stepOfGroup.get(slot.group)! : step;
      const opts = parseCellOptions(loc.info);
      const firstLine = loc.source.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
      const result = (status: StepStatus, exit: string, extra: Partial<StepResult> = {}): StepResult => ({
        step: n,
        line: loc.line + 1,
        language: loc.language,
        title: redact(opts.name ?? firstLine),
        status,
        exit,
        durationMs: 0,
        output: '',
        ...extra,
      });
      const where = `Step ${n} · ${fileName}:${loc.line + 1} · ${loc.language}`;

      if (slot && !slot.active) {
        // For another OS: not run, output untouched. A group with none for this OS is skipped.
        if (!activeGroups.has(slot.group)) {
          io.log(`– ${where}: for ${osLabel(opts.os ?? [])}, skipped on ${osLabel([currentOs()])}`);
          steps.push(result('skipped', 'skipped', { message: `for ${osLabel(opts.os ?? [])}` }));
        }
        continue;
      }
      if (stopped) {
        steps.push(result('not run', 'not run', { message: 'an earlier step failed' }));
        continue;
      }

      const notRun = (message: string, exit = 'not run'): void => {
        io.log(`✗ ${where}: not run: ${message}`);
        steps.push(result('not run', exit, { message }));
        if (!o.keepGoing) stopped = true;
      };
      if (opts.errors.length > 0) {
        notRun(`invalid cell option ${opts.errors.join('; ')}`, 'error');
        continue;
      }
      const proposal = proposalOf(loc.info);
      if (proposal.state === 'proposed') {
        notRun('proposed by an assistant and not approved; approve it in VS Code first');
        continue;
      }
      if (proposal.by !== undefined) {
        notRun('written by an assistant; such cells only run in VS Code (approval, read-only credentials)');
        continue;
      }
      const kind = shellKindForLanguage(loc.language);
      if (!kind) continue; // not a shell block
      if (opts.skip) {
        io.log(`– ${where}: skipped (skip option)`);
        text = setCellOutput(text, loc.cellIndex, { kind: 'new', text: '[md-runbook] skipped: skip option\n', attrs: { exit: 'skipped', ran: formatLocalIso(new Date()) } }, writeOpts) ?? text;
        steps.push(result('skipped', 'skipped'));
        continue;
      }
      // `no-confirm` can't switch the safety net off here either.
      const match = confirmationFor(loc.source, 'patterns', regexes, opts.confirm === true ? true : undefined);
      if (match !== undefined && !o.yes) {
        const why = match === '' ? 'this block asks for confirmation (confirm option)' : `risky command “${match.trim()}”`;
        text =
          setCellOutput(text, loc.cellIndex, { kind: 'new', text: `[md-runbook] not confirmed: ${why}; pass --yes to run it\n`, attrs: { exit: 'declined', ran: formatLocalIso(new Date()) } }, writeOpts) ??
          text;
        notRun(`${why}; pass --yes to run it`, 'declined');
        continue;
      }

      // Placeholders: values come from the command line and the environment, never from prompts.
      const env: Record<string, string> = { ...opts.env };
      let missing: string | undefined;
      let refs: ReturnType<typeof findRefs>;
      try {
        refs = findRefs(loc.source);
      } catch (e) {
        notRun(e instanceof Error ? e.message : String(e), 'error');
        continue;
      }
      for (const ref of refs) {
        let value: string | undefined;
        let secret = ref.secret;
        if (ref.kind === 'secret') value = o.env[ref.name];
        else if (ref.kind === 'input') value = o.inputs[ref.name] ?? o.env[ref.name];
        else if (ref.kind === 'param') value = o.params[ref.name] ?? fm?.params.find((p) => p.name === ref.name)?.default;
        else {
          const c = captures.get(ref.name);
          value = c?.value;
          secret = c?.secret ?? false;
        }
        if (value === undefined) {
          missing =
            ref.kind === 'secret'
              ? `\${secret:${ref.name}}: set the environment variable ${ref.name}`
              : ref.kind === 'input'
                ? `\${input:${ref.name}}: pass --input ${ref.name}=… or set the environment variable ${ref.name}`
                : ref.kind === 'param'
                  ? `\${param:${ref.name}}: pass --param ${ref.name}=… (it has no default)`
                  : `\${out:${ref.name}} has no value yet; run the cell with capture=${ref.name} first`;
          break;
        }
        env[ref.name] = value;
        if (secret) addSecret(value);
      }
      if (missing) {
        notRun(missing, 'error');
        continue;
      }
      const source = refs.length > 0 ? rewriteRefs(loc.source, kind) : loc.source;
      // A value captured as a secret is only known once the cell has finished: hold back the
      // output of such a cell and print it redacted afterwards (a CI log can't be redrawn).
      const holdOutput = (opts.checks?.captures ?? []).some((c) => c.secret);
      let held = '';
      const cwd = opts.cwd !== undefined ? path.resolve(mdDir, opts.cwd) : baseCwd;
      const timeoutS = opts.timeoutSeconds ?? fm?.timeoutSeconds ?? o.timeoutSeconds ?? 0;
      const attempts = opts.retry?.attempts ?? 1;

      io.log(`▶ ${where}${opts.name ? ` · ${opts.name}` : ''}`);
      const started = new Date();
      let transcript = '';
      let stdout = '';
      let r: ExecuteResult;
      let outcome: CheckOutcome | undefined;
      let attempt = 0;
      for (;;) {
        attempt++;
        transcript = '';
        stdout = '';
        held = '';
        const live = new LineBuffer((t) => (holdOutput ? (held += t) : io.out(t)), redact);
        const sink = (isOut: boolean) => (t: string) => {
          transcript += t;
          if (isOut) stdout += t;
          live.write(t);
        };
        const exec = {
          language: loc.language,
          source,
          cwd,
          settings: o.shell,
          timeoutMs: timeoutS * 1000,
          env,
          signal: o.signal,
          onStdout: sink(true),
          onStderr: sink(false),
        };
        if (!fs.existsSync(cwd)) {
          r = { exitCode: null, signal: null, timedOut: false, cancelled: false, error: `Working directory not found: ${cwd}`, durationMs: 0 };
        } else {
          try {
            r = pool ? await pool.execute({ ...exec, baseCwd }) : await executeCell(exec);
          } catch (e) {
            r = { exitCode: null, signal: null, timedOut: false, cancelled: false, error: e instanceof Error ? e.message : String(e), durationMs: 0 };
          }
        }
        live.flush();
        outcome =
          hasChecks(opts.checks) && r.exitCode !== null && r.error === undefined && !r.timedOut && !r.cancelled
            ? evaluateChecks(opts.checks, r.exitCode, transcript, stdout)
            : undefined;
        const passed = outcome ? outcome.ok : isSuccess(r);
        if (passed || attempt >= attempts || r.cancelled || o.signal?.aborted) break;
        const why = outcome?.failures[0] ?? (r.timedOut ? 'timed out' : (r.error ?? `exit code ${exitLabel(r)}`));
        const every = opts.retry?.everyMs ?? 0;
        io.log(`  attempt ${attempt}/${attempts} failed (${redact(why)}); trying again in ${every / 1000}s`);
        if (!(await sleep(every, o.signal))) break;
      }
      // Secrets that matched are known now (even if another capture failed): print what was held back.
      for (const v of outcome?.secretValues ?? []) addSecret(v);
      if (holdOutput) io.out(redact(held));
      const add = (line: string): void => {
        transcript += line;
        io.out(redact(line));
      };
      if (r.error !== undefined) add(r.error + '\n');
      if (r.timedOut) add(`[md-runbook] timed out after ${timeoutS}s; process tree killed\n`);
      for (const f of outcome && !outcome.ok ? outcome.failures : []) add(`[md-runbook] check failed: ${f}\n`);
      if (outcome?.ok) for (const c of outcome.captured) captures.set(c.name, { value: c.value, secret: c.secret });

      const ended = new Date();
      const exit = exitLabel(r);
      const check = outcome ? (outcome.ok ? 'ok' : 'failed') : undefined;
      const attrs: Record<string, string> = {
        exit,
        ran: formatLocalIso(started),
        ended: formatLocalIso(ended),
        duration: formatDurationAttr(ended.getTime() - started.getTime()),
        ...(check ? { check } : {}),
        ...(attempts > 1 ? { attempts: String(attempt) } : {}),
        ...(opts.name !== undefined ? { name: opts.name } : {}),
      };
      text = setCellOutput(text, loc.cellIndex, { kind: 'new', text: transcript, attrs }, writeOpts) ?? text;
      const ok = outcome ? outcome.ok : isSuccess(r);
      // Without ran/ended: "5m ago" means nothing in a terminal.
      const { ran: _ran, ended: _ended, ...shown } = attrs;
      io.log(`${outputSummary(shown)}${r.shell ? ` · ${r.shell.label}` : ''}`);
      steps.push(result(ok ? 'passed' : 'failed', exit, { durationMs: ended.getTime() - started.getTime(), output: redact(transcript), ...(ok ? {} : { message: outcome?.failures[0] ?? `exit ${exit}` }) }));
      if (!ok && !opts.continueOnError && !o.keepGoing) stopped = true;
      if (o.signal?.aborted) stopped = true;
    }
  } finally {
    pool?.dispose();
  }

  const ok = steps.every((s) => s.status === 'passed' || s.status === 'skipped');
  return { steps, text, ok, redact };
}

const xml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** JUnit XML, which most CI systems show as a test report. */
export function junitReport(file: string, steps: readonly StepResult[]): string {
  const failures = steps.filter((s) => s.status === 'failed' || s.status === 'not run').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const time = (ms: number): string => (ms / 1000).toFixed(3);
  const total = steps.reduce((t, s) => t + s.durationMs, 0);
  const cases = steps.map((s) => {
    const name = xml(`Step ${s.step}: ${s.title}`);
    const head = `    <testcase classname="${xml(file)}" name="${name}" time="${time(s.durationMs)}">`;
    if (s.status === 'passed') return `${head}</testcase>`;
    if (s.status === 'skipped') return `${head}<skipped message="${xml(s.message ?? 'skipped')}"/></testcase>`;
    return `${head}\n      <failure message="${xml(s.message ?? s.exit)}">${xml(s.output)}</failure>\n    </testcase>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites>\n  <testsuite name="${xml(file)}" tests="${steps.length}" failures="${failures}" skipped="${skipped}" time="${time(total)}">\n` +
    cases.join('\n') +
    '\n  </testsuite>\n</testsuites>\n'
  );
}

/** A Markdown table of the steps, e.g. for GitHub's job summary ($GITHUB_STEP_SUMMARY). */
export function markdownSummary(file: string, steps: readonly StepResult[]): string {
  const icon: Record<StepStatus, string> = { passed: '✅', failed: '❌', skipped: '⏭️', 'not run': '⛔' };
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const rows = steps.map((s) => `| ${s.step} | ${icon[s.status]} ${s.status} | \`${cell(s.title).slice(0, 80)}\` | ${cell(s.exit)} | ${(s.durationMs / 1000).toFixed(1)}s | ${cell(s.message ?? '')} |`);
  const passed = steps.filter((s) => s.status === 'passed').length;
  return `### ${cell(file)}: ${passed}/${steps.length} steps passed\n\n| Step | Result | Command | Exit | Time | Note |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

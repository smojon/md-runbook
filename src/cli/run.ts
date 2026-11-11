/**
 * Run a runbook outside VS Code (CI, scheduled checks, servers): the same parser, shells, cell
 * options, checks, redaction and output format as the extension, with no prompts. What needs a
 * person in VS Code fails clearly here instead: a missing `${input:}`, a risky command without
 * `--yes`, a proposed or assistant-written cell. What is known before the first step (a bad
 * --from/--to/--section, a capture left out, cells that need --yes) is a RunUsageError.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_PATTERNS,
  ExecuteResult,
  LineBuffer,
  WriteOptions,
  createRedactor,
  exitLabel,
  formatEstimate,
  formatRunbookEstimate,
  isOverEstimate,
  runbookEstimate,
  formatDurationAttr,
  formatLocalIso,
  isCodeMeta,
  isSuccess,
  loadedOutputEntry,
  nextHistory,
  locateCodeCells,
  outputSummary,
  parse,
  setCellOutput,
  shellKindForLanguage,
} from '@md-runbook/core';
import { callEstimateSeconds, callTarget, executeCell, fileSha256, relativeToCaller, samePath, writeCallCopy } from '@md-runbook/core/node';
import { callAttrs, callChainProblem, callFromAttrs, callOutputText, callRefs, checkCall, fillRefs, formatCallSteps, isCallLanguage, parseCall } from '@md-runbook/core/call';
import { stepState } from '@md-runbook/core/progress';
import { KubeContextMode } from '@md-runbook/core/kubeContext';
import type { ShellSettings } from '@md-runbook/core';
import { cellRefs, parseCellOptions } from '@md-runbook/core/cellOptions';
import { checkKubeContext, kubeContextParam, resolveKubeContext, wantedKubeContext } from '@md-runbook/core/kubeContext';
import { KubeconfigPins, runbookEnv, withRunbookEnv } from '@md-runbook/core/node/runbookEnv';
import { CheckOutcome, evaluateChecks, hasChecks, resolveChecks } from '@md-runbook/core/checks';
import { DEFAULT_CONFIRM_PATTERNS, compileConfirmPatterns, confirmationFor } from '@md-runbook/core/confirm';
import { currentOs, osGroups, osLabel, stepNumbers } from '@md-runbook/core/os';
import { proposalOf } from '@md-runbook/core/proposal';
import { REDACTED } from '@md-runbook/core/redact';
import { VarRef, findRefs, parseFrontMatter, rewriteRefs } from '@md-runbook/core/secrets';
import { inSections, sectionHeadings } from '@md-runbook/core/sections';
import { historySizeFor, runnerAttrs } from '@md-runbook/core/incident';
import { SessionPool } from '@md-runbook/core/node/session';
import { TranscriptFile } from '@md-runbook/core/node/transcript';
import { TranscriptEntry, transcriptNote } from '@md-runbook/core/transcript';
import { ManualStep, PlannedBlock, RunUsageError, formatSteps, headingsOf, missingCaptures, selectManual, selectSteps, selectionLabel } from './select';
import { taskItems } from '@md-runbook/core';
import { checkSignedRun, insideRoot, repositoryRoot } from './signedRun';

export interface CliOptions {
  file: string;
  /** Write the outputs into the runbook (or `out`); false for --check. */
  write: boolean;
  out?: string;
  report?: string;
  junit?: string;
  /** Also write the step results as JSON (for scripts). */
  json?: string;
  /** Also append every step to this transcript as it runs (core/transcript.ts). */
  transcript?: string;
  /** Values for `${param:NAME}` (else the front matter default). */
  params: Record<string, string>;
  /** Values for `${input:NAME}` (else the environment variable NAME). */
  inputs: Record<string, string>;
  /** Run cells that would ask for a confirmation in VS Code (risky commands, `confirm`). */
  yes: boolean;
  /** Carry on after a failed step. */
  keepGoing: boolean;
  /** Only steps from..to (the numbers of the `▶ Step N` lines), inclusive. */
  from?: number;
  to?: number;
  /** Only the steps under headings starting with one of these (with from/to: both must hold). */
  sections?: string[];
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
  /** After each step, the run's progress by the blocks' estimates (a terminal, not a CI log). */
  progress?: boolean;
  /** Where runbook calls write the copies of the runbooks they run (relative to each one; default: next to it). */
  copyFolder?: string;
  /** A failed call run again starts a fresh copy, instead of continuing the one it ran. */
  freshCopy?: boolean;
  /** For a runbook run by a call: the files calling it, the first the one run (cycles, depth). */
  callers?: string[];
  /** For a runbook run by a call: "5." before its step numbers. */
  stepPrefix?: string;
  /**
   * Run only as signed (signedRun.ts): the runbook's signature must be good by a key in this
   * allowed signers file, and the runbooks its calls run too.
   */
  allowedSigners?: string;
  /** For a signed run: the repository the runbooks it calls must be in (default: the runbook's). */
  signedRoot?: string;
  /** Pass over blocks whose output says they are done or skipped (a call continuing its copy). */
  skipDone?: boolean;
  /** For a runbook run by a call that names no kube-context: the caller's (resolved) and its mode. */
  inheritKubeContext?: { context: string; mode?: KubeContextMode };
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
  /** estimate= in seconds (absent when the block has none). */
  estimateSeconds?: number;
  /** Why it failed or was not run. */
  message?: string;
  output: string;
  /** A runbook call: the runbook run (relative to this file), its copy, and its steps. */
  call?: { runbook: string; copy: string; sha256: string; steps: StepResult[]; manual: ManualStep[] };
}

export interface RunSummary {
  steps: StepResult[];
  /** The manual steps (task-list items) of the part run, ticked or not (their text redacted). */
  manual: ManualStep[];
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
  // A signed run: refused before anything runs unless all of it is as signed.
  const signedRoot = o.allowedSigners ? (o.signedRoot ?? repositoryRoot(o.file)) : undefined;
  if (o.allowedSigners && signedRoot) {
    const check = await checkSignedRun(o.file, o.params, o.allowedSigners, signedRoot);
    if (check.problems.length > 0) throw new RunUsageError(`not run as signed (--allowed-signers ${o.allowedSigners}); nothing ran:\n${check.problems.map((p) => `  ${p}`).join('\n')}`);
    io.log(`✓ signed${check.signer ? ` by ${check.signer}` : ''}, unchanged, parameters as signed`);
  }
  const fileName = path.basename(o.file);
  const mdDir = path.dirname(path.resolve(o.file));
  const parsedFm = parseFrontMatter(original);
  // Run by a call that names a cluster, a runbook that names none runs against the caller's.
  const inherit = o.inheritKubeContext;
  const fm =
    inherit && !parsedFm?.kubeContext
      ? { params: [], ...parsedFm, kubeContext: inherit.context, ...(inherit.mode && !parsedFm?.kubeContextMode ? { kubeContextMode: inherit.mode } : {}) }
      : parsedFm;
  const baseCwd = fm?.cwd ? path.resolve(mdDir, fm.cwd) : mdDir;
  const session = o.session ?? fm?.mode === 'session';
  const pins = new KubeconfigPins();

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
    const call = isCallLanguage(loc.language);
    if (!shellKindForLanguage(loc.language) && !call) continue;
    let refs: ReturnType<typeof findRefs> = [];
    try {
      refs = call ? callRefs(parseCall(loc.info, loc.source)) : findRefs(loc.source);
    } catch {
      continue; // reported when the step runs
    }
    for (const ref of refs) {
      if (!ref.secret) continue;
      const v = ref.kind === 'secret' ? o.env[ref.name] : ref.kind === 'input' ? (o.inputs[ref.name] ?? o.env[ref.name]) : undefined;
      if (v !== undefined) addSecret(v);
    }
  }

  const osCells = doc.cells.map((c) => (c.kind === 'code' ? { kind: 'code' as const, os: parseCellOptions(c.meta.kind === 'code' ? c.meta.info : '').os } : { kind: 'markup' as const }));
  const slots = osGroups(osCells);
  const activeGroups = new Set(slots.filter((s) => s?.active).map((s) => s!.group));
  // The numbers of Export Report and the run record; --from/--to mean these.
  const numberOf = stepNumbers(osCells);
  const numbers = locs.map((loc) => numberOf[loc.cellIndex]!);

  // Checked before the first step: what is known now must not stop a long run halfway.
  const selection = { ...(o.from !== undefined ? { from: o.from } : {}), ...(o.to !== undefined ? { to: o.to } : {}), ...(o.sections?.length ? { sections: o.sections } : {}) };
  // Manual steps (task-list items): nothing runs them, but the run lists those not ticked.
  const lines = original.split(/\r?\n/);
  const manualAll: (ManualStep & { after: number })[] = taskItems(original).map((t) => {
    let after = -1;
    locs.forEach((l, k) => void (l.line < t.line && (after = k)));
    return { line: t.line, step: after >= 0 ? numbers[after]! : 0, after, text: (lines[t.line] ?? '').replace(/^.*?\[[ xX]\][ \t]*/, '').trim(), ticked: t.checked };
  });
  const selected = selectSteps(original, locs, numbers, selection, manualAll);
  const manual = selectManual(original, numbers, selection, manualAll) as (ManualStep & { after: number })[];
  const manualShown = new Set<number>();
  /** Log the unticked manual steps after block `k` (-1: before the first). */
  const listManual = (k: number): void => {
    for (const m of manual) {
      if (m.after !== k || m.ticked || manualShown.has(m.line)) continue;
      manualShown.add(m.line);
      io.log(`☐ manual, not ticked · ${fileName}:${m.line + 1} · ${redact(m.text)}`);
    }
  };
  const blocks: PlannedBlock[] = locs.map((loc, i) => {
    const opts = parseCellOptions(loc.info);
    const slot = slots[loc.cellIndex];
    const proposal = proposalOf(loc.info);
    let uses: string[] = [];
    try {
      uses = (isCallLanguage(loc.language) ? callRefs(parseCall(loc.info, loc.source)) : cellRefs(loc.source, loc.info, fm)).filter((r) => r.kind === 'out').map((r) => r.name);
    } catch {
      // reported when the step runs
    }
    const isSelected = !selected || selected.has(numbers[i]!);
    return {
      n: numbers[i]!,
      loc,
      selected: isSelected,
      runs: isSelected && (!slot || slot.active) && !opts.host && !opts.skip && opts.errors.length === 0 && proposal.state !== 'proposed' && proposal.by === undefined,
      uses,
      captures: (opts.checks?.captures ?? []).map((c) => c.name),
    };
  });
  const uncaptured = missingCaptures(blocks, fileName);
  if (uncaptured.length > 0) {
    throw new RunUsageError(`${uncaptured.join('\n')}\nselect the step that captures it too (a run starts without captured values); nothing ran`);
  }
  if (!o.yes && !o.keepGoing) {
    // The same decision as each step's own below, which stays: with --keep-going a declined
    // step doesn't stop the run, so it is reported where it is, like any other failure.
    const declined = blocks.flatMap((b) => {
      if (!b.runs) return [];
      const opts = parseCellOptions(b.loc.info);
      const match = confirmationFor(isCallLanguage(b.loc.language) ? '' : b.loc.source, 'patterns', regexes, opts.confirm === true ? true : undefined);
      if (match === undefined) return [];
      const firstLine = b.loc.source.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
      return [`  Step ${b.n} · ${fileName}:${b.loc.line + 1} · ${redact(opts.name ?? firstLine)}: ${match === '' ? 'confirm option' : `risky command “${match.trim()}”`}`];
    });
    if (declined.length > 0) {
      const one = declined.length === 1;
      throw new RunUsageError(
        `${one ? 'a step asks' : `${declined.length} steps ask`} for confirmation in VS Code and ${one ? 'needs' : 'need'} --yes here; nothing ran:\n` +
          `${declined.join('\n')}\npass --yes to run ${one ? 'it' : 'them'}`,
      );
    }
  }
  if (selected) {
    io.log(
      selected.size === 0
        ? `No block selected (${selectionLabel(selection)}): manual steps only`
        : `Step${selected.size === 1 ? '' : 's'} ${formatSteps([...selected])} of ${Math.max(0, ...numbers)} (${selectionLabel(selection)})`,
    );
  }
  const notSelected = `not selected (${selectionLabel(selection)})`;

  const pool = session ? new SessionPool() : undefined;
  const transcriptFile = o.transcript ? new TranscriptFile(path.resolve(o.transcript), (e) => io.log(`! the transcript ${o.transcript} can't be written, so it stops: ${e.message}`)) : undefined;
  const pre = o.stepPrefix ?? '';
  const headings = headingsOf(original);
  const sectionAt = (line: number): string | undefined => [...headings].reverse().find((h) => h.line < line)?.text;
  const note = (n: number, title: string, text: string): void => {
    transcriptFile?.append(transcriptNote(new Date(), fileName, `Step ${pre}${n} · ${title}: ${text}`, redact));
    transcriptFile?.flush();
  };
  /** A placeholder's value: from the command line, the environment or an earlier capture, never from prompts. */
  const lookup = (ref: VarRef): { value: string; secret: boolean } | { missing: string } => {
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
    if (value !== undefined) return { value, secret };
    return {
      missing:
        ref.kind === 'secret'
          ? `\${secret:${ref.name}}: set the environment variable ${ref.name}`
          : ref.kind === 'input'
            ? `\${input:${ref.name}}: pass --input ${ref.name}=… or set the environment variable ${ref.name}`
            : ref.kind === 'param'
              ? o.callers
                ? `\${param:${ref.name}}: the runbook call doesn't pass ${ref.name} (${ref.name}=… in its block), and it has no default`
                : `\${param:${ref.name}}: pass --param ${ref.name}=… (it has no default)`
              : `\${out:${ref.name}} has no value yet; run the cell with capture=${ref.name} first`,
    };
  };
  const counted = new Set<number>();
  const steps: StepResult[] = [];
  let stopped = false;
  // The run's progress by estimates: the blocks this run will run, and the ones it has run.
  const planned = blocks.flatMap((b, i) => (b.runs ? [i] : []));
  // A runbook call's estimate is what it runs (callEstimateSeconds).
  const estimates = locs.map((loc) => (isCallLanguage(loc.language) ? callEstimateSeconds(o.file, loc.info, loc.source) : parseCellOptions(loc.info).estimateSeconds));
  const finished = new Set<number>();
  const progressLine = (): string | undefined =>
    formatRunbookEstimate(runbookEstimate(planned.map((i) => ({ estimateSeconds: estimates[i], state: finished.has(i) ? 'done' : 'pending' }))));

  try {
    for (const [i, loc] of locs.entries()) {
      listManual(i - 1);
      const slot = slots[loc.cellIndex];
      if (slot && counted.has(slot.group)) {
        // Another alternative of a step already counted.
        if (!slot.active) continue;
      } else if (slot) counted.add(slot.group);
      const n = numbers[i]!;
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
        ...(opts.estimateSeconds !== undefined ? { estimateSeconds: opts.estimateSeconds } : {}),
        output: '',
        ...extra,
      });
      const where = `Step ${pre}${n} · ${fileName}:${loc.line + 1} · ${loc.language}`;

      if (slot && !slot.active) {
        // For another OS: not run, output untouched. A group with none for this OS is skipped.
        if (!activeGroups.has(slot.group)) {
          io.log(`– ${where}: for ${osLabel(opts.os ?? [])}, skipped on ${osLabel([currentOs()])}`);
          steps.push(result('skipped', 'skipped', { message: `for ${osLabel(opts.os ?? [])}` }));
        }
        continue;
      }
      if (o.skipDone && blocks[i]!.selected) {
        const a = loc.outputAttrs;
        const state = stepState(a?.exit, a?.lines !== undefined, a?.check);
        if (state === 'done' || state === 'skipped') {
          io.log(`– ${where}: done in an earlier run, kept`);
          steps.push(result('skipped', 'skipped', { message: 'done in an earlier run' }));
          finished.add(i);
          continue;
        }
      }
      if (!blocks[i]!.selected) {
        // Left out by --from/--to/--section: not run, output untouched (a resumed run keeps the earlier ones).
        steps.push(result('skipped', 'skipped', { message: notSelected }));
        continue;
      }
      if (opts.host) {
        // Runs on a remote host from the md-runbook app; the CLI runs cells on this machine.
        io.log(`– ${where}: runs on the host ${opts.host} (md-runbook app), skipped here`);
        steps.push(result('skipped', 'skipped', { message: `runs on the host ${opts.host}` }));
        continue;
      }
      if (stopped) {
        steps.push(result('not run', 'not run', { message: 'an earlier step failed' }));
        continue;
      }

      const notRun = (message: string, exit = 'not run'): void => {
        io.log(`✗ ${where}: not run: ${message}`);
        note(n, redact(opts.name ?? firstLine), `not run: ${message}`);
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
      const isCall = isCallLanguage(loc.language);
      if (!kind && !isCall) continue; // not a shell block
      if (opts.skip) {
        io.log(`– ${where}: skipped (skip option)`);
        text = setCellOutput(text, loc.cellIndex, { kind: 'new', text: '[md-runbook] skipped: skip option\n', attrs: { exit: 'skipped', ran: formatLocalIso(new Date()) } }, writeOpts) ?? text;
        steps.push(result('skipped', 'skipped'));
        continue;
      }
      // `no-confirm` can't switch the safety net off here either.
      const match = confirmationFor(isCall ? '' : loc.source, 'patterns', regexes, opts.confirm === true ? true : undefined);
      if (match !== undefined && !o.yes) {
        const why = match === '' ? 'this block asks for confirmation (confirm option)' : `risky command “${match.trim()}”`;
        text =
          setCellOutput(text, loc.cellIndex, { kind: 'new', text: `[md-runbook] not confirmed: ${why}; pass --yes to run it\n`, attrs: { exit: 'declined', ran: formatLocalIso(new Date()) } }, writeOpts) ??
          text;
        notRun(`${why}; pass --yes to run it`, 'declined');
        continue;
      }

      if (isCall) {
        // A runbook call: the runbook it names runs as a copy, as one step of this one (core/call.ts).
        const call = parseCall(loc.info, loc.source);
        if (call.problems.length > 0 || call.src === undefined) {
          notRun(call.problems.map((p) => p.message).join('; '), 'error');
          continue;
        }
        let refs: VarRef[];
        try {
          refs = callRefs(call);
        } catch (e) {
          notRun(e instanceof Error ? e.message : String(e), 'error');
          continue;
        }
        const values = new Map<string, { value: string; secret: boolean }>();
        let missing: string | undefined;
        for (const ref of refs) {
          const v = lookup(ref);
          if ('missing' in v) {
            missing = v.missing;
            break;
          }
          values.set(ref.name, v);
          if (v.secret) addSecret(v.value);
        }
        if (missing) {
          notRun(missing, 'error');
          continue;
        }
        const fill = (t: string): string => {
          const r = fillRefs(t, (_kind, name) => values.get(name)?.value);
          return 'text' in r ? r.text : t;
        };
        const target = callTarget(o.file, fill(call.src));
        const shown = relativeToCaller(o.file, target);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          notRun(`src="${redact(call.src)}": no such runbook: ${redact(shown)}`, 'error');
          continue;
        }
        if (signedRoot && !insideRoot(signedRoot, target)) {
          notRun(`${redact(shown)} is outside the repository (${signedRoot}): a signed runbook calls runbooks in its own repository`, 'error');
          continue;
        }
        const callers = o.callers ?? [path.resolve(o.file)];
        const chain = callChainProblem(
          callers.map((p) => path.relative(process.cwd(), p) || p),
          path.relative(process.cwd(), target) || target,
          (a, b) => samePath(a, b),
        );
        if (chain) {
          notRun(chain, 'error');
          continue;
        }
        const childText = fs.readFileSync(target, 'utf8');
        const check = checkCall(call, childText);
        const refusal = [
          ...check.unknown.map((a) => `${shown} has no parameter ${a.name}`),
          ...check.notPassed.map((p) => `${shown} needs \${param:${p}}: pass it in the call (${p}=…), it has no default`),
          ...check.sections,
        ];
        if (refusal.length > 0) {
          notRun(refusal.join('; '), 'error');
          continue;
        }
        const params: Record<string, string> = {};
        for (const a of call.args) params[a.name] = fill(a.value);
        // The cluster: a runbook called runs against the caller's, or names the same one.
        const childFm = parseFrontMatter(childText);
        let inheritKube: CliOptions['inheritKubeContext'];
        try {
          const paramOf = (name: string): string | undefined => o.params[name] ?? fm?.params.find((p) => p.name === name)?.default;
          const mine = resolveKubeContext(wantedKubeContext(opts, fm), paramOf);
          const theirs = resolveKubeContext(childFm?.kubeContext, (name) => params[name] ?? childFm?.params.find((p) => p.name === name)?.default);
          if (mine !== undefined && theirs !== undefined && mine !== theirs) {
            notRun(`${shown} runs against the Kubernetes context ${theirs}, this runbook against ${mine}: nothing ran`, 'error');
            continue;
          }
          if (mine !== undefined && theirs === undefined) inheritKube = { context: mine, ...(fm?.kubeContextMode ? { mode: fm.kubeContextMode } : {}) };
        } catch (e) {
          notRun(e instanceof Error ? e.message : String(e), 'error');
          continue;
        }
        // Run again after a failure: the same copy goes on, keeping the steps done there (and
        // the manual steps ticked in it since).
        let copy: string | undefined;
        let resumed = false;
        const prev = callFromAttrs(loc.outputAttrs);
        if (prev && !o.freshCopy && prev.exit !== undefined && prev.exit !== '0') {
          const old = path.resolve(path.dirname(path.resolve(o.file)), prev.copy);
          if (fs.existsSync(old) && samePath(callTarget(o.file, prev.runbook), target)) {
            copy = old;
            resumed = true;
          }
        }
        copy ??= writeCallCopy(target, original, o.copyFolder);
        const copyShown = relativeToCaller(o.file, copy);
        const title = redact(opts.name ?? firstLine);
        const part = call.sections.length ? ` (section${call.sections.length === 1 ? '' : 's'} ${call.sections.map((t) => JSON.stringify(t)).join(', ')})` : '';
        io.log(`▶ ${where}${opts.name ? ` · ${opts.name}` : ''} · ${redact(shown)}${part} · ${resumed ? `continuing ${copyShown} (steps done there are kept)` : `copy ${copyShown}`}`);
        note(n, title, `runs ${redact(shown)}${part} as ${copyShown}`);
        const started = new Date();
        const ctl = new AbortController();
        const onAbort = (): void => ctl.abort();
        o.signal?.addEventListener('abort', onAbort, { once: true });
        let timedOut = false;
        const timer = opts.timeoutSeconds ? setTimeout(() => ((timedOut = true), ctl.abort()), opts.timeoutSeconds * 1000) : undefined;
        let child: RunSummary | undefined;
        let failure: string | undefined;
        try {
          child = await runRunbook(
            {
              ...o,
              file: copy,
              params,
              from: undefined,
              to: undefined,
              skipDone: resumed,
              sections: call.sections.length ? call.sections : undefined,
              session: undefined,
              signal: ctl.signal,
              progress: false,
              extraSecrets: [...known],
              callers: [...callers, target],
              stepPrefix: `${pre}${n}.`,
              inheritKubeContext: inheritKube,
              ...(signedRoot ? { signedRoot } : {}),
            },
            { out: io.out, log: (l) => io.log(`  ${l}`) },
          );
          fs.writeFileSync(copy, child.text, 'utf8');
          for (const s of child.steps) if (s.status === 'failed' || s.status === 'not run') failure ??= `step ${pre}${n}.${s.step} ${s.status === 'failed' ? 'failed' : 'not run'}: ${s.message ?? s.exit}`;
          const unticked = child.manual.filter((m) => !m.ticked).length;
          if (!child.ok && failure === undefined && unticked > 0) {
            failure = `${unticked} manual step${unticked === 1 ? '' : 's'} not ticked in ${copyShown}, which keeps evidence: tick ${unticked === 1 ? 'it' : 'them'} there and run the call again`;
          }
        } catch (e) {
          failure = e instanceof Error ? e.message : String(e);
        } finally {
          clearTimeout(timer);
          o.signal?.removeEventListener('abort', onAbort);
        }
        if (timedOut) failure = `timed out after ${opts.timeoutSeconds}s; the runbook called was stopped`;
        const ended = new Date();
        const count = (st: StepStatus): number => child?.steps.filter((s) => s.status === st).length ?? 0;
        const r = {
          runbook: shown,
          copy: copyShown,
          sha256: fileSha256(copy),
          done: count('passed'),
          skipped: count('skipped'),
          failed: count('failed'),
          notRun: count('not run'),
          manual: child?.manual.filter((m) => !m.ticked).length ?? 0,
        };
        const ok = child?.ok === true && !timedOut;
        const outText = callOutputText(r, call.sections) + (failure ? `[md-runbook] ${failure}\n` : '');
        const attrs: Record<string, string> = {
          exit: ok ? '0' : '1',
          ran: formatLocalIso(started),
          ended: formatLocalIso(ended),
          duration: formatDurationAttr(ended.getTime() - started.getTime()),
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...callAttrs(r),
          ...runnerAttrs(text, { by: runner(), on: `${runner()}@${os.hostname()}` }),
        };
        const meta = parse(text).cells[loc.cellIndex]?.meta;
        const previous = isCodeMeta(meta) ? loadedOutputEntry(meta) : undefined;
        const history = previous ? nextHistory(previous, isCodeMeta(meta) ? (meta.history?.entries ?? []) : [], historySizeFor(text, 0)) : [];
        text = setCellOutput(text, loc.cellIndex, { kind: 'new', text: redact(outText), attrs, ...(previous && history.length ? { previous, history } : {}) }, writeOpts) ?? text;
        note(n, title, `${ok ? 'done' : 'failed'}: ${formatCallSteps(r)}${failure ? ` (${redact(failure)})` : ''}`);
        io.log(`${ok ? '✓' : '✗'} Step ${pre}${n} · ${redact(shown)}: ${formatCallSteps(r)}${failure ? ` · ${redact(failure)}` : ''}`);
        finished.add(i);
        steps.push(
          result(ok ? 'passed' : 'failed', attrs.exit!, {
            durationMs: ended.getTime() - started.getTime(),
            output: redact(outText),
            call: { runbook: shown, copy: copyShown, sha256: r.sha256, steps: child?.steps ?? [], manual: child?.manual ?? [] },
            ...(ok ? {} : { message: redact(failure ?? 'the runbook called failed') }),
          }),
        );
        if (!ok && !opts.continueOnError && !o.keepGoing) stopped = true;
        if (o.signal?.aborted) stopped = true;
        continue;
      }
      if (!kind) continue;

      // Placeholders: values come from the command line and the environment, never from prompts.
      let env: Record<string, string> = { ...opts.env };
      let missing: string | undefined;
      const secretNames = new Set<string>();
      let refs: ReturnType<typeof findRefs>;
      let codeRefs: number;
      try {
        // The checks' references too (expect="${out:NAME}"), filled in below; only the code's go into the script.
        codeRefs = findRefs(loc.source).length;
        refs = cellRefs(loc.source, loc.info, fm);
      } catch (e) {
        notRun(e instanceof Error ? e.message : String(e), 'error');
        continue;
      }
      for (const ref of refs) {
        const v = lookup(ref);
        if ('missing' in v) {
          missing = v.missing;
          break;
        }
        env[ref.name] = v.value;
        if (v.secret) {
          addSecret(v.value);
          secretNames.add(ref.name);
        }
      }
      if (missing) {
        notRun(missing, 'error');
        continue;
      }
      let checks = opts.checks;
      // kube-context: ${param:NAME}: the parameter's value, recorded with the run (it isn't in the file).
      let kubeContext: string | undefined;
      const wantedContext = wantedKubeContext(opts, fm);
      try {
        if (checks) checks = resolveChecks(checks, env, (n) => secretNames.has(n));
        kubeContext = resolveKubeContext(wantedContext, (n) => env[n]);
      } catch (e) {
        notRun(e instanceof Error ? e.message : String(e), 'error');
        continue;
      }
      const contextFromParam = kubeContextParam(wantedContext) !== undefined ? kubeContext : undefined;
      // kube-context-mode: pin and git-bash-path-conversion: off add to the cell's environment; the
      // front matter's env: goes under the cell's own variables.
      const added = runbookEnv({ language: loc.language, frontMatter: fm, kubeContext, env: { ...process.env, ...fm?.env, ...env }, pins });
      env = withRunbookEnv(env, added);
      const source = codeRefs > 0 ? rewriteRefs(loc.source, kind) : loc.source;
      // A value captured as a secret is only known once the cell has finished: hold back the
      // output of such a cell and print it redacted afterwards (a CI log can't be redrawn).
      const holdOutput = (opts.checks?.captures ?? []).some((c) => c.secret);
      let held = '';
      const cwd = opts.cwd !== undefined ? path.resolve(mdDir, opts.cwd) : baseCwd;
      const timeoutS = opts.timeoutSeconds ?? fm?.timeoutSeconds ?? o.timeoutSeconds ?? 0;
      const attempts = opts.retry?.attempts ?? 1;

      const est = opts.estimateSeconds !== undefined ? ` · est. ${formatEstimate(opts.estimateSeconds)}` : '';
      io.log(`▶ ${where}${est}${opts.name ? ` · ${opts.name}` : ''}${contextFromParam ? ` · Kubernetes context ${contextFromParam}` : ''}`);
      const started = new Date();
      // Held like the live output when the step captures a secret: redacted once it is known.
      const entry = transcriptFile ? new TranscriptEntry((t) => transcriptFile.append(t), redact, holdOutput) : undefined;
      entry?.start({ at: started, runbook: fileName, step: n, line: loc.line + 1, section: sectionAt(loc.line), title: opts.name ?? firstLine, command: source });
      let attemptText = '';
      let stdout = '';
      let r: ExecuteResult;
      let outcome: CheckOutcome | undefined;
      let attempt = 0;
      // kube-context: the cluster is checked where the cell runs (its session shell), before it runs.
      const wrongCluster = fs.existsSync(cwd)
        ? await checkKubeContext(kubeContext, async (command) => {
            let out = '';
            let err = '';
            const probe = {
              language: loc.language,
              source: command,
              cwd,
              settings: fm?.shell ? { ...o.shell, runbook: fm.shell } : o.shell,
              timeoutMs: 15_000,
              env,
              signal: o.signal,
              onStdout: (t: string) => (out += t),
              onStderr: (t: string) => (err += t),
            };
            const p = pool ? await pool.execute({ ...probe, baseCwd }) : await executeCell(probe);
            return { exitCode: p.exitCode, stdout: out, stderr: p.error ?? (p.timedOut ? 'timed out' : err) };
          }, added.pinned)
        : undefined;
      if (wrongCluster !== undefined) {
        attempt = 1;
        r = { exitCode: null, signal: null, timedOut: false, cancelled: false, error: wrongCluster, durationMs: 0 };
      } else for (;;) {
        attempt++;
        if (attempt > 1) entry?.attempt(attempt, attempts, new Date());
        attemptText = '';
        stdout = '';
        held = '';
        const live = new LineBuffer((t) => (holdOutput ? (held += t) : io.out(t)), redact);
        const sink = (isOut: boolean) => (t: string) => {
          attemptText += t;
          if (isOut) stdout += t;
          live.write(t);
          entry?.out(isOut ? 'stdout' : 'stderr', t);
        };
        const exec = {
          language: loc.language,
          source,
          cwd,
          settings: fm?.shell ? { ...o.shell, runbook: fm.shell } : o.shell,
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
          hasChecks(checks) && r.exitCode !== null && r.error === undefined && !r.timedOut && !r.cancelled
            ? evaluateChecks(checks, r.exitCode, attemptText, stdout)
            : undefined;
        const passed = outcome ? outcome.ok : isSuccess(r);
        if (passed || attempt >= attempts || r.cancelled || o.signal?.aborted) break;
        const why = outcome?.failures[0] ?? (r.timedOut ? 'timed out' : (r.error ?? `exit code ${exitLabel(r)}`));
        const every = opts.retry?.everyMs ?? 0;
        io.log(`  attempt ${attempt}/${attempts} failed (${redact(why)}); trying again in ${every / 1000}s`);
        entry?.out('stderr', `[md-runbook] attempt ${attempt}/${attempts} failed (${why}); trying again in ${every / 1000}s\n`);
        if (!(await sleep(every, o.signal))) break;
      }
      // Secrets that matched are known now (even if another capture failed): print what was held back.
      for (const v of outcome?.secretValues ?? []) addSecret(v);
      if (holdOutput) io.out(redact(held));
      const add = (line: string): void => {
        attemptText += line;
        io.out(redact(line));
        entry?.out('stderr', line);
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
        ...(contextFromParam ? { 'kube-context': contextFromParam } : {}),
        // Who and where, when the runbook keeps evidence (incident:, evidence: true).
        ...runnerAttrs(text, { by: runner(), on: `${runner()}@${os.hostname()}` }),
      };
      // Earlier runs are kept only while the runbook keeps evidence (every attempt, as the clients do).
      const meta = parse(text).cells[loc.cellIndex]?.meta;
      const previous = isCodeMeta(meta) ? loadedOutputEntry(meta) : undefined;
      const history = previous ? nextHistory(previous, isCodeMeta(meta) ? (meta.history?.entries ?? []) : [], historySizeFor(text, 0)) : [];
      text =
        setCellOutput(text, loc.cellIndex, { kind: 'new', text: attemptText, attrs, ...(previous && history.length ? { previous, history } : {}) }, writeOpts) ??
        text;
      const ok = outcome ? outcome.ok : isSuccess(r);
      entry?.end({ exit, durationMs: ended.getTime() - started.getTime(), ...(check ? { check } : {}), ...(attempts > 1 ? { attempt, attempts } : {}) });
      transcriptFile?.flush();
      // Without ran/ended: "5m ago" means nothing in a terminal.
      const { ran: _ran, ended: _ended, ...shown } = attrs;
      io.log(`${outputSummary(shown)}${r.shell ? ` · ${r.shell.label}` : ''}`);
      const tookS = (ended.getTime() - started.getTime()) / 1000;
      // A warning, not a failure: the estimate may be old, or the machine slow today.
      if (opts.estimateSeconds !== undefined && isOverEstimate(tookS, opts.estimateSeconds)) {
        io.log(`! Step ${pre}${n} took ${formatEstimate(tookS)}, more than twice its estimate of ${formatEstimate(opts.estimateSeconds)}`);
      }
      finished.add(i);
      const line = o.progress ? progressLine() : undefined;
      if (line) io.log(`  ${line}`);
      steps.push(result(ok ? 'passed' : 'failed', exit, { durationMs: ended.getTime() - started.getTime(), output: redact(attemptText), ...(ok ? {} : { message: outcome?.failures[0] ?? `exit ${exit}` }) }));
      if (!ok && !opts.continueOnError && !o.keepGoing) stopped = true;
      if (o.signal?.aborted) stopped = true;
    }
  } finally {
    transcriptFile?.flush();
    pool?.dispose();
    pins.dispose();
  }

  listManual(locs.length - 1);
  // A runbook that keeps evidence must not pass over a check nobody did.
  const unticked = manual.filter((m) => !m.ticked);
  const evidence = parsedFm?.evidence === true;
  if (unticked.length > 0) {
    const n = unticked.length;
    io.log(
      evidence
        ? `✗ ${n} manual step${n === 1 ? '' : 's'} not ticked, and this runbook keeps evidence: tick ${n === 1 ? 'it' : 'them'} (- [x]) once done, and run again`
        : `☐ ${n} manual step${n === 1 ? '' : 's'} not ticked`,
    );
  }
  const ok = steps.every((s) => s.status === 'passed' || s.status === 'skipped') && !(evidence && unticked.length > 0);
  return { steps, manual: manual.map(({ after: _after, ...m }) => ({ ...m, text: redact(m.text) })), text, ok, redact };
}

const xml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** The steps with the steps of their runbook calls after each call, numbered 5.1, 5.2, … (`5.1` as the step). */
export function flattenSteps(steps: readonly StepResult[], prefix = ''): (StepResult & { number: string; file?: string })[] {
  return steps.flatMap((s) => [
    { ...s, number: `${prefix}${s.step}` },
    ...(s.call ? flattenSteps(s.call.steps, `${prefix}${s.step}.`).map((c) => ({ ...c, file: c.file ?? s.call!.copy })) : []),
  ]);
}

/** The manual steps of a run and of its calls (with the file they are in), unticked first in order. */
export function allManual(file: string, top: readonly StepResult[], manual: readonly ManualStep[]): (ManualStep & { file: string })[] {
  return [...manual.map((m) => ({ ...m, file })), ...top.flatMap((s) => (s.call ? allManual(s.call.copy, s.call.steps, s.call.manual) : []))];
}

/** JUnit XML, which most CI systems show as a test report. */
export function junitReport(file: string, top: readonly StepResult[], manual: readonly ManualStep[] = []): string {
  // A runbook call's steps are test cases too, after the call, with the copy as their class.
  const steps = flattenSteps(top);
  // Manual steps: passed when ticked, skipped otherwise (nothing ran them).
  const manualCases = allManual(file, top, manual).map((m) => {
    const head = `    <testcase classname="${xml(m.file)}" name="${xml(`Manual (line ${m.line + 1}): ${m.text}`)}" time="0.000">`;
    return m.ticked ? `${head}</testcase>` : `${head}<skipped message="manual step, not ticked"/></testcase>`;
  });
  const failures = steps.filter((s) => s.status === 'failed' || s.status === 'not run').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length + manualCases.filter((c) => c.includes('<skipped')).length;
  const time = (ms: number): string => (ms / 1000).toFixed(3);
  const total = top.reduce((t, s) => t + s.durationMs, 0);
  const cases = steps.map((s) => {
    const name = xml(`Step ${s.number}: ${s.title}`);
    // The estimate as a property of the test case (as pytest's record_property writes them).
    const props = s.estimateSeconds !== undefined ? `<properties><property name="estimate" value="${s.estimateSeconds}"/></properties>` : '';
    const head = `    <testcase classname="${xml(s.file ?? file)}" name="${name}" time="${time(s.durationMs)}">${props}`;
    if (s.status === 'passed') return `${head}</testcase>`;
    if (s.status === 'skipped') return `${head}<skipped message="${xml(s.message ?? 'skipped')}"/></testcase>`;
    return `${head}\n      <failure message="${xml(s.message ?? s.exit)}">${xml(s.output)}</failure>\n    </testcase>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites>\n  <testsuite name="${xml(file)}" tests="${steps.length + manualCases.length}" failures="${failures}" skipped="${skipped}" time="${time(total)}">\n` +
    [...cases, ...manualCases].join('\n') +
    '\n  </testsuite>\n</testsuites>\n'
  );
}

/** A Markdown table of the steps, e.g. for GitHub's job summary ($GITHUB_STEP_SUMMARY). */
export function markdownSummary(file: string, top: readonly StepResult[], manual: readonly ManualStep[] = []): string {
  const steps = flattenSteps(top);
  const icon: Record<StepStatus, string> = { passed: '✅', failed: '❌', skipped: '⏭️', 'not run': '⛔' };
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const rows = steps.map((s) => `| ${s.number} | ${icon[s.status]} ${s.status} | \`${cell(s.title).slice(0, 80)}\` | ${cell(s.exit)} | ${(s.durationMs / 1000).toFixed(1)}s${s.estimateSeconds !== undefined ? ` (est. ${formatEstimate(s.estimateSeconds)})` : ''} | ${cell(s.message ?? '')} |`);
  const passed = steps.filter((s) => s.status === 'passed').length;
  const manualAll = allManual(file, top, manual);
  const manualRows = manualAll.map((m) => `| – | ${m.ticked ? '☑ ticked' : '☐ not ticked'} | ${cell(m.text).slice(0, 80)} | manual | – | ${cell(m.file)}:${m.line + 1} |`);
  const unticked = manualAll.filter((m) => !m.ticked).length;
  return (
    `### ${cell(file)}: ${passed}/${steps.length} steps passed${unticked ? `, ${unticked} manual step${unticked === 1 ? '' : 's'} not ticked` : ''}\n\n` +
    `| Step | Result | Command | Exit | Time | Note |\n|---|---|---|---|---|---|\n${[...rows, ...manualRows].join('\n')}\n`
  );
}

/** In a run copy, the number of the first step not done (in `sections`, when given); undefined when all are. */
export function firstStepNotDone(text: string, sections: readonly string[] = []): number | undefined {
  const doc = parse(text);
  const osCells = doc.cells.map((c) => (c.kind === 'code' ? { kind: 'code' as const, os: parseCellOptions(c.meta.kind === 'code' ? c.meta.info : '').os } : { kind: 'markup' as const }));
  const slots = osGroups(osCells);
  const numberOf = stepNumbers(osCells);
  const inPart = sections.length ? inSections(sectionHeadings(text), sections) : () => true;
  for (const loc of locateCodeCells(doc)) {
    const slot = slots[loc.cellIndex];
    if ((slot && !slot.active) || !inPart(loc.line) || parseCellOptions(loc.info).skip) continue;
    const a = loc.outputAttrs;
    const state = stepState(a?.exit, a?.lines !== undefined, a?.check);
    if (state !== 'done' && state !== 'skipped') return numberOf[loc.cellIndex];
  }
  return undefined;
}

/** The OS user running the command line, for by= and on=. */
function runner(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

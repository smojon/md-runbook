/**
 * Run one cell of a runbook on a host and put its output block into the runbook text, the way
 * the extension does: the same attributes (`exit`, `ran`, `ended`, `duration`, `check`), the
 * same cleaning, redaction and truncation (the core writer), so the file stays the one format.
 */
import {
  DEFAULT_PATTERNS,
  REDACTED,
  DEFAULT_WRITE_OPTIONS,
  createRedactor,
  exitLabel,
  formatDurationAttr,
  formatLocalIso,
  outputSummary,
  parse,
  setCellOutput,
} from '@md-runbook/core';
import { evaluateChecks } from '@md-runbook/core/checks';
import { rewriteRefs } from '@md-runbook/core/secrets';
import { signedStatus, signedStepIndex } from '@md-runbook/core/signing';
import { echoCommand, formatLineRange, formatLineRanges } from '@md-runbook/core/steps';
import type { RemoteRunOptions, SessionRunResult, SignedRun } from '@md-runbook/ssh';
import type { Host } from '../hosts/store';
import { checkParam, refsOf, runbookParams } from '../runbooks/params';
import { readSecret } from '../secrets/store';
import { t } from '../i18n';
import { runnability } from './cells';
import { Connection, connectionFor } from './connections';
import type { LinePlan } from './lineRuns';

/** A cell without `timeout=` is stopped after this long. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export type RunOutcome =
  /** The cell ran (or failed): `text` is the runbook with the new output block. */
  | { kind: 'done'; text: string; result: SessionRunResult; attrs: Record<string, string>; summary: string }
  /** The server's key is not trusted yet (or changed): nothing was sent; ask, pin, run again. */
  | { kind: 'trust'; hostKey: string; changed: boolean }
  /** Nothing ran: the cell needs secrets or inputs that are not there yet; ask, then run again. */
  | { kind: 'needs'; needs: NeededValue[] }
  /** Nothing ran: the cell can't run here, or the connection failed. */
  | { kind: 'error'; message: string };

/** A `${secret:NAME}` that isn't stored, or an `${input:NAME}` not typed yet. */
export interface NeededValue {
  kind: 'secret' | 'input';
  name: string;
  /** Typed masked, and redacted from the output. */
  masked: boolean;
}

export interface RunCellParams {
  host: Host;
  /** The whole runbook. */
  text: string;
  cellIndex: number;
  signal?: AbortSignal;
  /** Output as it arrives (stdout and stderr in order of arrival). */
  onOutput?(text: string): void;
  /** Run only these commands of the cell (a line run), one after another, stopping at the first failure. */
  lines?: LinePlan;
  /** A line run starts command `index` of `lines.steps`, or (undefined) is over. */
  onStep?(index: number | undefined): void;
  /** Called before command `index` of a line run; resolves false to stop before it (Step Through). */
  beforeStep?(index: number): Promise<boolean>;
  /**
   * The runbook as it is when the run ends (other edits, e.g. a ticked task box, happened meanwhile):
   * the output block goes into that text. Default: `text`.
   */
  latestText?(): string;
  /** Values typed for the runbook's `${param:NAME}` (else the front matter's defaults are used). */
  params?: Record<string, string>;
  /** Values typed for `${input:NAME}` while the runbook is open. */
  inputs?: Record<string, string>;
  /** A stored secret's value (default: the secure store). */
  readSecret?(name: string): Promise<string | undefined>;
  /** Tests: a connection instead of the host's real one. */
  connection?: Connection;
}

const redactor = createRedactor(DEFAULT_PATTERNS);

export async function runCell(p: RunCellParams): Promise<RunOutcome> {
  const cell = parse(p.text).cells[p.cellIndex];
  if (!cell) return { kind: 'error', message: t.cellGone };
  const can = runnability(cell);
  if (!can.ok) return { kind: 'error', message: t.notRunnable[can.why](can.detail) };
  const opts = can.options;

  // Placeholders become environment variables, as in the extension: a value is never part of the
  // script. ${param:} comes from the Parameters card, ${secret:} from the secure store, ${input:}
  // from what was typed for this runbook; ${out:} (a captured value) isn't supported yet.
  const refs = refsOf(cell.value);
  const out = refs.find((r) => r.kind === 'out');
  if (out) return { kind: 'error', message: t.refUnsupported(out.kind, out.name) };
  const specs = refs.some((r) => r.kind === 'param') ? runbookParams(p.text) : [];
  const paramEnv: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  /** Values to redact as exact matches, longest first (a secret containing another goes whole). */
  const known: string[] = [];
  const needs: NeededValue[] = [];
  for (const ref of refs) {
    if (ref.kind === 'secret' || ref.kind === 'input') {
      const value = ref.kind === 'secret' ? await (p.readSecret ?? readSecret)(ref.name) : p.inputs?.[ref.name];
      if (value === undefined) needs.push({ kind: ref.kind, name: ref.name, masked: ref.secret });
      else {
        secretEnv[ref.name] = value;
        if (ref.secret && value.length >= 4) known.push(value);
      }
      continue;
    }
    const spec = specs.find((s) => s.name === ref.name) ?? { name: ref.name };
    const typed = p.params?.[ref.name];
    const value = typed !== undefined && typed !== '' ? typed : spec.default;
    if (value === undefined) return { kind: 'error', message: t.paramMissing(ref.name) };
    const bad = checkParam(spec, value);
    if (bad)
      return { kind: 'error', message: bad === 'newline' ? t.paramNewline(ref.name) : t.paramMismatch(ref.name, spec.pattern ?? '') };
    paramEnv[ref.name] = value;
  }
  if (needs.length > 0) return { kind: 'needs', needs };
  known.sort((a, b) => b.length - a.length);
  const hideKnown = (text: string): string => known.reduce((s, v) => s.split(v).join(REDACTED), text);
  const asRun = (source: string): string => (refs.length > 0 ? rewriteRefs(source, 'bash') : source);

  let conn: Connection;
  try {
    conn = p.connection ?? (await connectionFor(p.host));
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  conn.unknownHostKey = undefined;

  const started = new Date();
  let transcript = '';
  let stdout = '';
  const write = (text: string): void => {
    transcript += text;
    p.onOutput?.(hideKnown(text));
  };
  const runOpts: RemoteRunOptions = {
    env: { ...opts.env, ...paramEnv, ...secretEnv },
    cwd: opts.cwd,
    timeoutMs: opts.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutSeconds * 1000,
    signal: p.signal,
    onStdout: (text) => {
      stdout += text;
      write(text);
    },
    onStderr: write,
  };
  // A signed cell goes to md-runbook-gate as its number in the manifest (where the host runs the
  // gate; elsewhere it runs as usual). A changed cell, or a command that isn't one of the signed
  // ones, goes as plain text, which a gate that only runs signed cells refuses.
  const status = signedStatus(p.text);
  const signedCell = status?.cells.get(p.cellIndex);
  const signed = (stepText?: string): SignedRun | undefined => {
    if (!status || !signedCell) return undefined;
    const params = Object.fromEntries(signedCell.needs.map((n) => [n, paramEnv[n] ?? '']));
    const base = { manifest: status.block.manifest, signature: status.block.signature, cell: signedCell.n, params };
    if (stepText === undefined) return base;
    const step = signedStepIndex(signedCell, stepText);
    return step < 0 ? undefined : { ...base, step };
  };
  let result: SessionRunResult;
  /** Steps of a line run that ran (indexes into p.lines.steps). */
  const ran: number[] = [];
  try {
    if (!p.lines) result = await conn.session.run(asRun(cell.value), runOpts, signed());
    else {
      result = { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 0 };
      const steps = p.lines.steps;
      for (let i = 0; i < steps.length; i++) {
        // Step through: wait for the user before the next command; false stops the run here
        // (what ran so far is the result, as in the extension).
        if (p.beforeStep && !(await p.beforeStep(i))) break;
        if (p.signal?.aborted) {
          result = { ...result, exitCode: null, cancelled: true };
          break;
        }
        p.onStep?.(i);
        write(echoCommand('bash', steps[i]!.text));
        const r = await conn.session.run(asRun(steps[i]!.text), runOpts, signed(steps[i]!.text));
        ran.push(i);
        result = { ...r, durationMs: result.durationMs + r.durationMs, newShell: result.newShell || r.newShell };
        if (r.exitCode !== 0) {
          if (i < steps.length - 1 && !r.cancelled && !r.timedOut)
            write(t.lineFailedNote(formatLineRange(steps[i]!.start, steps[i]!.end)) + '\n');
          break;
        }
      }
    }
  } catch (e) {
    p.onStep?.(undefined);
    if (conn.unknownHostKey) return { kind: 'trust', hostKey: conn.unknownHostKey, changed: conn.changed ?? false };
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }

  p.onStep?.(undefined);
  if (result.error !== undefined) write(result.error + '\n');
  if (result.timedOut) write(t.timedOutNote(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) + '\n');
  const ended = new Date();
  const attrs: Record<string, string> = {
    exit: exitLabel(result),
    ran: formatLocalIso(started),
    ended: formatLocalIso(ended),
    duration: formatDurationAttr(ended.getTime() - started.getTime()),
  };
  if (opts.checks && result.exitCode !== null && !result.timedOut && !result.cancelled) {
    const outcome = evaluateChecks(opts.checks, result.exitCode, transcript, stdout);
    attrs.check = outcome.ok ? 'ok' : 'failed';
    for (const f of outcome.failures) write(t.checkFailedNote(f) + '\n');
  }
  // `lines=` when a line run did not run every command of the cell (as the extension writes it).
  if (p.lines && !(p.lines.coversCell && ran.length === p.lines.steps.length)) {
    const picked = ran.length > 0 ? ran.map((i) => p.lines!.steps[i]!) : p.lines.steps;
    attrs.lines = formatLineRanges(picked);
  }
  const base = p.latestText?.() ?? p.text;
  if (parse(base).cells[p.cellIndex]?.value !== cell.value) return { kind: 'error', message: t.cellChanged };
  const text =
    setCellOutput(
      base,
      p.cellIndex,
      { kind: 'new', text: transcript, attrs },
      { ...DEFAULT_WRITE_OPTIONS, redact: (s) => redactor.redact(hideKnown(s)) },
    ) ?? base;
  return { kind: 'done', text, result, attrs, summary: outputSummary(attrs, ended) };
}

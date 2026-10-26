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
  isCodeMeta,
  loadedOutputEntry,
  nextHistory,
  outputSummary,
  parse,
  setCellOutput,
  markStderr,
} from '@md-runbook/core';
import { Captured, evaluateChecks } from '@md-runbook/core/checks';
import { approvalScope } from '@md-runbook/core/policy';
import { proposalOf } from '@md-runbook/core/proposal';
import { parseFrontMatter, rewriteRefs } from '@md-runbook/core/secrets';
import { signedStatus, signedStepIndex } from '@md-runbook/core/signing';
import { LineStep, echoCommand, formatLineRange, formatLineRanges, splitSteps } from '@md-runbook/core/steps';
import { RemoteRunOptions, SessionRunResult, SignedRun, wrongPlatform } from '@md-runbook/ssh';
import { Host, hostLabel, setHostPlatform } from '../hosts/store';
import { checkParam, refsOf, runbookParams } from '../runbooks/params';
import { readSecret } from '../secrets/store';
import { historySize, outputSettings, signerName } from '../settings/store';
import { historySizeFor, runnerAttrs } from '@md-runbook/core/incident';
import { t } from '../i18n';
import { runnability } from './cells';
import { Connection, connectionFor } from './connections';
import type { LinePlan } from './lineRuns';

/** A cell without `timeout=` is stopped after this long. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export type RunOutcome =
  /** The cell ran (or failed): `text` is the runbook with the new output block. */
  | { kind: 'done'; text: string; result: SessionRunResult; attrs: Record<string, string>; summary: string; captured: Captured[] }
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
  /** The runbook's id in the app: proposals approved on this device for it can run. */
  runbookId?: string;
  /** Values typed for the runbook's `${param:NAME}` (else the front matter's defaults are used). */
  params?: Record<string, string>;
  /** Values typed for `${input:NAME}` while the runbook is open. */
  inputs?: Record<string, string>;
  /** Earlier runs to keep in the file (default: the app setting). */
  historySize?: number;
  /** Values earlier cells captured this session (capture=), for . */
  captures?: Readonly<Record<string, Captured>>;
  /** A stored secret's value (default: the secure store). */
  readSecret?(name: string): Promise<string | undefined>;
  /** Tests: a connection instead of the host's real one. */
  connection?: Connection;
}

const redactor = createRedactor(DEFAULT_PATTERNS);

export async function runCell(p: RunCellParams): Promise<RunOutcome> {
  const cell = parse(p.text).cells[p.cellIndex];
  if (!cell) return { kind: 'error', message: t.cellGone };
  const shells = parseFrontMatter(p.text)?.shell;
  const can = runnability(cell, p.runbookId === undefined ? undefined : approvalScope(p.runbookId, shells), p.host.platform);
  if (!can.ok) return { kind: 'error', message: t.notRunnable[can.why](can.detail) };
  const opts = can.options;
  // bash on Linux and macOS servers; PowerShell and cmd on Windows ones.
  const kind = can.shell;

  // Placeholders become environment variables, as in the extension: a value is never part of the
  // script. ${param:} comes from the Parameters card, ${secret:} from the secure store, ${input:}
  // from what was typed for this runbook, ${out:} from an earlier cell's capture= this session.
  const refs = refsOf(cell.value);
  const byAssistant = isCodeMeta(cell.meta) && proposalOf(cell.meta.info).by !== undefined;
  const specs = refs.some((r) => r.kind === 'param') ? runbookParams(p.text) : [];
  // A signed cell goes to md-runbook-gate as its number in the manifest (where the host runs the
  // gate; elsewhere it runs as usual). A changed cell, or a command that isn't one of the signed
  // ones, goes as plain text, which a gate that only runs signed cells refuses.
  const status = signedStatus(p.text);
  const signedCell = status?.cells.get(p.cellIndex);
  const paramEnv: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  /** Values to redact as exact matches, longest first (a secret containing another goes whole). */
  const known: string[] = [];
  const needs: NeededValue[] = [];
  for (const ref of refs) {
    if (ref.kind === 'out') {
      const c = p.captures?.[ref.name];
      if (!c) return { kind: 'error', message: t.outMissing(ref.name) };
      // An assistant cell's output must not steer a cell of yours; an assistant cell gets no secret value.
      if (c.fromAssistant && !byAssistant) return { kind: 'error', message: t.outFromAssistant(ref.name) };
      if (c.secret && byAssistant) return { kind: 'error', message: t.outSecretForAssistant(ref.name) };
      secretEnv[ref.name] = c.value;
      if (c.secret && c.value.length >= 4) known.push(c.value);
      continue;
    }
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
    // The front matter isn't signed: a signed cell doesn't take its default (anyone could change
    // staging to prod there); the value is typed on the Parameters card.
    const value = typed !== undefined && typed !== '' ? typed : signedCell ? undefined : spec.default;
    if (value === undefined)
      return {
        kind: 'error',
        message: signedCell && spec.default !== undefined ? t.paramSignedDefault(ref.name, spec.default) : t.paramMissing(ref.name),
      };
    const bad = checkParam(spec, value);
    if (bad)
      return { kind: 'error', message: bad === 'newline' ? t.paramNewline(ref.name) : t.paramMismatch(ref.name, spec.pattern ?? '') };
    paramEnv[ref.name] = value;
  }
  if (needs.length > 0) return { kind: 'needs', needs };
  // A signed cell's inputs and captured values must match their signed patterns, as parameters do
  // (the gate checks again): say so here rather than with the gate's refusal.
  for (const n of signedCell?.needs ?? []) {
    const value = paramEnv[n] ?? secretEnv[n];
    const pattern = status?.manifest.patterns[n];
    if (value === undefined || pattern === undefined || paramEnv[n] !== undefined) continue;
    const bad = checkParam({ name: n, pattern }, value);
    if (bad) return { kind: 'error', message: bad === 'newline' ? t.paramNewline(n) : t.paramMismatch(n, pattern) };
  }
  known.sort((a, b) => b.length - a.length);
  const hideKnown = (text: string): string => known.reduce((s, v) => s.split(v).join(REDACTED), text);
  const asRun = (source: string): string => (refs.length > 0 ? rewriteRefs(source, kind) : source);

  let conn: Connection;
  try {
    // The runbook's `shell:` picks the server's shell (zsh, sh; PowerShell 7), as in the extension.
    conn = p.connection ?? (await connectionFor(p.host, p.runbookId ?? '', shells));
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  conn.unknownHostKey = undefined;
  // Secrets an earlier cell exported stay readable in this runbook's shell: redact those too.
  for (const v of conn.secrets ?? []) if (!known.includes(v)) known.push(v);
  for (const v of known) conn.secrets?.add(v);
  known.sort((a, b) => b.length - a.length);

  const started = new Date();
  let transcript = '';
  // The same with stderr lines marked: what the file gets (stderr=) and the screen shows in red.
  let saved = '';
  let stdout = '';
  const write = (text: string, stream: 'stdout' | 'stderr'): void => {
    transcript += text;
    const shown = stream === 'stderr' ? markStderr(text) : text;
    saved += shown;
    p.onOutput?.(hideKnown(shown));
  };
  // Settings → Force colours: programs colour their output although it isn't a terminal.
  const forced: Record<string, string> = outputSettings().forceColor ? { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' } : {};
  const runOpts: RemoteRunOptions = {
    shell: kind,
    // An approved proposal was checked as bash, or as zsh with `shell: zsh` (the approval's rules).
    ...(byAssistant && kind === 'bash' ? { checkedAs: shells?.unix === 'zsh' ? ('zsh' as const) : ('bash' as const) } : {}),
    env: { ...forced, ...opts.env, ...paramEnv, ...secretEnv },
    cwd: opts.cwd,
    timeoutMs: opts.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutSeconds * 1000,
    signal: p.signal,
    onStdout: (text) => {
      stdout += text;
      write(text, 'stdout');
    },
    onStderr: (text) => write(text, 'stderr'),
  };
  // A command's position among the cell's commands tells repeated ones apart (two `sleep 5`).
  const cellSteps = signedCell ? splitSteps(cell.value, 'bash') : [];
  const signed = (step?: LineStep): SignedRun | undefined => {
    if (!status || !signedCell) return undefined;
    // Every value the signed cell uses: ${param:}, ${input:} and ${out:} (the gate checks each against its signed pattern).
    const params = Object.fromEntries(signedCell.needs.map((n) => [n, paramEnv[n] ?? secretEnv[n] ?? '']));
    const cosignatures = (status.block.cosigners ?? []).map((c) => c.signature);
    const base = {
      manifest: status.block.manifest,
      signature: status.block.signature,
      ...(cosignatures.length ? { cosignatures } : {}),
      cell: signedCell.n,
      params,
    };
    if (step === undefined) return base;
    const k = signedStepIndex(
      signedCell,
      step.text,
      cellSteps.findIndex((s) => s.start === step.start),
    );
    return k < 0 ? undefined : { ...base, step: k };
  };
  let result: SessionRunResult;
  /** Steps of a line run that ran (indexes into p.lines.steps). */
  const ran: number[] = [];
  try {
    // The first connection tells what the server runs; a cell for the other kind doesn't run.
    await conn.session.connect();
    const platform = conn.session.platform;
    if (platform) {
      if (p.host.platform !== platform) setHostPlatform(p.host.id, platform);
      const wrong = wrongPlatform(platform, kind);
      if (wrong) return { kind: 'error', message: wrong };
    }
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
        write(echoCommand(kind, steps[i]!.text), 'stdout');
        const r = await conn.session.run(asRun(steps[i]!.text), runOpts, signed(steps[i]!));
        ran.push(i);
        result = { ...r, durationMs: result.durationMs + r.durationMs, newShell: result.newShell || r.newShell };
        if (r.exitCode !== 0) {
          if (i < steps.length - 1 && !r.cancelled && !r.timedOut)
            write(t.lineFailedNote(formatLineRange(steps[i]!.start, steps[i]!.end)) + '\n', 'stderr');
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
  if (result.error !== undefined) write(result.error + '\n', 'stderr');
  if (result.timedOut) write(t.timedOutNote(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_MS / 1000) + '\n', 'stderr');
  const ended = new Date();
  const attrs: Record<string, string> = {
    exit: exitLabel(result),
    ran: formatLocalIso(started),
    ended: formatLocalIso(ended),
    duration: formatDurationAttr(ended.getTime() - started.getTime()),
    // Who and where, when the runbook keeps evidence (incident:, evidence: true): the name this app
    // signs with, and the account it ran as.
    ...runnerAttrs(p.text, { ...(signerName() ? { by: signerName() } : {}), on: hostLabel(p.host) }),
  };
  let captured: Captured[] = [];
  if (opts.checks && result.exitCode !== null && !result.timedOut && !result.cancelled) {
    const outcome = evaluateChecks(opts.checks, result.exitCode, transcript, stdout);
    attrs.check = outcome.ok ? 'ok' : 'failed';
    for (const f of outcome.failures) write(t.checkFailedNote(f) + '\n', 'stderr');
    // capture=: kept for later cells' ${out:NAME}; capture-secret= values are redacted from here on.
    captured = outcome.captured.map((c) => ({ ...c, fromAssistant: byAssistant }));
    for (const v of outcome.secretValues) {
      if (v.length < 4) continue;
      known.push(v);
      conn.secrets?.add(v);
    }
    known.sort((a, b) => b.length - a.length);
  }
  // `lines=` when a line run did not run every command of the cell (as the extension writes it).
  if (p.lines && !(p.lines.coversCell && ran.length === p.lines.steps.length)) {
    const picked = ran.length > 0 ? ran.map((i) => p.lines!.steps[i]!) : p.lines.steps;
    attrs.lines = formatLineRanges(picked);
  }
  const base = p.latestText?.() ?? p.text;
  const meta = parse(base).cells[p.cellIndex]?.meta;
  const previous = isCodeMeta(meta) ? loadedOutputEntry(meta) : undefined;
  const older = isCodeMeta(meta) ? (meta.history?.entries ?? []) : [];
  if (parse(base).cells[p.cellIndex]?.value !== cell.value) return { kind: 'error', message: t.cellChanged };
  const text =
    setCellOutput(
      base,
      p.cellIndex,
      // As the extension writes it: changed=yes|no against the output it replaces, and the earlier
      // runs kept after it when history is on.
      {
        kind: 'new',
        text: saved,
        attrs,
        ...(previous ? { previous } : {}),
        history: nextHistory(previous, older, historySizeFor(base, p.historySize ?? historySize())),
      },
      { ...DEFAULT_WRITE_OPTIONS, redact: (s) => redactor.redact(hideKnown(s)) },
    ) ?? base;
  return { kind: 'done', text, result, attrs, summary: outputSummary(attrs, ended), captured };
}

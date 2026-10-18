/** NotebookController: runs code cells through the core executor and streams their output. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExecuteResult, HISTORY_KEY, LineBuffer, isRunHistory, SUPPORTED_LANGUAGE_IDS, exitLabel, formatDurationAttr, formatLocalIso, isSuccess, shellKindForLanguage } from './core';
import { CheckOutcome, evaluateChecks, hasChecks } from './core/checks';
import { SessionPool } from './core/session';
import { LineStep, echoCommand, formatLineRange } from './core/steps';
import { FrontMatter, parseFrontMatter } from './core/secrets';
import { ExecutionConfig, executionConfig, redactionConfig } from './config';
import { META_KEY, OutputMetadata, earlierRuns, earlierRunsOutput, statusLine, statusOutput } from './outputs';
import { CellPlan, ExecuteIO, PrepareContext, RunPipeline, RunRecord } from './pipeline';
import { copyOrigin } from './copyOrigins';
import { knownSecrets } from './knownSecrets';
import { NOTEBOOK_TYPE } from './serializer';

const FLUSH_MS = 100;

type Chunk = { stream: 'stdout' | 'stderr'; text: string };

/** Merge consecutive chunks of the same stream into output items. */
function toItems(chunks: readonly Chunk[]): vscode.NotebookCellOutputItem[] {
  const merged: Chunk[] = [];
  for (const c of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.stream === c.stream) last.text += c.text;
    else merged.push({ ...c });
  }
  return merged.map((c) =>
    c.stream === 'stdout' ? vscode.NotebookCellOutputItem.stdout(c.text) : vscode.NotebookCellOutputItem.stderr(c.text),
  );
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function workingDirectory(uri: vscode.Uri): string {
  // A Run All as Copy copy made in another folder runs in the original runbook's folder.
  const origin = copyOrigin(uri);
  if (origin !== undefined) return origin;
  if (uri.scheme === 'file') return path.dirname(uri.fsPath);
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

/** The runbook's front matter (its first cell, when that is Markdown). */
export function frontMatterOf(nb: vscode.NotebookDocument): FrontMatter | undefined {
  const first = nb.cellCount > 0 ? nb.cellAt(0) : undefined;
  return first?.kind === vscode.NotebookCellKind.Markup ? parseFrontMatter(first.document.getText()) : undefined;
}

/** Where the runbook's cells run: its `cwd:` (relative to the .md file's folder), else that folder. */
export function runbookCwd(nb: vscode.NotebookDocument): string {
  const base = workingDirectory(nb.uri);
  const cwd = frontMatterOf(nb)?.cwd;
  return cwd ? path.resolve(base, cwd) : base;
}

export const CONTROLLER_ID = 'md-runbook-shell';

/** A run of some lines of one cell: Run Line or Selection, Run Lines One by One, Step Through. */
export interface LineRun {
  /** The lines the steps come from: what preparers (confirmation, secrets) see as the source. */
  source: string;
  /** Commands run one after another in one shell, stopping at the first that fails. */
  steps: readonly LineStep[];
  /** The steps are every command of the cell: running all of them is a full run (no `lines=`). */
  coversCell: boolean;
  /** Called before each step after the first; resolves false to stop there (Step Through). */
  beforeStep?(index: number, token: vscode.CancellationToken): Promise<boolean>;
  /** Step `index` starts, or (undefined) the run is over. */
  onStep?(index: number | undefined): void;
}

/** `lines=` for a line run that did not run every command of the cell, else undefined. */
function linesAttr(run: LineRun, ran: readonly number[]): string | undefined {
  if (run.coversCell && ran.length === run.steps.length) return undefined;
  const picked = ran.length > 0 ? ran.map((i) => run.steps[i]!) : run.steps;
  const first = picked[0];
  const last = picked[picked.length - 1];
  return first && last ? formatLineRange(first.start, last.end) : undefined;
}

export class RunbookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private executionOrder = 0;
  /** Per-notebook queue so cells of one runbook never run concurrently. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly pipeline: RunPipeline = new RunPipeline()) {
    this.controller = vscode.notebooks.createNotebookController(CONTROLLER_ID, NOTEBOOK_TYPE, 'md-runbook shell');
    this.controller.description = 'sh/bash, pwsh/powershell, cmd';
    this.controller.supportedLanguages = [...SUPPORTED_LANGUAGE_IDS];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.enqueue(cells, notebook);
  }

  /** Run some lines of a cell, queued after the runbook's other runs like a normal run. */
  runLines(cell: vscode.NotebookCell, run: LineRun): Promise<void> {
    return this.enqueue([cell], cell.notebook, run);
  }

  dispose(): void {
    this.controller.dispose();
  }

  /**
   * Record an outcome without running the cell (e.g. a step marked done by hand). `attrs` are
   * the marker attributes persisted on save; `text` becomes the output text.
   */
  async recordManual(cell: vscode.NotebookCell, attrs: Record<string, string>, text: string, success?: boolean): Promise<void> {
    // The run history kept from an earlier run belongs to the output being replaced here; leaving
    // it would write a stale changed=/history on save.
    if (cell.metadata?.[HISTORY_KEY] !== undefined) {
      const metadata: Record<string, unknown> = { ...cell.metadata };
      delete metadata[HISTORY_KEY];
      const edit = new vscode.WorkspaceEdit();
      edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, metadata)]);
      await vscode.workspace.applyEdit(edit);
    }
    const exec = this.controller.createNotebookCellExecution(cell);
    exec.start(Date.now());
    let ok: boolean | undefined = false;
    try {
      const meta: OutputMetadata = { run: { attrs } };
      await exec.clearOutput();
      await exec.appendOutput([
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(text)], { [META_KEY]: meta }),
        statusOutput(statusLine(attrs.exit, undefined), attrs),
      ]);
      ok = success;
    } finally {
      exec.end(ok, Date.now());
    }
  }

  /** Clear the outputs of cells that are not queued or running. */
  async clearOutputs(cells: readonly vscode.NotebookCell[]): Promise<void> {
    for (const cell of cells) {
      let exec: vscode.NotebookCellExecution;
      try {
        exec = this.controller.createNotebookCellExecution(cell);
      } catch {
        continue; // Already queued or running.
      }
      exec.start();
      await exec.clearOutput();
      exec.end(undefined);
    }
  }

  private enqueue(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument, lineRun?: LineRun): Promise<void> {
    // Create executions up front so queued cells show as pending.
    const executions: vscode.NotebookCellExecution[] = [];
    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue;
      try {
        executions.push(this.controller.createNotebookCellExecution(cell));
      } catch {
        // Already queued or running.
      }
    }
    const key = notebook.uri.toString();
    const next = (this.queues.get(key) ?? Promise.resolve())
      .then(() => this.runSequence(executions, notebook, lineRun))
      .catch((e: unknown) => {
        void vscode.window.showErrorMessage(`md-runbook: ${e instanceof Error ? e.message : String(e)}`);
      });
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  private async runSequence(executions: vscode.NotebookCellExecution[], notebook: vscode.NotebookDocument, lineRun?: LineRun): Promise<void> {
    const cfg = executionConfig();
    let stopped: vscode.NotebookCell | undefined;
    const runs: RunRecord[] = [];
    const cells = executions.map((e) => e.cell);
    /** Index of the last execution started (runCell ends its own, even when it throws). */
    let handled = -1;
    const excluded: string[] = [];
    const exclusion = (cell: vscode.NotebookCell): string | undefined => {
      for (const f of this.pipeline.excluders) {
        const why = f(cell);
        if (why !== undefined) return why;
      }
      return undefined;
    };
    try {
      for (const o of this.pipeline.observers) await o.onWillRunSequence?.(notebook, cells);
      for (let next = 0; next < executions.length; next++) {
        const exec = executions[next]!;
        handled = next;
        const why = stopped ? undefined : exclusion(exec.cell);
        if (why !== undefined) {
          // Not run and not recorded: the cell keeps whatever output it had.
          excluded.push(why);
          exec.start();
          exec.end(undefined);
          continue;
        }
        if (stopped || exec.token.isCancellationRequested) {
          // Skipped: leave the cell's previous output untouched.
          exec.start();
          exec.end(undefined);
          continue;
        }
        const run = await this.runCell(exec, notebook, cfg, lineRun);
        runs.push(run);
        const failedHard = !run.success && !run.plan.continueOnError && cfg.stopOnFailure;
        if ((failedHard || run.plan.stopSequence) && executions.length > 1) stopped = exec.cell;
      }
    } finally {
      // Something threw: don't leave the remaining cells pending forever. (runCell ends its own.)
      for (let i = handled + 1; i < executions.length; i++) {
        try {
          executions[i]!.start();
          executions[i]!.end(undefined);
        } catch {
          // Already ended.
        }
      }
    }
    if (executions.length === 1 && excluded[0] !== undefined) {
      void vscode.window.showInformationMessage(`md-runbook: not run: ${excluded[0]}.`);
    } else if (excluded.length > 0 && !stopped) {
      vscode.window.setStatusBarMessage(`md-runbook: ${excluded.length} cell${excluded.length === 1 ? '' : 's'} for another OS not run`, 8000);
    }
    if (stopped && executions[executions.length - 1]!.cell !== stopped) {
      const why = runs[runs.length - 1]?.plan.stopSequence ? 'was not confirmed' : 'failed';
      vscode.window.setStatusBarMessage(`md-runbook: stopped after cell ${stopped.index + 1} ${why}`, 8000);
    }
    for (const o of this.pipeline.observers) await o.onDidRunSequence?.(notebook, runs);
  }

  private async runCell(exec: vscode.NotebookCellExecution, notebook: vscode.NotebookDocument, cfg: ExecutionConfig, lineRun?: LineRun): Promise<RunRecord> {
    const cell = exec.cell;
    const started = new Date();
    exec.executionOrder = ++this.executionOrder;
    exec.start(started.getTime());

    const fmTimeout = frontMatterOf(notebook)?.timeoutSeconds;
    const fmTimeoutMs = fmTimeout !== undefined ? fmTimeout * 1000 : undefined;
    const plan: CellPlan = {
      source: lineRun?.source ?? cell.document.getText(),
      language: cell.document.languageId,
      cwd: runbookCwd(notebook),
      env: { ...cfg.env },
      timeoutMs: fmTimeoutMs ?? cfg.timeoutMs,
      shell: cfg.shell,
      attrs: {},
      secrets: [],
      continueOnError: false,
      ...(lineRun ? { steps: lineRun.steps.map((s) => s.text) } : {}),
    };
    /** Line runs: indexes of the steps that ran. */
    const ranSteps: number[] = [];
    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    let cancelSub: vscode.Disposable | undefined;
    const cleanup = async (): Promise<void> => {
      const fns = plan.cleanup ?? [];
      plan.cleanup = [];
      for (const fn of fns) {
        try {
          await fn();
        } catch {
          // Best effort (e.g. a temp file already gone).
        }
      }
    };
    try {
      const ran = formatLocalIso(started);
      const runMeta = (exit: string): Record<string, unknown> => {
        const m: OutputMetadata = { run: { attrs: { exit, ran } } };
        return { [META_KEY]: m };
      };

      let unflushed: Chunk[] = [];
      const previousOutputs = [...cell.outputs];
      let live = new vscode.NotebookCellOutput([], runMeta('running'));
      // Clear first so the live output is a new output, not an in-place replacement of the old one
      // (in-place replacements keep the old metadata on the extension host side).
      await exec.clearOutput();
      await exec.appendOutput([live]);

      let flushing = Promise.resolve();
      const flush = (): Promise<void> => {
        if (unflushed.length === 0) return flushing;
        const items = toItems(unflushed);
        unflushed = [];
        flushing = flushing.then(() => exec.appendOutputItems(items, live)).then(
          () => undefined,
          () => undefined,
        );
        return flushing;
      };
      timer = setInterval(() => void flush(), FLUSH_MS);

      // What the current attempt printed (a retry starts them again).
      let transcript = '';
      let stdoutText = '';
      let attemptChunks: Chunk[] = [];
      const sink = (stream: Chunk['stream']) => (text: string) => {
        if (text === '') return;
        transcript += text;
        if (stream === 'stdout') stdoutText += text;
        attemptChunks.push({ stream, text });
        unflushed.push({ stream, text });
      };
      /** Replace the cell's output with a new live output holding `chunks`. */
      const restartOutput = async (chunks: readonly Chunk[]): Promise<void> => {
        await flush();
        live = new vscode.NotebookCellOutput(chunks.length > 0 ? toItems(chunks) : [], runMeta('running'));
        await exec.clearOutput();
        await exec.appendOutput([live]);
      };

      const ctx: PrepareContext = { cell, notebook, token: exec.token, previousOutputs };
      const failed = (error: string): ExecuteResult => ({ exitCode: null, signal: null, timedOut: false, cancelled: false, error, durationMs: 0 });
      let prepareError: string | undefined;
      try {
        for (const p of this.pipeline.preparers) await p.prepare(plan, ctx);
      } catch (e) {
        prepareError = e instanceof Error ? e.message : String(e);
      }
      knownSecrets.add(plan.secrets);

      const redaction = redactionConfig();
      const liveRedact =
        redaction.enabled && redaction.applyToLiveOutput
          ? (t: string) => knownSecrets.redact(redaction.redactor.redact(t))
          : plan.secrets.length > 0
            ? (t: string) => knownSecrets.redact(t) // injected secrets never show, even live
            : undefined;
      // Messages of our own (errors, skip reasons) may quote a value too: always redact them.
      const message = (t: string): string => (liveRedact ? liveRedact(t) : knownSecrets.redact(t));
      const out = new LineBuffer(sink('stdout'), liveRedact);
      const err = new LineBuffer(sink('stderr'), liveRedact);
      // Without live redaction there's nothing to protect, so don't hold back partial lines.
      const write = (b: LineBuffer) => (t: string) => {
        b.write(t);
        if (!liveRedact) b.flush();
      };

      const abort = new AbortController();
      cancelSub = exec.token.onCancellationRequested(() => abort.abort());

      // Checks, captures and retries apply to whole-cell runs, not to line runs.
      const checks = lineRun ? undefined : plan.checks;
      const attempts = lineRun ? 1 : (plan.retry?.attempts ?? 1);
      let attempt = 0;
      let outcome: CheckOutcome | undefined;
      const judge = (r: ExecuteResult): CheckOutcome | undefined =>
        hasChecks(checks) && r.exitCode !== null && r.error === undefined && !r.timedOut && !r.cancelled
          ? evaluateChecks(checks, r.exitCode, transcript, stdoutText)
          : undefined;
      /** Run until it passes or the attempts are used up; only the last attempt's output is kept. */
      const runAttempts = async (io: ExecuteIO): Promise<ExecuteResult> => {
        const executor = this.pipeline.executorFor(notebook);
        for (;;) {
          attempt++;
          const r = await executor.execute(plan, io, ctx);
          out.flush();
          err.flush();
          outcome = judge(r);
          const passed = outcome ? outcome.ok : isSuccess(r);
          if (passed || attempt >= attempts || r.cancelled || abort.signal.aborted) return r;
          const why = outcome?.failures[0] ?? (r.timedOut ? 'timed out' : (r.error ?? `exit code ${exitLabel(r)}`));
          const every = plan.retry?.everyMs ?? 0;
          unflushed.push({ stream: 'stderr', text: message(`[md-runbook] attempt ${attempt}/${attempts} failed (${why}); trying again in ${formatDuration(every)}\n`) });
          await flush();
          if (!(await wait(every, abort.signal))) return { ...r, exitCode: null, cancelled: true };
          transcript = '';
          stdoutText = '';
          attemptChunks = [];
          outcome = undefined;
          await restartOutput([]);
        }
      };

      let result: ExecuteResult;
      const skipped = prepareError === undefined && plan.skip !== undefined;
      if (prepareError !== undefined) {
        result = failed(prepareError);
      } else if (plan.skip !== undefined) {
        unflushed.push({ stream: 'stdout', text: message(`[md-runbook] skipped: ${plan.skip}\n`) });
        result = { exitCode: null, signal: null, timedOut: false, cancelled: false, durationMs: 0 };
      } else {
        try {
          const io: ExecuteIO = { signal: abort.signal, onStdout: write(out), onStderr: write(err) };
          result = !fs.existsSync(plan.cwd)
            ? failed(`Working directory not found: ${plan.cwd}`)
            : lineRun
              ? await this.runSteps(lineRun, plan, io, ctx, ranSteps, async () => {
                  out.flush();
                  err.flush();
                  await flush();
                })
              : await runAttempts(io);
        } catch (e) {
          result = failed(e instanceof Error ? e.message : String(e));
        }
      }

      cancelSub.dispose();
      clearInterval(timer);
      await cleanup();
      out.flush();
      err.flush();

      if (result.error !== undefined) unflushed.push({ stream: 'stderr', text: message(result.error + '\n') });
      if (result.timedOut) unflushed.push({ stream: 'stderr', text: `[md-runbook] timed out after ${formatDuration(plan.timeoutMs)}; process tree killed\n` });
      for (const f of outcome && !outcome.ok ? outcome.failures : []) unflushed.push({ stream: 'stderr', text: message(`[md-runbook] check failed: ${f}\n`) });
      await flush();
      // A value captured as a secret was shown before it was known: redraw the output without it.
      const capturedSecrets = outcome?.ok ? outcome.captured.filter((c) => c.secret).map((c) => c.value) : [];
      if (capturedSecrets.length > 0) {
        knownSecrets.add(capturedSecrets);
        transcript = knownSecrets.redact(transcript);
        await restartOutput(attemptChunks.map((c) => ({ ...c, text: knownSecrets.redact(c.text) })));
      }

      // A preparer can record why it didn't run (declined, proposed) instead of a plain skip.
      const exit = skipped ? (plan.skipExit ?? 'skipped') : exitLabel(result);
      const endedAt = new Date();
      const elapsed = endedAt.getTime() - started.getTime();
      const shellLabel = result.shell?.label;
      // The history preparer (history.ts) stored the earlier runs in the metadata before the run.
      const stored: unknown = cell.metadata?.[HISTORY_KEY];
      const history = isRunHistory(stored) ? stored.history : [];
      const earlier = earlierRuns(history.length);
      const lines = lineRun && linesAttr(lineRun, ranSteps);
      const check = outcome ? (outcome.ok ? 'ok' : 'failed') : undefined;
      const tries = attempts > 1 && attempt > 0 ? attempt : undefined;
      const status = [
        statusLine(exit, undefined, formatDuration(elapsed)),
        check && `check ${check === 'ok' ? 'passed' : 'failed'}`,
        tries && `attempt ${tries}/${attempts}`,
        lines && `lines ${lines}`,
        shellLabel,
        earlier,
      ]
        .filter(Boolean)
        .join(' · ');
      const attrs = {
        exit,
        ran,
        ended: formatLocalIso(endedAt),
        duration: formatDurationAttr(elapsed),
        ...(check ? { check } : {}),
        ...(tries ? { attempts: String(tries) } : {}),
        ...(lines ? { lines } : {}),
        ...plan.attrs,
      };
      const earlierOutput = earlierRunsOutput(history);
      await exec.appendOutput(earlierOutput ? [statusOutput(status, attrs), earlierOutput] : [statusOutput(status, attrs)]);

      // A cell that was not run counts as success so Run All carries on (a declined confirmation
      // stops it through stopSequence).
      const success = skipped || (outcome ? outcome.ok : isSuccess(result));
      ended = true;
      exec.end(skipped ? undefined : success, Date.now());
      const run: RunRecord = { cell, notebook, plan, result, success, attrs, output: transcript, ...(outcome?.ok ? { captured: outcome.captured } : {}) };
      for (const o of this.pipeline.observers) await o.onDidRunCell?.(run);
      return run;
    } finally {
      if (timer) clearInterval(timer);
      cancelSub?.dispose();
      await cleanup();
      if (!ended) {
        try {
          exec.end(false, Date.now());
        } catch {
          // Already ended.
        }
      }
    }
  }

  /**
   * Runs the steps of a line run one after another, each shown as `$ command` before its output.
   * Outside session mode they share a shell kept for this run only. Stops at the first step
   * that fails, or when `beforeStep` says so.
   */
  private async runSteps(
    run: LineRun,
    plan: CellPlan,
    io: ExecuteIO,
    ctx: PrepareContext,
    ranSteps: number[],
    /** Shows everything printed so far in the cell. */
    showOutput: () => Promise<void>,
  ): Promise<ExecuteResult> {
    const executor = this.pipeline.executorFor(ctx.notebook);
    const kind = shellKindForLanguage(plan.language) ?? 'bash';
    const steps = plan.steps ?? [];
    const lineShell = new SessionPool(undefined, undefined, '');
    const ends: (() => void)[] = [];
    const stepCtx: PrepareContext = { ...ctx, lineRun: { shell: lineShell, onEnd: (fn) => ends.push(fn) } };
    let result: ExecuteResult = { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 0 };
    try {
      for (let i = 0; i < steps.length; i++) {
        if (i > 0 && run.beforeStep) {
          // The output of the line that just ran must be on screen while the run waits.
          await showOutput();
          if (!(await run.beforeStep(i, ctx.token))) break;
        }
        if (io.signal.aborted) {
          result = { ...result, exitCode: null, cancelled: true };
          break;
        }
        run.onStep?.(i);
        io.onStdout(echoCommand(kind, run.steps[i]!.text));
        const r = await executor.execute({ ...plan, source: steps[i]! }, io, stepCtx);
        ranSteps.push(i);
        result = { ...r, durationMs: result.durationMs + r.durationMs };
        if (!isSuccess(r)) {
          const step = run.steps[i]!;
          if (i < steps.length - 1 && !r.cancelled && !r.timedOut) {
            io.onStderr(`[md-runbook] line ${formatLineRange(step.start, step.end)} failed; the lines after it were not run\n`);
          }
          break;
        }
      }
    } finally {
      run.onStep?.(undefined);
      lineShell.dispose();
      for (const fn of ends) {
        try {
          fn();
        } catch {
          // Best effort (e.g. a terminal already closed).
        }
      }
    }
    return result;
  }
}

/** NotebookController: runs code cells through the core executor and streams their output. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExecuteResult, LineBuffer, SUPPORTED_LANGUAGE_IDS, exitLabel, formatDurationAttr, formatLocalIso, isSuccess } from './core';
import { ExecutionConfig, executionConfig, redactionConfig } from './config';
import { META_KEY, OutputMetadata, statusLine, statusOutput } from './outputs';
import { CellPlan, PrepareContext, RunPipeline, RunRecord } from './pipeline';
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

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function workingDirectory(uri: vscode.Uri): string {
  if (uri.scheme === 'file') return path.dirname(uri.fsPath);
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

export const CONTROLLER_ID = 'md-runbook-shell';

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

  dispose(): void {
    this.controller.dispose();
  }

  /**
   * Record an outcome without running the cell (e.g. a step marked done by hand). `attrs` are
   * the marker attributes persisted on save; `text` becomes the output text.
   */
  async recordManual(cell: vscode.NotebookCell, attrs: Record<string, string>, text: string, success?: boolean): Promise<void> {
    const exec = this.controller.createNotebookCellExecution(cell);
    exec.start(Date.now());
    const meta: OutputMetadata = { run: { attrs } };
    await exec.clearOutput();
    await exec.appendOutput([
      new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(text)], { [META_KEY]: meta }),
      statusOutput(statusLine(attrs.exit, undefined), attrs),
    ]);
    exec.end(success, Date.now());
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

  private enqueue(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
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
      .then(() => this.runSequence(executions, notebook))
      .catch((e: unknown) => {
        void vscode.window.showErrorMessage(`md-runbook: ${e instanceof Error ? e.message : String(e)}`);
      });
    this.queues.set(key, next);
    void next.then(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  private async runSequence(executions: vscode.NotebookCellExecution[], notebook: vscode.NotebookDocument): Promise<void> {
    const cfg = executionConfig();
    let stopped: vscode.NotebookCell | undefined;
    const runs: RunRecord[] = [];
    const cells = executions.map((e) => e.cell);
    for (const o of this.pipeline.observers) await o.onWillRunSequence?.(notebook, cells);
    for (const exec of executions) {
      if (stopped || exec.token.isCancellationRequested) {
        // Skipped: leave the cell's previous output untouched.
        exec.start();
        exec.end(undefined);
        continue;
      }
      const run = await this.runCell(exec, notebook, cfg);
      runs.push(run);
      const failedHard = !run.success && !run.plan.continueOnError && cfg.stopOnFailure;
      if ((failedHard || run.plan.stopSequence) && executions.length > 1) stopped = exec.cell;
    }
    if (stopped && executions[executions.length - 1]!.cell !== stopped) {
      const why = runs[runs.length - 1]?.plan.stopSequence ? 'was not confirmed' : 'failed';
      vscode.window.setStatusBarMessage(`md-runbook: stopped after cell ${stopped.index + 1} ${why}`, 8000);
    }
    for (const o of this.pipeline.observers) await o.onDidRunSequence?.(notebook, runs);
  }

  private async runCell(exec: vscode.NotebookCellExecution, notebook: vscode.NotebookDocument, cfg: ExecutionConfig): Promise<RunRecord> {
    const cell = exec.cell;
    const started = new Date();
    exec.executionOrder = ++this.executionOrder;
    exec.start(started.getTime());

    const ran = formatLocalIso(started);
    const runMeta = (exit: string): Record<string, unknown> => {
      const m: OutputMetadata = { run: { attrs: { exit, ran } } };
      return { [META_KEY]: m };
    };

    let unflushed: Chunk[] = [];
    const previousOutputs = [...cell.outputs];
    const live = new vscode.NotebookCellOutput([], runMeta('running'));
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
    const timer = setInterval(() => void flush(), FLUSH_MS);

    let transcript = '';
    const sink = (stream: Chunk['stream']) => (text: string) => {
      if (text === '') return;
      transcript += text;
      unflushed.push({ stream, text });
    };

    const ctx: PrepareContext = { cell, notebook, token: exec.token, previousOutputs };
    const plan: CellPlan = {
      source: cell.document.getText(),
      language: cell.document.languageId,
      cwd: workingDirectory(notebook.uri),
      env: { ...cfg.env },
      timeoutMs: cfg.timeoutMs,
      shell: cfg.shell,
      attrs: {},
      secrets: [],
      continueOnError: false,
    };
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
    const out = new LineBuffer(sink('stdout'), liveRedact);
    const err = new LineBuffer(sink('stderr'), liveRedact);
    // Without live redaction there's nothing to protect, so don't hold back partial lines.
    const write = (b: LineBuffer) => (t: string) => {
      b.write(t);
      if (!liveRedact) b.flush();
    };

    const abort = new AbortController();
    const cancelSub = exec.token.onCancellationRequested(() => abort.abort());

    let result: ExecuteResult;
    const skipped = prepareError === undefined && plan.skip !== undefined;
    if (prepareError !== undefined) {
      result = failed(prepareError);
    } else if (plan.skip !== undefined) {
      unflushed.push({ stream: 'stdout', text: `[md-runbook] skipped: ${plan.skip}\n` });
      result = { exitCode: null, signal: null, timedOut: false, cancelled: false, durationMs: 0 };
    } else {
      try {
        result = fs.existsSync(plan.cwd)
          ? await this.pipeline.executorFor(notebook).execute(plan, { signal: abort.signal, onStdout: write(out), onStderr: write(err) }, ctx)
          : failed(`Working directory not found: ${plan.cwd}`);
      } catch (e) {
        result = failed(e instanceof Error ? e.message : String(e));
      }
    }

    cancelSub.dispose();
    clearInterval(timer);
    out.flush();
    err.flush();

    if (result.error !== undefined) unflushed.push({ stream: 'stderr', text: result.error + '\n' });
    if (result.timedOut) unflushed.push({ stream: 'stderr', text: `[md-runbook] timed out after ${formatDuration(plan.timeoutMs)}; process tree killed\n` });
    await flush();

    const exit = skipped ? 'skipped' : exitLabel(result);
    const endedAt = new Date();
    const elapsed = endedAt.getTime() - started.getTime();
    const shellLabel = result.shell?.label;
    const status = [statusLine(exit, undefined, formatDuration(elapsed)), shellLabel].filter(Boolean).join(' · ');
    const attrs = { exit, ran, ended: formatLocalIso(endedAt), duration: formatDurationAttr(elapsed), ...plan.attrs };
    await exec.appendOutput([statusOutput(status, attrs)]);

    // A skipped cell counts as success so Run All carries on.
    const success = skipped || isSuccess(result);
    exec.end(skipped ? undefined : success, Date.now());
    const run: RunRecord = { cell, notebook, plan, result, success, attrs, output: transcript };
    for (const o of this.pipeline.observers) await o.onDidRunCell?.(run);
    return run;
  }
}

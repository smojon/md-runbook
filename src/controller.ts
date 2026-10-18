/** NotebookController: runs code cells through the core executor and streams their output. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExecuteResult, LineBuffer, SUPPORTED_LANGUAGE_IDS, executeCell, exitLabel, formatLocalIso, isSuccess } from './core';
import { ExecutionConfig, executionConfig, redactionConfig } from './config';
import { META_KEY, OutputMetadata, statusLine, statusOutput } from './outputs';
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

export class RunbookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private executionOrder = 0;
  /** Per-notebook queue so cells of one runbook never run concurrently. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor() {
    this.controller = vscode.notebooks.createNotebookController('md-runbook-shell', NOTEBOOK_TYPE, 'md-runbook shell');
    this.controller.description = 'sh/bash, pwsh/powershell, cmd';
    this.controller.supportedLanguages = [...SUPPORTED_LANGUAGE_IDS];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.enqueue(cells, notebook);
  }

  dispose(): void {
    this.controller.dispose();
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
    for (const exec of executions) {
      if (stopped || exec.token.isCancellationRequested) {
        // Skipped: leave the cell's previous output untouched.
        exec.start();
        exec.end(undefined);
        continue;
      }
      const ok = await this.runCell(exec, notebook, cfg);
      if (!ok && cfg.stopOnFailure && executions.length > 1) stopped = exec.cell;
    }
    if (stopped && executions[executions.length - 1]!.cell !== stopped) {
      vscode.window.setStatusBarMessage(`md-runbook: stopped after cell ${stopped.index + 1} failed`, 8000);
    }
  }

  private async runCell(exec: vscode.NotebookCellExecution, notebook: vscode.NotebookDocument, cfg: ExecutionConfig): Promise<boolean> {
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

    const redaction = redactionConfig();
    const liveRedact = redaction.enabled && redaction.applyToLiveOutput ? (t: string) => redaction.redactor.redact(t) : undefined;
    const sink = (stream: Chunk['stream']) => (text: string) => {
      if (text !== '') unflushed.push({ stream, text });
    };
    const out = new LineBuffer(sink('stdout'), liveRedact);
    const err = new LineBuffer(sink('stderr'), liveRedact);
    // Without live redaction there's nothing to protect, so don't hold back partial lines.
    const write = (b: LineBuffer) => (t: string) => {
      b.write(t);
      if (!liveRedact) b.flush();
    };

    const abort = new AbortController();
    const cancelSub = exec.token.onCancellationRequested(() => abort.abort());

    const cwd = workingDirectory(notebook.uri);
    const failed = (error: string): ExecuteResult => ({ exitCode: null, signal: null, timedOut: false, cancelled: false, error, durationMs: 0 });
    let result: ExecuteResult;
    try {
      result = fs.existsSync(cwd)
        ? await executeCell({
            language: cell.document.languageId,
            source: cell.document.getText(),
            cwd,
            settings: cfg.shell,
            timeoutMs: cfg.timeoutMs,
            env: cfg.env,
            signal: abort.signal,
            onStdout: write(out),
            onStderr: write(err),
          })
        : failed(`Working directory not found: ${cwd}`);
    } catch (e) {
      result = failed(e instanceof Error ? e.message : String(e));
    }

    cancelSub.dispose();
    clearInterval(timer);
    out.flush();
    err.flush();

    if (result.error !== undefined) unflushed.push({ stream: 'stderr', text: result.error + '\n' });
    if (result.timedOut) unflushed.push({ stream: 'stderr', text: `[md-runbook] timed out after ${formatDuration(cfg.timeoutMs)}; process tree killed\n` });
    await flush();

    const exit = exitLabel(result);
    const shellLabel = result.shell?.label;
    const status = [statusLine(exit, undefined, formatDuration(result.durationMs)), shellLabel].filter(Boolean).join(' · ');
    await exec.appendOutput([statusOutput(status, { exit, ran })]);

    const ok = isSuccess(result);
    exec.end(ok, Date.now());
    return ok;
  }
}

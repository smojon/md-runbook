/**
 * Extension points around running a cell. Features plug in here instead of editing the
 * controller: preparers shape the run, an executor runs it, observers react to the result.
 */

import * as vscode from 'vscode';
import { ExecuteResult, executeCell } from './core';
import type { ShellSettings } from './core';

/** Everything needed to run one cell; preparers may change any of it. */
export interface CellPlan {
  /** Script text to run. */
  source: string;
  /** VS Code language id or fence language. */
  language: string;
  cwd: string;
  /** Extra environment variables. */
  env: Record<string, string>;
  /** 0 = no timeout. */
  timeoutMs: number;
  shell: ShellSettings;
  /** Extra attributes for the output marker (e.g. context=prod). Written after exit/ran/ended/duration. */
  attrs: Record<string, string>;
  /** Exact values to redact from live and persisted output (e.g. injected secrets). */
  secrets: string[];
  /** Run All keeps going if this cell fails. */
  continueOnError: boolean;
  /** When set, the cell is not run; the reason is shown and recorded as exit=skipped. */
  skip?: string;
}

export interface PrepareContext {
  cell: vscode.NotebookCell;
  notebook: vscode.NotebookDocument;
  token: vscode.CancellationToken;
  /** The cell's outputs from before this run (they are cleared before preparers run). */
  previousOutputs?: readonly vscode.NotebookCellOutput[];
}

export interface CellPreparer {
  /** Mutate the plan. Throwing fails the cell with the error message. */
  prepare(plan: CellPlan, ctx: PrepareContext): Promise<void> | void;
}

export interface ExecuteIO {
  signal: AbortSignal;
  onStdout(text: string): void;
  onStderr(text: string): void;
}

export interface CellExecutor {
  execute(plan: CellPlan, io: ExecuteIO, ctx: PrepareContext): Promise<ExecuteResult>;
}

export interface RunRecord {
  cell: vscode.NotebookCell;
  notebook: vscode.NotebookDocument;
  plan: CellPlan;
  result: ExecuteResult;
  success: boolean;
  /** Marker attributes as persisted (exit, ran, ended, duration, ...plan.attrs). */
  attrs: Record<string, string>;
  /** Combined output text (live view, before persistence processing). */
  output: string;
}

export interface RunObserver {
  onDidRunCell?(run: RunRecord): void | Promise<void>;
  /** A Run All / multi-cell run finished (or stopped). */
  onDidRunSequence?(notebook: vscode.NotebookDocument, runs: RunRecord[]): void | Promise<void>;
}

/** Default executor: every cell in its own process. */
export const isolatedExecutor: CellExecutor = {
  execute: (plan, io) =>
    executeCell({
      language: plan.language,
      source: plan.source,
      cwd: plan.cwd,
      settings: plan.shell,
      timeoutMs: plan.timeoutMs,
      env: plan.env,
      signal: io.signal,
      onStdout: io.onStdout,
      onStderr: io.onStderr,
    }),
};

/** Registry the controller consults; features register in extension.ts. */
export class RunPipeline {
  readonly preparers: CellPreparer[] = [];
  readonly observers: RunObserver[] = [];
  /** Picks the executor per notebook (e.g. a persistent session). */
  executorFor: (notebook: vscode.NotebookDocument) => CellExecutor = () => isolatedExecutor;
}

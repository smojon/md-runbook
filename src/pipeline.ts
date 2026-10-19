/**
 * Extension points around running a cell. Features plug in here instead of editing the
 * controller: preparers shape the run, an executor runs it, observers react to the result.
 */

import * as vscode from 'vscode';
import { ExecuteOptions, ExecuteResult } from '@md-runbook/core';
import { executeCell } from '@md-runbook/core/node';
import type { ShellSettings } from '@md-runbook/core';
import type { Captured, CellChecks } from '@md-runbook/core/checks';
import type { SessionPool } from '@md-runbook/core/node/session';

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
  /** When set, the cell is not run; the reason is shown and recorded as exit=skipped (or `skipExit`). */
  skip?: string;
  /**
   * With `skip`: the exit label recorded instead of `skipped`. Progress counts `skipped` as
   * complete; anything else (`declined`, `proposed`) stays pending and Resume Run picks it up.
   */
  skipExit?: string;
  /** With `skip`: also stop the rest of a Run All (e.g. a declined confirmation). */
  stopSequence?: boolean;
  /** Set by an early preparer: the cell must be confirmed (text names the risky match, '' = always). */
  confirm?: string;
  /** Run after the cell finished (or was not run), e.g. to delete temporary credential files. */
  cleanup?: (() => void | Promise<void>)[];
  /**
   * Line runs: the commands run one after another instead of `source` (which then holds the
   * lines they come from, for preparers that check it). A preparer that rewrites `source` must
   * rewrite each step the same way.
   */
  steps?: string[];
  /** Checks and captures on the result (cell options); not applied to line runs. */
  checks?: CellChecks;
  /** Run again until it passes: up to `attempts` in all, `everyMs` apart. Not for line runs. */
  retry?: { attempts: number; everyMs: number };
}

export interface PrepareContext {
  cell: vscode.NotebookCell;
  notebook: vscode.NotebookDocument;
  token: vscode.CancellationToken;
  /** The cell's outputs from before this run (they are cleared before preparers run). */
  previousOutputs?: readonly vscode.NotebookCellOutput[];
  /** Set while the lines of a line run execute: what they share. */
  lineRun?: LineRunScope;
}

/** What the lines of one line run share, so `cd` and variables carry over between them. */
export interface LineRunScope {
  /** Outside session mode: a shell kept for this run only (stopped when it ends). */
  shell: SessionPool;
  /** Run `fn` when the line run ends (e.g. close a terminal opened for it). */
  onEnd(fn: () => void): void;
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
  /** Values captured for `${out:NAME}` (capture= options), when the run passed. */
  captured?: Captured[];
}

export interface RunObserver {
  /** A run of `cells` (one cell, a range or Run All) is about to start. */
  onWillRunSequence?(notebook: vscode.NotebookDocument, cells: vscode.NotebookCell[]): void | Promise<void>;
  onDidRunCell?(run: RunRecord): void | Promise<void>;
  /** A Run All / multi-cell run finished (or stopped). */
  onDidRunSequence?(notebook: vscode.NotebookDocument, runs: RunRecord[]): void | Promise<void>;
}

/** Default executor: every cell in its own process (the lines of a line run share one). */
export const isolatedExecutor: CellExecutor = {
  execute: (plan, io, ctx) => {
    const opts: ExecuteOptions = {
      language: plan.language,
      source: plan.source,
      cwd: plan.cwd,
      settings: plan.shell,
      timeoutMs: plan.timeoutMs,
      env: plan.env,
      signal: io.signal,
      onStdout: io.onStdout,
      onStderr: io.onStderr,
    };
    return ctx.lineRun ? ctx.lineRun.shell.execute(opts) : executeCell(opts);
  },
};

/** Registry the controller consults; features register in extension.ts. */
export class RunPipeline {
  readonly preparers: CellPreparer[] = [];
  /**
   * Cells that are not run at all and keep their output (not even recorded as skipped), e.g. a
   * block for another OS. Each returns why, or undefined.
   */
  readonly excluders: ((cell: vscode.NotebookCell) => string | undefined)[] = [];
  readonly observers: RunObserver[] = [];
  /**
   * A line run for a normal run of `cell` (e.g. one that pauses at its breakpoints), or undefined
   * to run the cell as one script.
   */
  lineRunFor?: (cell: vscode.NotebookCell) => import('./controller').LineRun | undefined;
  /** Picks the executor per notebook (e.g. a persistent session). */
  executorFor: (notebook: vscode.NotebookDocument) => CellExecutor = () => isolatedExecutor;
}

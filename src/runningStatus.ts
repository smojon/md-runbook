/**
 * A running cell's status, pinned at the bottom of its output while it runs: a bar against the
 * block's estimate (estimate=, else its learned time; estimates.ts) and the words every client
 * uses (core cellRunStatus): `running · 12s of about 30s`, `attempt 2/5`. Without an estimate, a
 * counter only (`running · 12s`). The running-status renderer draws it and counts the seconds
 * (renderer/runningStatus.ts): the output changes only for a new attempt and at the end.
 * It stays last (pinnedStatus.ts); when the run ends it goes, and the status line follows as before.
 */

import * as vscode from 'vscode';
import { META_KEY, OutputMetadata } from './outputs';
import { PinnedStatus, RunningData } from './pinnedStatus';

export const RUNNING_MIME = 'application/vnd.md-runbook.running+json';

const item = (data: RunningData): vscode.NotebookCellOutputItem => vscode.NotebookCellOutputItem.json(data, RUNNING_MIME);

export type RunningStatus = PinnedStatus<vscode.NotebookCellOutput, vscode.NotebookCellOutputItem>;

/** The status of a cell that started at `startedAt` (ms), with `estimateSeconds` and retry=`attempts`. */
export function runningStatusFor(exec: vscode.NotebookCellExecution, startedAt: number, estimateSeconds: number | undefined, attempts: number): RunningStatus {
  const meta: OutputMetadata = { running: true };
  return new PinnedStatus(
    {
      appendOutput: (outputs) => exec.appendOutput(outputs),
      replaceOutputItems: (items, output) => exec.replaceOutputItems(items, output),
    },
    { output: (data) => new vscode.NotebookCellOutput([item(data)], { [META_KEY]: meta }), item },
    startedAt,
    estimateSeconds,
    attempts,
  );
}

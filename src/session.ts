/**
 * Persistent session mode (`mdRunbook.execution.mode: "session"`): each runbook keeps one shell
 * process per shell kind, so state carries over between cells.
 */

import * as vscode from 'vscode';
import { SECTION } from './config';
import { SessionPool } from './core/session';
import { CellExecutor, RunPipeline } from './pipeline';
import { NOTEBOOK_TYPE } from './serializer';

function sessionMode(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<string>('execution.mode', 'isolated') === 'session';
}

function activeRunbook(): vscode.NotebookDocument | undefined {
  const nb = vscode.window.activeNotebookEditor?.notebook;
  return nb?.notebookType === NOTEBOOK_TYPE ? nb : undefined;
}

export function registerSessions(context: vscode.ExtensionContext, pipeline: RunPipeline): void {
  const pools = new Map<string, SessionPool>();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'mdRunbook.restartSession';
  status.tooltip = 'md-runbook: persistent shell session for this runbook. Click to restart.';
  const updateStatus = (): void => {
    const nb = activeRunbook();
    const labels = nb ? (pools.get(nb.uri.toString())?.labels() ?? []) : [];
    if (labels.length === 0) return status.hide();
    status.text = `$(terminal) session: ${labels.join(', ')}`;
    status.show();
  };

  const poolFor = (nb: vscode.NotebookDocument): SessionPool => {
    const key = nb.uri.toString();
    let pool = pools.get(key);
    if (!pool) pools.set(key, (pool = new SessionPool(updateStatus)));
    return pool;
  };
  const disposePool = (key: string): void => {
    pools.get(key)?.dispose();
    pools.delete(key);
  };
  const disposeAll = (): void => {
    for (const key of [...pools.keys()]) disposePool(key);
  };

  const sessionExecutorFor = (nb: vscode.NotebookDocument): CellExecutor => ({
    execute: (plan, io) =>
      poolFor(nb).execute({
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
  });
  const fallback = pipeline.executorFor;
  pipeline.executorFor = (nb) => (sessionMode() ? sessionExecutorFor(nb) : fallback(nb));

  const forActive = (fn: (pool: SessionPool) => void): void => {
    const nb = activeRunbook();
    const pool = nb && pools.get(nb.uri.toString());
    if (!pool || pool.labels().length === 0) return void vscode.window.showInformationMessage('md-runbook: no session is running for this runbook.');
    fn(pool);
  };

  context.subscriptions.push(
    status,
    { dispose: disposeAll },
    vscode.commands.registerCommand('mdRunbook.restartSession', () =>
      forActive((pool) => vscode.window.setStatusBarMessage(`md-runbook: restarted session (${pool.restart().join(', ')})`, 5000)),
    ),
    vscode.commands.registerCommand('mdRunbook.stopSession', () =>
      forActive((pool) => vscode.window.setStatusBarMessage(`md-runbook: stopped session (${pool.stop().join(', ')})`, 5000)),
    ),
    vscode.workspace.onDidCloseNotebookDocument((nb) => disposePool(nb.uri.toString())),
    vscode.window.onDidChangeActiveNotebookEditor(updateStatus),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.execution.mode`) && !sessionMode()) disposeAll();
    }),
  );
}

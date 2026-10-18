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

/** The runbook a command applies to: the given URI, else the active (or only visible) runbook editor. */
function activeRunbook(uri?: unknown): vscode.NotebookDocument | undefined {
  const isRunbook = (nb: vscode.NotebookDocument | undefined): nb is vscode.NotebookDocument => nb?.notebookType === NOTEBOOK_TYPE;
  if (uri instanceof vscode.Uri) return vscode.workspace.notebookDocuments.find((d) => isRunbook(d) && d.uri.toString() === uri.toString());
  const active = vscode.window.activeNotebookEditor?.notebook;
  if (isRunbook(active)) return active;
  const visible = vscode.window.visibleNotebookEditors.map((e) => e.notebook).filter(isRunbook);
  return visible.length === 1 ? visible[0] : undefined;
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

  /** Runs `fn` on the runbook's sessions; returns the shells it acted on (empty if none). */
  const forActive = (uri: unknown, fn: (pool: SessionPool) => string[]): string[] => {
    const nb = activeRunbook(uri);
    const pool = nb && pools.get(nb.uri.toString());
    if (!pool || pool.labels().length === 0) {
      void vscode.window.showInformationMessage('md-runbook: no session is running for this runbook.');
      return [];
    }
    return fn(pool);
  };

  context.subscriptions.push(
    status,
    { dispose: disposeAll },
    vscode.commands.registerCommand('mdRunbook.restartSession', (uri?: unknown) =>
      forActive(uri, (pool) => {
        const shells = pool.restart();
        vscode.window.setStatusBarMessage(`md-runbook: restarted session (${shells.join(', ')})`, 5000);
        return shells;
      }),
    ),
    vscode.commands.registerCommand('mdRunbook.stopSession', (uri?: unknown) =>
      forActive(uri, (pool) => {
        const shells = pool.stop();
        vscode.window.setStatusBarMessage(`md-runbook: stopped session (${shells.join(', ')})`, 5000);
        return shells;
      }),
    ),
    vscode.workspace.onDidCloseNotebookDocument((nb) => disposePool(nb.uri.toString())),
    vscode.window.onDidChangeActiveNotebookEditor(updateStatus),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.execution.mode`) && !sessionMode()) disposeAll();
    }),
  );
}

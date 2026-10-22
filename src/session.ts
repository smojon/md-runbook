/**
 * Persistent session mode: each runbook keeps one shell process per shell kind, so state carries
 * over between cells. The mode is chosen per runbook: a toggle in the editor wins over `mode:` in
 * the front matter, which wins over `mdRunbook.execution.mode`.
 */

import * as vscode from 'vscode';
import { SECTION } from './config';
import { runbookCwd } from './controller';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { SessionPool } from '@md-runbook/core/node/session';
import { isCodeMeta } from '@md-runbook/core';
import { proposalOf } from '@md-runbook/core/proposal';
import { META_KEY } from './outputs';
import { CellExecutor, RunPipeline } from './pipeline';
import { setContext } from './contextKeys';
import { NOTEBOOK_TYPE } from './serializer';

type Mode = 'session' | 'isolated';
type ModeSource = 'toggle' | 'front matter' | 'setting';

const OVERRIDE_KEY = 'mdRunbook.sessionModeOverrides';

function settingMode(): Mode {
  return vscode.workspace.getConfiguration(SECTION).get<string>('execution.mode', 'isolated') === 'session' ? 'session' : 'isolated';
}

/** `mode:` from the runbook's front matter (first cell, if it is Markdown). */
function frontMatterMode(nb: vscode.NotebookDocument): Mode | undefined {
  const first = nb.cellCount > 0 ? nb.cellAt(0) : undefined;
  if (!first || first.kind !== vscode.NotebookCellKind.Markup) return undefined;
  return parseFrontMatter(first.document.getText())?.mode;
}

function isAssistantCell(cell: vscode.NotebookCell): boolean {
  const meta: unknown = cell.metadata?.[META_KEY];
  return isCodeMeta(meta) && proposalOf(meta.info).by !== undefined;
}

/**
 * Whether a run covers the whole runbook: it starts at the first code cell and includes every
 * code cell. A Resume Run that starts later (at a failed or pending step) keeps the session;
 * resuming from the very first step is the same as Run All.
 */
export function isRunAll(nb: vscode.NotebookDocument, cells: readonly vscode.NotebookCell[]): boolean {
  const code = nb.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code);
  if (code.length === 0 || cells[0]?.index !== code[0]?.index) return false;
  const included = new Set(cells.map((c) => c.index));
  return code.every((c) => included.has(c.index));
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

  // Toggles are remembered per runbook (workspace state), so they survive a reload.
  const overrides = (): Record<string, Mode> => context.workspaceState.get<Record<string, Mode>>(OVERRIDE_KEY, {});
  const inheritedMode = (nb: vscode.NotebookDocument): { mode: Mode; source: ModeSource } => {
    const fm = frontMatterMode(nb);
    return fm ? { mode: fm, source: 'front matter' } : { mode: settingMode(), source: 'setting' };
  };
  const modeOf = (nb: vscode.NotebookDocument): { mode: Mode; source: ModeSource } => {
    const o = overrides()[nb.uri.toString()];
    return o ? { mode: o, source: 'toggle' } : inheritedMode(nb);
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'mdRunbook.sessionMenu';
  const updateStatus = (): void => {
    const nb = activeRunbook();
    if (!nb) return status.hide();
    const { mode, source } = modeOf(nb);
    // The notebook toolbar shows "Session: on" or "Session: off" from this.
    setContext('mdRunbook.sessionMode', mode);
    const labels = pools.get(nb.uri.toString())?.labels() ?? [];
    status.text = mode === 'isolated' ? '$(debug-disconnect) isolated' : `$(terminal) session${labels.length ? `: ${labels.join(', ')}` : ''}`;
    status.tooltip =
      `md-runbook: ${mode === 'session' ? 'persistent session (state carries over between cells)' : 'every cell runs in a new process'}` +
      ` — set by ${source}. Click to switch, restart or stop.`;
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
    updateStatus();
  };
  const disposeAll = (): void => {
    for (const key of [...pools.keys()]) disposePool(key);
  };
  /** Stop sessions of runbooks that are no longer in session mode. */
  const pruneIsolated = (): void => {
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType === NOTEBOOK_TYPE && modeOf(nb).mode === 'isolated') disposePool(nb.uri.toString());
    }
    updateStatus();
  };

  const sessionExecutorFor = (nb: vscode.NotebookDocument): CellExecutor => ({
    execute: (plan, io) =>
      poolFor(nb).execute({
        language: plan.language,
        source: plan.source,
        cwd: plan.cwd,
        // Sessions start (and restart) in the runbook's folder; a cell with `cwd=` runs in its
        // own folder without moving the session.
        baseCwd: runbookCwd(nb),
        settings: plan.shell,
        timeoutMs: plan.timeoutMs,
        env: plan.env,
        signal: io.signal,
        onStdout: io.onStdout,
        onStderr: io.onStderr,
      }),
  });
  const fallback = pipeline.executorFor;
  pipeline.executorFor = (nb) => {
    if (modeOf(nb).mode !== 'session') return fallback(nb);
    const session = sessionExecutorFor(nb);
    return {
      // Cells written by an assistant never join the shared shell: they must not see variables or
      // logins from earlier cells, and they get their own (read-only) credentials instead.
      execute: (plan, io, ctx) => (isAssistantCell(ctx.cell) ? fallback(nb) : session).execute(plan, io, ctx),
    };
  };

  // Optionally start every Run All in a fresh session, so full runs never depend on leftovers.
  pipeline.observers.push({
    onWillRunSequence: (nb, cells) => {
      const resetOnRunAll = vscode.workspace.getConfiguration(SECTION).get<boolean>('session.resetOnRunAll', true);
      if (!resetOnRunAll || modeOf(nb).mode !== 'session' || cells.length < 2) return;
      if (!isRunAll(nb, cells)) return; // a single cell, a range or Resume Run

      const stopped = pools.get(nb.uri.toString())?.stop() ?? [];
      if (stopped.length) vscode.window.setStatusBarMessage('md-runbook: Run All starts in a fresh session', 5000);
    },
  });

  /** Runs `fn` on the runbook's sessions; returns the shells it acted on (empty if none). */
  const forActive = (uri: unknown, fn: (pool: SessionPool) => string[] | Promise<string[]>): string[] | Promise<string[]> => {
    const nb = activeRunbook(uri);
    const pool = nb && pools.get(nb.uri.toString());
    if (!pool || pool.labels().length === 0) {
      void vscode.window.showInformationMessage('md-runbook: no session is running for this runbook.');
      return [];
    }
    return fn(pool);
  };

  /** Switch one runbook between session and isolated; returns the new mode. */
  const toggle = async (uri?: unknown, to?: Mode): Promise<Mode | undefined> => {
    const nb = activeRunbook(uri);
    if (!nb) return undefined;
    const next: Mode = to ?? (modeOf(nb).mode === 'session' ? 'isolated' : 'session');
    const all = { ...overrides() };
    // Store an override only when it differs from what the runbook would get anyway.
    if (next === inheritedMode(nb).mode) delete all[nb.uri.toString()];
    else all[nb.uri.toString()] = next;
    await context.workspaceState.update(OVERRIDE_KEY, all);
    if (next === 'isolated') disposePool(nb.uri.toString());
    updateStatus();
    vscode.window.setStatusBarMessage(`md-runbook: ${next === 'session' ? 'session mode on' : 'session mode off (isolated)'} for this runbook`, 5000);
    return next;
  };

  context.subscriptions.push(
    status,
    { dispose: disposeAll },
    vscode.commands.registerCommand('mdRunbook.toggleSessionMode', (uri?: unknown, to?: Mode) => toggle(uri, to)),
    // Toolbar buttons that name the current mode; both switch it.
    vscode.commands.registerCommand('mdRunbook.sessionModeOn', () => toggle()),
    vscode.commands.registerCommand('mdRunbook.sessionModeOff', () => toggle()),
    vscode.commands.registerCommand('mdRunbook.sessionMenu', async () => {
      const nb = activeRunbook();
      if (!nb) return;
      const { mode } = modeOf(nb);
      const running = (pools.get(nb.uri.toString())?.labels() ?? []).length > 0;
      const items = [
        { label: mode === 'session' ? '$(debug-disconnect) Switch to isolated' : '$(terminal) Switch to session mode', id: 'toggle' },
        ...(running ? [{ label: '$(debug-restart) Restart session', id: 'restart' }, { label: '$(debug-stop) Stop session', id: 'stop' }] : []),
      ];
      const pick = await vscode.window.showQuickPick(items, { title: 'md-runbook session' });
      if (pick?.id === 'toggle') await toggle();
      else if (pick?.id === 'restart') await vscode.commands.executeCommand('mdRunbook.restartSession');
      else if (pick?.id === 'stop') await vscode.commands.executeCommand('mdRunbook.stopSession');
    }),
    vscode.commands.registerCommand('mdRunbook.restartSession', (uri?: unknown) =>
      forActive(uri, async (pool) => {
        const shells = await pool.restart();
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
    vscode.commands.registerCommand('mdRunbook._sessionMode', (uri?: unknown) => {
      const nb = activeRunbook(uri);
      return nb ? modeOf(nb) : undefined;
    }),
    vscode.workspace.onDidCloseNotebookDocument((nb) => disposePool(nb.uri.toString())),
    vscode.window.onDidChangeActiveNotebookEditor(updateStatus),
    // Front matter edits can change the mode.
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.notebookType === NOTEBOOK_TYPE && e.cellChanges.some((c) => c.cell.index === 0)) pruneIsolated();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.execution.mode`)) pruneIsolated();
    }),
  );
  updateStatus();
}

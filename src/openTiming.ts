/**
 * How long a runbook takes to show its cells, and one hint after a slow open. VS Code shows no cell
 * until the notebook's hidden webview has loaded its Markdown renderers, and Chromium runs that
 * webview at idle priority while it is hidden, so on a busy computer an open can take a minute
 * (docs/investigations/notebook-open-slow.md). Starting VS Code with --disable-renderer-backgrounding
 * avoids it; nothing in an extension can.
 *
 * The time runs from the runbook's editor appearing to its first visible cells: VS Code reports an
 * editor's visible ranges only once its cell list is attached.
 */

import * as vscode from 'vscode';
import { NOTEBOOK_TYPE } from './serializer';

/** Opens slower than this get the hint. */
const SLOW_MS = 10_000;
const DONT_SHOW_KEY = 'mdRunbook.slowOpenHint.off';
export const TROUBLESHOOTING_URL = 'https://github.com/smojon/md-runbook/blob/main/docs/troubleshooting.md#a-runbook-opens-slowly-or-stays-empty';

export function registerOpenTiming(context: vscode.ExtensionContext): void {
  /** When each runbook editor appeared, until it shows cells. */
  const waiting = new Map<vscode.NotebookEditor, number>();
  let last: number | undefined;
  let hinted = false;

  const watch = (editors: readonly vscode.NotebookEditor[]): void => {
    for (const e of editors) {
      if (e.notebook.notebookType !== NOTEBOOK_TYPE || waiting.has(e)) continue;
      // Already showing cells (a tab switched back to): nothing to time.
      if (e.visibleRanges.length === 0) waiting.set(e, Date.now());
    }
    for (const e of [...waiting.keys()]) if (!editors.includes(e)) waiting.delete(e);
  };

  const hint = async (ms: number): Promise<void> => {
    if (hinted || context.globalState.get<boolean>(DONT_SHOW_KEY)) return;
    hinted = true; // once per session
    const s = Math.round(ms / 1000);
    const choice = await vscode.window.showInformationMessage(
      `md-runbook: this runbook took ${s} s to show its cells. VS Code delays notebooks when the computer is busy; starting VS Code with --disable-renderer-backgrounding avoids it.`,
      'Learn More',
      "Don't Show Again",
    );
    if (choice === 'Learn More') void vscode.env.openExternal(vscode.Uri.parse(TROUBLESHOOTING_URL));
    else if (choice === "Don't Show Again") await context.globalState.update(DONT_SHOW_KEY, true);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleNotebookEditors(watch),
    vscode.window.onDidChangeNotebookEditorVisibleRanges((e) => {
      const start = waiting.get(e.notebookEditor);
      if (start === undefined || e.visibleRanges.length === 0) return;
      waiting.delete(e.notebookEditor);
      last = Date.now() - start;
      if (last > SLOW_MS) void hint(last);
    }),
    // For tests and the open probe: the last measured open, in ms.
    vscode.commands.registerCommand('mdRunbook._lastOpenMs', () => last),
  );
  watch(vscode.window.visibleNotebookEditors);
}

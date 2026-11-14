/**
 * Notifications for a run you aren't looking at: when a run of several cells ends (done, or a
 * step failed) or starts waiting for you, while that runbook isn't the editor in front (another
 * editor, another window), say so, with a button to go there. Nothing while you watch it: the
 * status bar and the Steps view already say it. Off with mdRunbook.notifications.enabled.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION } from './config';
import { isCallCopy } from './calls';
import { RunPipeline } from './pipeline';
import { labelOf, notebookProgress } from './progress';
import { onDidChangeWaiting, waitingIn } from './waiting';

function enabled(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('notifications.enabled', true);
}

/** The reader isn't looking at `nb`: the window is in the background, or another editor is in front. */
export function lookingAway(nb: vscode.NotebookDocument): boolean {
  return !vscode.window.state.focused || vscode.window.activeNotebookEditor?.notebook !== nb;
}

const nameOf = (nb: vscode.NotebookDocument): string => path.posix.basename(nb.uri.path).replace(/\.md$/i, '');

/** Show the runbook with `index` selected and in view. */
async function goTo(nb: vscode.NotebookDocument, index: number | undefined): Promise<void> {
  const editor = await vscode.window.showNotebookDocument(nb);
  if (index === undefined || index < 0 || index >= nb.cellCount) return;
  const range = new vscode.NotebookRange(index, index + 1);
  editor.selections = [range];
  editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
}

/** The text of the end-of-run notification, or undefined when there is nothing to say (stopped by you). */
export function endMessage(nb: vscode.NotebookDocument): { text: string; failedCell?: number; failed: boolean } | undefined {
  const p = notebookProgress(nb);
  const name = nameOf(nb);
  if (p.firstFailed) {
    const label = labelOf(nb.cellAt(p.firstFailed.cell));
    return { text: `${name}: step ${p.firstFailed.step} of ${p.total} failed — ${label}`, failedCell: p.firstFailed.cell, failed: true };
  }
  if (p.pending === 0 && p.total > 0) return { text: `${name}: done · ${p.done + p.skipped} of ${p.total}${p.offered > 0 ? ' · teardown offered' : ''}`, failed: false };
  return undefined;
}

export function registerNotifications(pipeline: RunPipeline, context: vscode.ExtensionContext): void {
  pipeline.observers.push({
    // Not awaited: the controller waits for its observers, and a notification can stay up for hours.
    // A call's copy says nothing of its own: the calling cell reports on it.
    onDidRunSequence: (nb, runs) => {
      if (runs.length < 2 || !enabled() || !lookingAway(nb) || isCallCopy(nb.uri)) return;
      const m = endMessage(nb);
      if (!m) return;
      if (m.failed) {
        void vscode.window.showWarningMessage(`md-runbook: ${m.text}`, 'Go to Step', 'Resume Run').then(async (pick) => {
          if (pick === 'Go to Step') await goTo(nb, m.failedCell);
          if (pick === 'Resume Run') {
            await goTo(nb, m.failedCell);
            await vscode.commands.executeCommand('mdRunbook.resumeRun', nb.uri);
          }
        });
      } else {
        void vscode.window.showInformationMessage(`md-runbook: ${m.text}`, 'Open').then((pick) => (pick === 'Open' ? goTo(nb, undefined) : undefined));
      }
    },
  });
  // Waiting for you: once per question, only while you look away.
  const told = new Map<string, string>();
  context.subscriptions.push(
    onDidChangeWaiting(() => {
      for (const nb of vscode.workspace.notebookDocuments) {
        const w = waitingIn(nb);
        const key = nb.uri.toString();
        if (!w) {
          told.delete(key);
          continue;
        }
        const id = `${w.cell.index}#${w.what}`;
        if (told.get(key) === id || !enabled() || !lookingAway(nb)) continue;
        told.set(key, id);
        void vscode.window.showInformationMessage(`md-runbook: ${nameOf(nb)} waits for you: ${w.what}`, 'Show').then((pick) => {
          if (pick === 'Show') void goTo(nb, w.cell.index);
        });
      }
    }),
    // For tests: the end-of-run notification's text for the active runbook.
    vscode.commands.registerCommand('mdRunbook._endMessage', () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      return nb ? endMessage(nb) : undefined;
    }),
  );
}

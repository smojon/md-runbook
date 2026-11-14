/**
 * Notifications for a run you aren't looking at: when a run ends (done, or a step failed) or
 * starts waiting for you, while that runbook isn't the editor in front (another editor, another
 * window), say so, with a button to go there. Nothing while you watch it: the status bar and the
 * Steps view already say it. A run ending notifies when it took a while (several cells, or longer
 * than notifications.afterSeconds); a question notifies only when nothing else shows it (a value
 * box or a dialog already does), and its notice closes by itself once it is answered. With
 * notifications.system, the same goes to the system's notification centre while the window is in
 * the background. Off with mdRunbook.notifications.enabled.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatEstimate } from '@md-runbook/core';
import { SECTION } from './config';
import { isCallCopy } from './calls';
import { showRunbook } from './currentRunbook';
import { RunPipeline, RunRecord } from './pipeline';
import { labelOf, notebookProgress } from './progress';
import { onDidChangeWaiting, waitingIn } from './waiting';

const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(SECTION);
const enabled = (): boolean => cfg().get<boolean>('notifications.enabled', true);

/** The reader isn't looking at `nb`: the window is in the background, or another editor is in front. */
export function lookingAway(nb: vscode.NotebookDocument): boolean {
  return !vscode.window.state.focused || vscode.window.activeNotebookEditor?.notebook !== nb;
}

const nameOf = (nb: vscode.NotebookDocument): string => path.posix.basename(nb.uri.path).replace(/\.md$/i, '');

/** The text of the end-of-run notification, or undefined when there is nothing to say (stopped by you). */
export function endMessage(nb: vscode.NotebookDocument, runs?: readonly RunRecord[]): { text: string; failedCell?: number; failed: boolean } | undefined {
  const p = notebookProgress(nb);
  const name = nameOf(nb);
  // One cell run on its own (a long restore, say): about that step, not the whole runbook.
  const only = runs?.length === 1 ? runs[0] : undefined;
  if (only && !only.plan.skip) {
    const label = labelOf(only.cell);
    const step = p.stepOfCell[only.cell.index];
    const which = step !== undefined ? `step ${step} of ${p.total} ` : '';
    if (only.result.cancelled) return undefined;
    if (!only.success) return { text: `${name}: ${which}failed — ${label}`, failedCell: only.cell.index, failed: true };
    return { text: `${name}: ${which}done — ${label} (${formatEstimate(only.result.durationMs / 1000)})`, failed: false };
  }
  if (p.firstFailed) {
    const label = labelOf(nb.cellAt(p.firstFailed.cell));
    return { text: `${name}: step ${p.firstFailed.step} of ${p.total} failed — ${label}`, failedCell: p.firstFailed.cell, failed: true };
  }
  if (p.pending === 0 && p.total > 0) return { text: `${name}: done · ${p.done + p.skipped} of ${p.total}${p.offered > 0 ? ' · teardown offered' : ''}`, failed: false };
  return undefined;
}

/**
 * The system's own notification (outside VS Code), best effort and opt-in: the window may be
 * behind others, where VS Code's notifications aren't seen. The text goes in environment
 * variables, never into the command line.
 */
function systemNotify(title: string, body: string): void {
  if (!cfg().get<boolean>('notifications.system', false) || vscode.window.state.focused) return;
  const env = { ...process.env, MDRB_TITLE: title, MDRB_BODY: body };
  const run = (cmd: string, args: string[]): void => {
    try {
      const child = spawn(cmd, args, { env, stdio: 'ignore', windowsHide: true });
      child.on('error', () => undefined);
    } catch {
      // No notifier on this system: VS Code's own notification is still there.
    }
  };
  if (process.platform === 'win32') {
    const ps = [
      '$ErrorActionPreference = "Stop"',
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      '$t = $x.GetElementsByTagName("text")',
      '$t.Item(0).AppendChild($x.CreateTextNode($env:MDRB_TITLE)) | Out-Null',
      '$t.Item(1).AppendChild($x.CreateTextNode($env:MDRB_BODY)) | Out-Null',
      '$app = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
    ].join('; ');
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  } else if (process.platform === 'darwin') {
    run('osascript', ['-e', 'display notification (system attribute "MDRB_BODY") with title (system attribute "MDRB_TITLE")']);
  } else {
    run('notify-send', ['--app-name=md-runbook', '--', title, body]);
  }
}

/** Turn notifications off from a notification (its Don't Show Again). */
async function turnOff(): Promise<void> {
  await cfg().update('notifications.enabled', false, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage('md-runbook: notifications are off (mdRunbook.notifications.enabled).');
}

export function registerNotifications(pipeline: RunPipeline, context: vscode.ExtensionContext): void {
  /** When each runbook's run started, to tell a long run from a quick one. */
  const started = new Map<string, number>();
  pipeline.observers.push({
    onWillRunSequence: (nb) => void started.set(nb.uri.toString(), Date.now()),
    // Not awaited: the controller waits for its observers, and a notification can stay up for hours.
    // A call's copy says nothing of its own: the calling cell reports on it.
    onDidRunSequence: (nb, runs) => {
      const since = started.get(nb.uri.toString());
      started.delete(nb.uri.toString());
      const long = since !== undefined && Date.now() - since >= cfg().get<number>('notifications.afterSeconds', 30) * 1000;
      if (runs.length === 0 || (runs.length < 2 && !long) || !enabled() || !lookingAway(nb) || isCallCopy(nb.uri)) return;
      const m = endMessage(nb, runs);
      if (!m) return;
      systemNotify(nameOf(nb), m.text.slice(nameOf(nb).length + 2));
      const off = "Don't Show Again";
      if (m.failed) {
        void vscode.window.showWarningMessage(`md-runbook: ${m.text}`, 'Go to Step', 'Resume Run', off).then(async (pick) => {
          if (pick === off) return turnOff();
          if (pick === 'Go to Step') await showRunbook(nb, m.failedCell);
          if (pick === 'Resume Run') {
            await showRunbook(nb, m.failedCell);
            await vscode.commands.executeCommand('mdRunbook.resumeRun', nb.uri);
          }
        });
      } else {
        void vscode.window.showInformationMessage(`md-runbook: ${m.text}`, 'Open', off).then(async (pick) => {
          if (pick === off) await turnOff();
          if (pick === 'Open') await showRunbook(nb);
        });
      }
    },
  });
  // Waiting for you: one notice per question, only while you look away and only for a question
  // asked on the cell (a value box or a dialog shows itself); it closes once answered.
  const told = new Map<string, string>();
  const open = new Map<string, () => void>();
  /** Says so for each runbook that waits for an answer on a cell while you look away. */
  const checkWaiting = (): void => {
      for (const nb of vscode.workspace.notebookDocuments) {
        const key = nb.uri.toString();
        const w = waitingIn(nb);
        const id = w ? `${w.cell.index}#${w.what}` : undefined;
        if (told.has(key) && told.get(key) !== id) {
          open.get(key)?.();
          open.delete(key);
          told.delete(key);
        }
        if (!w || !id || w.where !== 'cell' || told.get(key) === id || !enabled() || !lookingAway(nb)) continue;
        told.set(key, id);
        systemNotify(nameOf(nb), `Waiting for you: ${w.what}`);
        void vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `md-runbook: ${nameOf(nb)} waits for you: ${w.what}. Answer on the cell (the status bar item shows it).` },
          () => new Promise<void>((resolve) => open.set(key, resolve)),
        );
      }
  };
  context.subscriptions.push(
    onDidChangeWaiting(checkWaiting),
    // A question asked while you watched, then you looked away: say so then.
    vscode.window.onDidChangeActiveNotebookEditor(checkWaiting),
    vscode.window.onDidChangeActiveTextEditor(checkWaiting),
    vscode.window.onDidChangeWindowState(checkWaiting),
    { dispose: () => open.forEach((close) => close()) },
    // For tests: the end-of-run notification's text for the active runbook.
    vscode.commands.registerCommand('mdRunbook._endMessage', () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      return nb ? endMessage(nb) : undefined;
    }),
  );
}

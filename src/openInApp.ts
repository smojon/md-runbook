/**
 * md-runbook: Open in the App: a link that opens this runbook in the md-runbook app on a phone
 * (`mdrunbook://open?url=…`, the file's GitHub or GitLab address), copied to send by mail or chat.
 * The phone downloads the pushed version, so the command says when the file has changes that are
 * not committed or not pushed. See docs/switching.md for the other ways (synced folders, sharing).
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runbookDigest } from '@md-runbook/core/runbookLink';
import { appLink, fileWebUrl } from './appLink';
import { NOTEBOOK_TYPE } from './serializer';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, windowsHide: true, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
  );
}

/** A file at a revision, exactly (not trimmed: the pin is over every byte). */
function gitShow(cwd: string, spec: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', ['show', spec], { cwd, windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    ),
  );
}

/** The runbook a command acts on: the one passed (Explorer), else the active notebook or editor. */
export function targetRunbook(uri?: unknown): vscode.Uri | undefined {
  const target =
    uri instanceof vscode.Uri ? uri : (vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri);
  if (!target || target.scheme !== 'file') return void vscode.window.showErrorMessage('md-runbook: open a runbook (a .md file) first.');
  return target;
}

/**
 * The runbook's GitHub or GitLab address and the pin of its pushed file (what a phone downloads),
 * for a link or a QR code. Says why there is none; warns when the pushed file differs from this
 * one, and `anyway` is the button that goes on regardless.
 */
export async function pushedRunbook(target: vscode.Uri, anyway: string): Promise<{ web: string; sha256?: string } | undefined> {
  const dir = path.dirname(target.fsPath);
  let root: string;
  let remote: string;
  let branch: string;
  try {
    root = await git(dir, ['rev-parse', '--show-toplevel']);
    remote = await git(dir, ['remote', 'get-url', 'origin']);
    branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return void vscode.window.showWarningMessage(
      'md-runbook: this runbook is not in a Git repository with a remote. Put it in a synced folder (iCloud Drive, OneDrive, Google Drive) and open it from Files in the app, or use Share from the app.',
    );
  }
  const rel = path.relative(root, target.fsPath);
  const web = fileWebUrl(remote, branch, rel);
  if (!web) return void vscode.window.showWarningMessage(`md-runbook: the app opens GitHub and GitLab links; this repository's remote is ${remote}.`);
  // The phone gets what is pushed: say so when that is not this file as it is here.
  const nb = vscode.workspace.notebookDocuments.find((d) => d.notebookType === NOTEBOOK_TYPE && d.uri.toString() === target.toString());
  const changed = (await git(dir, ['status', '--porcelain', '--', target.fsPath]).catch(() => '')) !== '' || nb?.isDirty === true;
  const ahead = Number(await git(dir, ['rev-list', '--count', '@{u}..HEAD']).catch(() => '0')) > 0;
  if (changed || ahead) {
    const go = await vscode.window.showWarningMessage(
      changed
        ? 'md-runbook: this runbook has changes that are not committed and pushed: the app will get the version on the server.'
        : 'md-runbook: this branch has commits that are not pushed: the app will get the version on the server.',
      anyway,
    );
    if (go !== anyway) return undefined;
  }
  // Pinned to the pushed file, the one the phone downloads (the blob: no CRLF from a checkout).
  const pushed = await gitShow(root, `origin/${branch}:${rel.split(path.sep).join('/')}`).catch(() => undefined);
  return { web, ...(pushed === undefined ? {} : { sha256: runbookDigest(pushed) }) };
}

async function openInApp(uri?: unknown): Promise<string | undefined> {
  const target = targetRunbook(uri);
  if (!target) return undefined;
  const pushed = await pushedRunbook(target, 'Copy the Link Anyway');
  if (!pushed) return undefined;
  const { web } = pushed;
  const link = appLink(web, pushed.sha256);
  await vscode.env.clipboard.writeText(link);
  void vscode.window
    .showInformationMessage(
      'md-runbook: link copied. Send it to your phone (mail, chat): it opens this runbook in the md-runbook app. Private repositories need the file to be reachable from the phone.',
      'Copy the Web Address',
    )
    .then((c) => c && vscode.env.clipboard.writeText(web));
  return link;
}

export function registerOpenInApp(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('mdRunbook.openInApp', openInApp));
}

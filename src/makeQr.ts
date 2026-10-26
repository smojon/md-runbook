/**
 * md-runbook: Make QR Code: a QR code of a runbook link (core/runbookLink.ts) for a label on a
 * machine, a slide or a screen: the runbook's pushed GitHub or GitLab file (pinned), or the
 * runbook itself in the code (no network needed), with an optional host and parameter values.
 * Written as <name>.qr.svg next to the runbook and opened; the link is copied too. The app's
 * Scan a code opens it. Label sheets for many machines: `md-runbook qr --labels` (cli/qr.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { clearOutputBlocks } from '@md-runbook/core';
import { qrMatrix, qrSvg } from '@md-runbook/core/qr';
import { RunbookLink, formatRunbookLink, linkableParams } from '@md-runbook/core/runbookLink';
import { VAR_NAME_RE } from '@md-runbook/core/secrets';
import { pushedRunbook, targetRunbook } from './openInApp';
import { NOTEBOOK_TYPE } from './serializer';

/** The runbook as it is now: an open notebook's unsaved text counts (as Export Report does). */
async function currentText(target: vscode.Uri): Promise<string> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
  if (doc) return doc.getText();
  const nb = vscode.workspace.notebookDocuments.find((d) => d.notebookType === NOTEBOOK_TYPE && d.uri.toString() === target.toString());
  if (nb?.isDirty) await nb.save();
  return fs.promises.readFile(target.fsPath, 'utf8');
}

async function makeQrCode(uri?: unknown): Promise<vscode.Uri | undefined> {
  const target = targetRunbook(uri);
  if (!target) return undefined;
  const text = await currentText(target);
  const carried = clearOutputBlocks(text);

  const kind = await vscode.window.showQuickPick(
    [
      {
        label: '$(github) Its address on GitHub or GitLab',
        detail: 'The phone downloads the pushed file; the code pins it, so a later change is refused.',
        id: 'url' as const,
      },
      {
        label: '$(package) The runbook itself',
        detail: `In the code, without outputs: works with no network (a code holds about 2 KB; this one needs ${Buffer.byteLength(formatRunbookLink({ text: carried, params: {} }))} bytes).`,
        id: 'text' as const,
      },
    ],
    { title: 'Make QR Code: what the code carries', placeHolder: 'Anyone can make a code: only a signed runbook says who approved it.' },
  );
  if (!kind) return undefined;
  const link: RunbookLink = { params: {} };
  if (kind.id === 'url') {
    const pushed = await pushedRunbook(target, 'Make the Code Anyway');
    if (!pushed) return undefined;
    link.url = pushed.web;
    if (pushed.sha256) link.sha256 = pushed.sha256;
  } else link.text = carried;

  const host = await vscode.window.showInputBox({
    title: 'Make QR Code: host (optional)',
    prompt: "The name of a host in the app to run on (as in the app's Hosts & settings). Empty: the app's own choice.",
    validateInput: (v) => (v === '' || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? undefined : 'A host name: letters, digits, . _ -'),
  });
  if (host === undefined) return undefined;
  if (host) link.host = host;
  for (const p of linkableParams(text)) {
    if (!VAR_NAME_RE.test(p.name)) continue;
    const value = await vscode.window.showInputBox({
      title: `Make QR Code: ${p.name} (optional)`,
      prompt: `A value for \${param:${p.name}}; empty: ${p.default !== undefined ? `the runbook's default (${p.default})` : 'typed in the app'}. One line.`,
      validateInput: (v) => (/[\r\n]/.test(v) ? 'One line' : undefined),
    });
    if (value === undefined) return undefined;
    if (value !== '') link.params[p.name] = value;
  }

  const text_ = formatRunbookLink(link);
  const matrix = qrMatrix(text_);
  if (!matrix) {
    return void vscode.window.showWarningMessage(
      `md-runbook: this is too much for a QR code (${Buffer.byteLength(text_)} bytes; a code holds 2953 at most). Use its address, or a shorter runbook.`,
    );
  }
  const name = path.basename(target.fsPath).replace(/\.md$/i, '');
  const out = vscode.Uri.file(path.join(path.dirname(target.fsPath), `${name}.qr.svg`));
  await fs.promises.writeFile(out.fsPath, qrSvg(matrix, { scale: 8, caption: host || name }) + '\n', 'utf8');
  await vscode.env.clipboard.writeText(text_);
  await vscode.commands.executeCommand('vscode.open', out);
  void vscode.window.showInformationMessage(
    `md-runbook: ${path.basename(out.fsPath)} written, and its link copied. Print it or show it: the app's Scan a code opens the runbook.`,
  );
  return out;
}

export function registerMakeQr(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('mdRunbook.makeQrCode', makeQrCode));
}

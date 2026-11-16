/**
 * A Markdown file never opens as a runbook by itself (the Markdown editor stays the default), and
 * nothing said it could. When a file that looks like one (a `.runbook.md` name, saved outputs, or
 * runbook front matter) opens in the text editor, offer it once: Open as Runbook, Always for
 * *.runbook.md (an editor association), or Don't Ask Again.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { NOTEBOOK_TYPE } from './serializer';
import { isTestMode } from './secrets';

const NEVER_KEY = 'mdRunbook.openHint.never';
/** Runbook front matter keys a plain Markdown page wouldn't have (`title` alone could be anything). */
const RUNBOOK_KEYS = /^(params|mode|shell|timeout|manual-steps|kube-context|kube-context-mode|env|envFile|cwd|output):/m;

/** Whether a Markdown file looks like a runbook. */
export function looksLikeRunbook(fileName: string, text: string): boolean {
  if (/\.runbook\.md$/i.test(fileName)) return true;
  if (text.includes('<!-- md-runbook:output')) return true;
  const fm = /^﻿?---[ \t]*(?:\r\n?|\n)([\s\S]*?)(?:\r\n?|\n)(?:---|\.\.\.)[ \t]*(?:\r\n?|\n|$)/.exec(text);
  return !!fm && RUNBOOK_KEYS.test(fm[1] ?? '');
}

export function registerOpenHint(context: vscode.ExtensionContext): void {
  /** Offered this session already (once per file). */
  const offered = new Set<string>();
  const check = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    const doc = editor?.document;
    if (!doc || doc.languageId !== 'markdown' || doc.uri.scheme !== 'file' || isTestMode(context)) return;
    if (context.globalState.get<boolean>(NEVER_KEY) || offered.has(doc.uri.toString())) return;
    const name = path.basename(doc.uri.fsPath);
    if (!looksLikeRunbook(name, doc.getText())) return;
    offered.add(doc.uri.toString());
    const open = 'Open as Runbook';
    const always = 'Always for *.runbook.md';
    const never = "Don't Ask Again";
    const buttons = /\.runbook\.md$/i.test(name) ? [open, always, never] : [open, never];
    const pick = await vscode.window.showInformationMessage(`md-runbook: ${name} looks like a runbook. Open it as a notebook to run its steps?`, ...buttons);
    if (pick === never) await context.globalState.update(NEVER_KEY, true);
    if (pick === always) {
      const cfg = vscode.workspace.getConfiguration('workbench');
      const associations = { ...(cfg.get<Record<string, string>>('editorAssociations') ?? {}), '*.runbook.md': NOTEBOOK_TYPE };
      await cfg.update('editorAssociations', associations, vscode.ConfigurationTarget.Global);
    }
    if (pick === open || pick === always) await vscode.commands.executeCommand('vscode.openWith', doc.uri, NOTEBOOK_TYPE);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => void check(e)));
  void check(vscode.window.activeTextEditor);
}

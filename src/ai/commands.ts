/**
 * AI assistance commands: Explain Output, Suggest Next Steps, Summarize Incident. Nothing is sent
 * until a provider is chosen (`mdRunbook.ai.provider`, default off) and the send is confirmed;
 * nothing an AI writes is ever run: suggestions arrive as proposed cells that need approval.
 */

import * as vscode from 'vscode';
import { PseudonymMap, depseudonymize } from '../core/aiContext';
import {
  AiPrompt,
  explainOutputPrompt,
  extractProposals,
  findingsMarkdown,
  isFindingsCell,
  proposalCell,
  suggestNextStepsPrompt,
  summarizeIncidentPrompt,
} from '../core/aiPrompt';
import { SECTION } from '../config';
import { META_KEY } from '../outputs';
import { NOTEBOOK_TYPE } from '../serializer';
import { buildContextForNotebook as buildContext } from '../aiContextGlue';
import { confirmNoLeaks } from '../aiCommands';
import { ANTHROPIC_KEY, AiError, AiProvider, createProvider, fakeProvider, providerSetting, useFakeProvider } from './providers';

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

const setGlobal = (key: string, value: unknown): Thenable<void> => cfg().update(key, value, vscode.ConfigurationTarget.Global);

function targetCell(arg: unknown): vscode.NotebookCell | undefined {
  const a = arg as Partial<vscode.NotebookCell> | undefined;
  if (a && typeof a.index === 'number' && a.notebook && a.document) return a as vscode.NotebookCell;
  return undefined;
}

function activeRunbook(arg: unknown): vscode.NotebookDocument | undefined {
  const cell = targetCell(arg);
  if (cell) return cell.notebook;
  if (arg instanceof vscode.Uri) {
    const nb = vscode.workspace.notebookDocuments.find((d) => d.notebookType === NOTEBOOK_TYPE && d.uri.toString() === arg.toString());
    if (nb) return nb;
  }
  const nb = vscode.window.activeNotebookEditor?.notebook;
  if (nb?.notebookType === NOTEBOOK_TYPE) return nb;
  void vscode.window.showInformationMessage('md-runbook: open a runbook first.');
  return undefined;
}

async function setAnthropicKey(): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: 'md-runbook: Anthropic API key',
    prompt: 'Stored in the OS keychain (VS Code SecretStorage). Used only when mdRunbook.ai.provider is "anthropic".',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === '' ? 'Enter a key.' : undefined),
  });
  if (!key) return false;
  await extContext.secrets.store(ANTHROPIC_KEY, key.trim());
  void vscode.window.showInformationMessage('md-runbook: Anthropic API key stored in the OS keychain.');
  return true;
}

async function clearAnthropicKey(): Promise<void> {
  await extContext.secrets.delete(ANTHROPIC_KEY);
  void vscode.window.showInformationMessage('md-runbook: Anthropic API key removed.');
}

/** The configured provider, after offering to enable or switch providers when needed. */
async function resolveProvider(): Promise<AiProvider | undefined> {
  const fake = fakeProvider();
  if (fake) return fake;
  let id = providerSetting();
  if (id === 'off') {
    const choice = await vscode.window.showInformationMessage(
      'md-runbook: AI assistance is off. Nothing from your runbooks is sent anywhere until you choose a provider.',
      {
        modal: true,
        detail:
          'VS Code Models: GitHub Copilot or another installed language model provider.\nAnthropic API: Claude with your own API key, stored in the OS keychain.\n\nThis sets mdRunbook.ai.provider in your user settings. Each send is still confirmed first.',
      },
      'Use VS Code Models',
      'Use Anthropic API',
      'Open Settings',
    );
    if (choice === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'mdRunbook.ai');
    if (choice !== 'Use VS Code Models' && choice !== 'Use Anthropic API') return undefined;
    id = choice === 'Use VS Code Models' ? 'vscode' : 'anthropic';
    await setGlobal('ai.provider', id);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const provider = createProvider(id, extContext.secrets);
    if (await provider.available()) return provider;
    if (id === 'vscode') {
      const choice = await vscode.window.showWarningMessage(
        'md-runbook: no VS Code language model is available. Install and sign in to GitHub Copilot (or another model provider), or use the Anthropic API with your own key.',
        'Use Anthropic API',
      );
      if (choice !== 'Use Anthropic API') return undefined;
      id = 'anthropic';
      await setGlobal('ai.provider', id);
    } else {
      const choice = await vscode.window.showWarningMessage('md-runbook: no Anthropic API key is set.', 'Set API Key', 'Use VS Code Models');
      if (choice === 'Set API Key') {
        if (!(await setAnthropicKey())) return undefined;
      } else if (choice === 'Use VS Code Models') {
        id = 'vscode';
        await setGlobal('ai.provider', id);
      } else return undefined;
    }
  }
  return undefined;
}

const confirmedThisSession = new Set<string>();

async function openUntitled(content: string, language: string, beside: boolean): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, { viewColumn: beside ? vscode.ViewColumn.Beside : undefined, preview: false, preserveFocus: beside });
  return doc;
}

/** Warnings, then the send confirmation (with Preview of the exact text). */
async function confirmSend(provider: AiProvider, prompt: AiPrompt, pseudonymized: boolean, warnings: string[]): Promise<boolean> {
  if (warnings.length) {
    const go = await vscode.window.showWarningMessage(
      'md-runbook: the runbook contains text that may try to instruct the AI.',
      { modal: true, detail: `${warnings.slice(0, 10).join('\n')}${warnings.length > 10 ? `\n… and ${warnings.length - 10} more` : ''}\n\nIt is sent marked as untrusted data, and suggestions always need your approval.` },
      'Continue',
    );
    if (go !== 'Continue') return false;
  }
  if (!cfg().get<boolean>('ai.confirmBeforeSend', true)) return true;
  const once = cfg().get<boolean>('ai.confirmOncePerSession', false);
  if (once && confirmedThisSession.has(provider.label)) return true;
  const chars = prompt.system.length + prompt.user.length;
  for (;;) {
    const choice = await vscode.window.showWarningMessage(
      `md-runbook: send ${chars.toLocaleString('en-US')} characters of this runbook to ${provider.label}?`,
      {
        modal: true,
        detail: `Outputs are redacted and marked as untrusted. Names pseudonymized: ${pseudonymized ? 'yes' : 'no (mdRunbook.ai.pseudonymize is off)'}.\nNothing is run: suggestions are inserted as proposed cells that need your approval.`,
      },
      'Send',
      'Preview',
    );
    if (choice === 'Preview') {
      await openUntitled(`${prompt.system}\n\n---\n\n${prompt.user}`, 'markdown', false);
      continue;
    }
    if (choice !== 'Send') return false;
    if (once) confirmedThisSession.add(provider.label);
    return true;
  }
}

interface Answer {
  text: string;
  provider: AiProvider;
  map: PseudonymMap;
}

/** Build context, confirm, ask; resolves to the answer with aliases mapped back, or undefined. */
async function ask(nb: vscode.NotebookDocument, cells: number[] | undefined, build: (runbook: string) => AiPrompt, title: string): Promise<Answer | undefined> {
  const provider = await resolveProvider();
  if (!provider) return undefined;
  const ctx = await buildContext(extContext, nb, cells);
  // Sending to a model is sharing: the same leak check as Copy for AI applies.
  if (!(await confirmNoLeaks(ctx.text, 'Send'))) return undefined;
  const prompt = build(ctx.text);
  const pseudonymized = cfg().get<boolean>('ai.pseudonymize', true);
  if (!(await confirmSend(provider, prompt, pseudonymized, ctx.warnings))) return undefined;
  try {
    const raw = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `md-runbook: ${title} (${provider.label})`, cancellable: true },
      async (progress, token) => {
        let received = 0;
        const text = await provider.complete(prompt.system, prompt.user, token, (chunk) => {
          received += chunk.length;
          progress.report({ message: `${received.toLocaleString('en-US')} characters received` });
        });
        return token.isCancellationRequested ? undefined : text;
      },
    );
    if (raw === undefined) return undefined;
    if (raw.trim() === '') {
      void vscode.window.showWarningMessage('md-runbook: the AI returned an empty answer.');
      return undefined;
    }
    return { text: raw, provider, map: ctx.map };
  } catch (e) {
    const msg = e instanceof AiError ? e.message : e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`md-runbook: ${msg}`);
    return undefined;
  }
}

function codeCellsUpTo(nb: vscode.NotebookDocument, index: number): number[] {
  return nb
    .getCells()
    .filter((c) => c.kind === vscode.NotebookCellKind.Code && c.index <= index)
    .map((c) => c.index);
}

const cellLabel = (cell: vscode.NotebookCell): string => `cell ${cell.index + 1}`;

async function insertCells(nb: vscode.NotebookDocument, at: number, cells: vscode.NotebookCellData[]): Promise<boolean> {
  const edit = new vscode.WorkspaceEdit();
  edit.set(nb.uri, [vscode.NotebookEdit.insertCells(at, cells)]);
  const ok = await vscode.workspace.applyEdit(edit);
  const editor = vscode.window.visibleNotebookEditors.find((e) => e.notebook === nb);
  if (ok && editor) {
    const range = new vscode.NotebookRange(at, at + cells.length);
    editor.selection = range;
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
  }
  return ok;
}

/** Explain Output: the answer opens beside as an untitled document; "Insert as note" adds it below the cell. */
async function explainOutput(arg?: unknown): Promise<vscode.Uri | undefined> {
  const nb = activeRunbook(arg);
  if (!nb) return undefined;
  const editor = vscode.window.activeNotebookEditor;
  const cell = targetCell(arg) ?? (editor?.notebook === nb && nb.cellCount ? nb.cellAt(editor.selection.start) : undefined);
  if (!cell || cell.kind !== vscode.NotebookCellKind.Code || cell.outputs.length === 0) {
    void vscode.window.showInformationMessage('md-runbook: select a code cell with output to explain.');
    return undefined;
  }
  const label = cellLabel(cell);
  const answer = (await ask(nb, codeCellsUpTo(nb, cell.index), (r) => explainOutputPrompt(r, label), `explaining ${label}`));
  if (!answer) return undefined;
  const text = depseudonymize(answer.text, answer.map).trim();
  const doc = await openUntitled(
    `# Explanation of ${label} (AI)\n\n> Generated by ${answer.provider.label}. Not added to the runbook; it may be wrong.\n\n${text}\n`,
    'markdown',
    true,
  );
  void vscode.window.showInformationMessage(`md-runbook: explanation of ${label} opened beside. It was not added to the runbook.`, 'Insert as Note').then(async (choice) => {
    if (choice !== 'Insert as Note') return;
    const note = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, `> **AI note on ${label}** (draft by ${answer.provider.label}, not verified)\n\n${text}`, 'markdown');
    await insertCells(nb, cell.index + 1, [note]);
  });
  return doc.uri;
}

/** Suggest Next Steps: proposals become new proposed code cells (never run). Resolves to how many were inserted. */
async function suggestNextSteps(arg?: unknown): Promise<number> {
  const nb = activeRunbook(arg);
  if (!nb) return 0;
  const cell = targetCell(arg);
  const max = Math.max(1, cfg().get<number>('ai.maxProposals', 3));
  const answer = (await ask(
    nb,
    cell ? codeCellsUpTo(nb, cell.index) : undefined,
    (r) => suggestNextStepsPrompt(r, max, cell ? cellLabel(cell) : undefined),
    'suggesting next steps',
  ));
  if (!answer) return 0;
  const proposals = extractProposals(answer.text, answer.map).slice(0, max);
  if (proposals.length === 0) {
    const choice = await vscode.window.showInformationMessage('md-runbook: the AI did not propose any commands.', 'Show Answer');
    if (choice === 'Show Answer') await openUntitled(depseudonymize(answer.text, answer.map), 'markdown', true);
    return 0;
  }
  const by = cfg().get<string>('ai.proposerName', 'ai') || 'ai';
  const eol = (nb.metadata?.[META_KEY] as { eol?: string } | undefined)?.eol === '\r\n' ? '\r\n' : '\n';
  const at = cell ? cell.index + 1 : nb.cellCount;
  const data = proposals.map((p, i) => {
    const c = proposalCell(p, by, eol, at === nb.cellCount && i === proposals.length - 1);
    const d = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, c.value, c.languageId);
    d.metadata = { [META_KEY]: c.meta };
    return d;
  });
  if (!(await insertCells(nb, at, data))) return 0;
  void vscode.window.showInformationMessage(
    `md-runbook: inserted ${data.length} proposed cell${data.length === 1 ? '' : 's'} from ${answer.provider.label}. Review each one; proposed cells must be approved before they can run.`,
  );
  return data.length;
}

/** Summarize Incident: inserts or updates the "## Findings (AI draft)" markdown cell at the end. */
async function summarizeIncident(arg?: unknown): Promise<boolean> {
  const nb = activeRunbook(arg);
  if (!nb) return false;
  const existing = nb.getCells().find((c) => c.kind === vscode.NotebookCellKind.Markup && isFindingsCell(c.document.getText()));
  const answer = (await ask(nb, undefined, summarizeIncidentPrompt, 'drafting findings'));
  if (!answer) return false;
  const text = findingsMarkdown(depseudonymize(answer.text, answer.map), answer.provider.label).replace(/\n$/, '');
  if (existing) {
    const doc = existing.document;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    return vscode.workspace.applyEdit(edit);
  }
  return insertCells(nb, nb.cellCount, [new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, text, 'markdown')]);
}

let extContext: vscode.ExtensionContext;

export function registerAi(context: vscode.ExtensionContext): void {
  extContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('mdRunbook.ai.explainOutput', explainOutput),
    vscode.commands.registerCommand('mdRunbook.ai.suggestNextSteps', suggestNextSteps),
    vscode.commands.registerCommand('mdRunbook.ai.summarizeIncident', summarizeIncident),
    vscode.commands.registerCommand('mdRunbook.ai.setAnthropicKey', setAnthropicKey),
    vscode.commands.registerCommand('mdRunbook.ai.clearAnthropicKey', clearAnthropicKey),
    // Hidden, for integration tests: canned answers instead of a real model (undefined = off).
    vscode.commands.registerCommand('mdRunbook._ai.useFakeProvider', (answer?: string) => useFakeProvider(answer)),
  );
}

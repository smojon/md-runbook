/** Commands: Copy for AI, Paste AI Proposal, Check for Leaks (and the leak check before sharing). */

import * as vscode from 'vscode';
import { DocMeta, isDocMeta, isRunnableFenceLang, languageIdForFence } from './core';
import { AiContext, codeMetaFor, depseudonymize, extractFencedBlocks, proposalMarkdown } from './core/aiContext';
import { LeakFinding, scanForLeaks, summarizeLeaks } from './core/leaks';
import { pastedBy, pastedReason } from './core/pastedInfo';
import { proposedInfo } from './core/proposal';
import { aiSettings, buildMarkdownContext, getPseudonymMap, parsedCodeIndices, runbookText, savePseudonymMap } from './aiContextGlue';
import { writeOptions } from './config';
import { META_KEY, outputMeta } from './outputs';
import { NOTEBOOK_TYPE } from './serializer';

export const COPY_FOR_AI = 'mdRunbook.copyForAi';
export const COPY_CELL_FOR_AI = 'mdRunbook.copyCellForAi';
export const PASTE_AI_PROPOSAL = 'mdRunbook.pasteAiProposal';
export const CHECK_FOR_LEAKS = 'mdRunbook.checkForLeaks';

export interface CopyOptions {
  /** Notebook cell indices; default: the whole runbook (Copy for AI) or the selection (Copy Cell for AI). */
  cells?: number[];
  /** Show the summary QuickPick before copying (default true). */
  preview?: boolean;
}

const decoder = new TextDecoder();

function isCell(v: unknown): v is vscode.NotebookCell {
  return typeof v === 'object' && v !== null && 'notebook' in v && 'index' in v && 'document' in v;
}

function findNotebook(arg: unknown): vscode.NotebookDocument | undefined {
  if (isCell(arg)) return arg.notebook;
  const uri = arg instanceof vscode.Uri ? arg : undefined;
  const nb = uri
    ? vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString())
    : vscode.window.activeNotebookEditor?.notebook;
  return nb?.notebookType === NOTEBOOK_TYPE ? nb : undefined;
}

function selectedCells(notebook: vscode.NotebookDocument): number[] {
  const editor = vscode.window.activeNotebookEditor;
  if (editor?.notebook !== notebook) return [];
  return editor.selections.flatMap((r) => Array.from({ length: r.end - r.start }, (_, k) => r.start + k));
}

function disabled(): boolean {
  if (aiSettings().copyForAiEnabled) return false;
  void vscode.window.showInformationMessage('md-runbook: Copy for AI is turned off (mdRunbook.ai.copyForAi.enabled).');
  return true;
}

async function showFindings(findings: readonly LeakFinding[], where: (f: LeakFinding) => string, onPick?: (f: LeakFinding) => void): Promise<void> {
  const items = findings.map((f) => ({ label: `$(warning) ${f.kind}`, description: where(f), detail: f.preview, finding: f }));
  const pick = await vscode.window.showQuickPick(items, { title: `md-runbook: ${findings.length} possible leak(s)`, matchOnDescription: true });
  if (pick && onPick) onPick(pick.finding);
}

/**
 * Leak check before text leaves the editor (Copy for AI, Export Report). Resolves to true when
 * nothing was found, the check is off, or the user explicitly chose to share anyway.
 */
export async function confirmNoLeaks(text: string, action = 'Share'): Promise<boolean> {
  const s = aiSettings();
  if (!s.checkBeforeShare) return true;
  const findings = scanForLeaks(text, { internalDomains: s.internalDomains });
  if (findings.length === 0) return true;
  const anyway = `${action} Anyway`;
  const choice = await vscode.window.showWarningMessage(
    `md-runbook: ${findings.length} possible leak(s) found (${summarizeLeaks(findings)}). Nothing was shared.`,
    { modal: true, detail: 'Review them with "Show Findings", or add the values to the redaction patterns.' },
    'Show Findings',
    anyway,
  );
  if (choice === 'Show Findings') await showFindings(findings, (f) => `line ${f.line}, column ${f.column}`);
  return choice === anyway;
}

function previewItems(ctx: AiContext, cells: number, names: number): Array<vscode.QuickPickItem & { copy?: boolean }> {
  const items: Array<vscode.QuickPickItem & { copy?: boolean }> = [
    {
      label: '$(copy) Copy to Clipboard',
      description: `${ctx.text.length} characters · ${cells} step(s) · ${names} name(s) pseudonymized`,
      copy: true,
    },
    { label: '$(close) Cancel' },
  ];
  if (ctx.warnings.length) {
    items.push({ label: 'Warnings', kind: vscode.QuickPickItemKind.Separator });
    for (const w of ctx.warnings) items.push({ label: `$(warning) ${w}` });
  }
  return items;
}

/** Copy for AI. Resolves to the copied text, or undefined when nothing was copied. */
export async function copyForAi(context: vscode.ExtensionContext, arg?: unknown, opts: CopyOptions = {}, selection = false): Promise<string | undefined> {
  if (disabled()) return undefined;
  const notebook = findNotebook(arg);
  let markdown: string;
  let uri: vscode.Uri;
  let cells: number[] | undefined;
  if (notebook) {
    markdown = runbookText(notebook);
    uri = notebook.uri;
    let picked = opts.cells;
    if (!picked && isCell(arg)) {
      const sel = selectedCells(notebook);
      picked = sel.includes(arg.index) ? sel : [arg.index];
    }
    if (!picked && selection) picked = selectedCells(notebook);
    cells = picked ? parsedCodeIndices(notebook, markdown, picked) : undefined;
    if (picked && cells?.length === 0) {
      void vscode.window.showInformationMessage('md-runbook: select one or more code cells to copy.');
      return undefined;
    }
  } else {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== 'markdown') {
      void vscode.window.showInformationMessage('md-runbook: open a runbook to copy it for AI.');
      return undefined;
    }
    markdown = doc.getText();
    uri = doc.uri;
  }

  const ctx = buildMarkdownContext(context, markdown, uri, cells);
  const s = aiSettings(uri);
  if (!(await confirmNoLeaks(ctx.text, 'Copy'))) return undefined;
  const names = Object.values(ctx.map.forward).filter((a) => ctx.text.includes(a)).length;
  const steps = (ctx.text.match(/^```+(?:sh|bash|pwsh|powershell|cmd)\b/gm) ?? []).length;
  if (opts.preview !== false) {
    const pick = await vscode.window.showQuickPick(previewItems(ctx, steps, names), { title: 'md-runbook: Copy for AI' });
    if (!pick?.copy) return undefined;
  }
  const text = s.copyHeader.trim() ? `${s.copyHeader.trim()}\n\n${ctx.text}\n` : `${ctx.text}\n`;
  await vscode.env.clipboard.writeText(text);
  await savePseudonymMap(context, ctx.map);
  void vscode.window.showInformationMessage(
    `md-runbook: copied ${text.length} characters for AI${names ? ` (${names} name(s) pseudonymized)` : ''}${ctx.warnings.length ? `, ${ctx.warnings.length} warning(s)` : ''}.`,
  );
  return text;
}

/** Paste AI Proposal. Resolves to the number of cells inserted. */
export async function pasteAiProposal(context: vscode.ExtensionContext): Promise<number> {
  if (disabled()) return 0;
  const editor = vscode.window.activeNotebookEditor;
  if (editor?.notebook.notebookType !== NOTEBOOK_TYPE) {
    void vscode.window.showInformationMessage('md-runbook: open a runbook to paste an AI proposal.');
    return 0;
  }
  const blocks = extractFencedBlocks(await vscode.env.clipboard.readText());
  if (blocks.length === 0) {
    void vscode.window.showInformationMessage('md-runbook: the clipboard contains no fenced code blocks.');
    return 0;
  }
  const map = getPseudonymMap(context);
  const docMeta: DocMeta | undefined = isDocMeta(editor.notebook.metadata?.[META_KEY]) ? editor.notebook.metadata[META_KEY] : undefined;
  const eol = docMeta?.eol ?? '\n';
  const cells = blocks.map((b) => {
    const code = depseudonymize(b.code, map);
    // Nested quotes in reason= are tolerated; proposedInfo sanitizes reason and by= (kept as given).
    const rawReason = b.lang ? pastedReason(b.info) : undefined;
    const reason = rawReason !== undefined && rawReason.trim() !== '' ? depseudonymize(rawReason, map) : undefined;
    if (!isRunnableFenceLang(b.lang)) {
      return new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, proposalMarkdown({ ...b, code, reason }), 'markdown');
    }
    // Always a proposed cell: it must be approved before it can run.
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, languageIdForFence(b.lang));
    cell.metadata = { [META_KEY]: codeMetaFor(proposedInfo(b.lang, pastedBy(b.info), reason), code, eol) };
    return cell;
  });
  const at = editor.selections.length ? Math.max(...editor.selections.map((r) => r.end)) : editor.notebook.cellCount;
  const index = Math.min(Math.max(at, 0), editor.notebook.cellCount);
  const edit = new vscode.WorkspaceEdit();
  edit.set(editor.notebook.uri, [vscode.NotebookEdit.insertCells(index, cells)]);
  if (!(await vscode.workspace.applyEdit(edit))) return 0;
  const range = new vscode.NotebookRange(index, index + cells.length);
  editor.selections = [range];
  editor.revealRange(range);
  void vscode.window.showInformationMessage(`md-runbook: inserted ${cells.length} proposed cell(s). Review and approve before running.`);
  return cells.length;
}

function cellOutputText(cell: vscode.NotebookCell): string {
  return cell.outputs
    .filter((o) => !outputMeta(o)?.status)
    .flatMap((o) => o.items.filter((i) => !i.mime.startsWith('image/')).map((i) => decoder.decode(i.data)))
    .join('');
}

interface CellFinding extends LeakFinding {
  cell?: number;
  where: 'code' | 'output' | 'text';
}

/** Check for Leaks: code as written, outputs as they would be saved (redacted). Resolves to the findings. */
export async function checkForLeaks(arg?: unknown): Promise<CellFinding[]> {
  const s = aiSettings();
  const scan = { internalDomains: s.internalDomains };
  const notebook = findNotebook(arg);
  const findings: CellFinding[] = [];
  if (notebook) {
    const redact = writeOptions().redact ?? ((t: string) => t);
    for (const cell of notebook.getCells()) {
      for (const f of scanForLeaks(cell.document.getText(), scan)) findings.push({ ...f, cell: cell.index, where: 'code' });
      if (cell.kind === vscode.NotebookCellKind.Code) {
        for (const f of scanForLeaks(redact(cellOutputText(cell)), scan)) findings.push({ ...f, cell: cell.index, where: 'output' });
      }
    }
  } else {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.languageId !== 'markdown') {
      void vscode.window.showInformationMessage('md-runbook: open a runbook or Markdown file to check it for leaks.');
      return [];
    }
    for (const f of scanForLeaks(doc.getText(), scan)) findings.push({ ...f, where: 'text' });
  }
  if (findings.length === 0) {
    void vscode.window.showInformationMessage('md-runbook: no possible leaks found.');
    return findings;
  }
  const where = (f: LeakFinding): string => {
    const c = f as CellFinding;
    return c.cell === undefined ? `line ${f.line}` : `cell ${c.cell + 1} ${c.where}, line ${f.line}`;
  };
  void showFindings(findings, where, (f) => {
    const c = f as CellFinding;
    if (notebook && c.cell !== undefined) {
      const range = new vscode.NotebookRange(c.cell, c.cell + 1);
      void vscode.window.showNotebookDocument(notebook, { selections: [range] }).then((e) => e.revealRange(range, vscode.NotebookEditorRevealType.InCenter));
    } else {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const pos = new vscode.Position(f.line - 1, f.column - 1);
      editor.selection = new vscode.Selection(pos, pos.translate(0, f.length));
      editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);
    }
  });
  return findings;
}

export function registerAiContext(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COPY_FOR_AI, (arg?: unknown, opts?: CopyOptions) => copyForAi(context, arg, opts)),
    vscode.commands.registerCommand(COPY_CELL_FOR_AI, (arg?: unknown, opts?: CopyOptions) => copyForAi(context, arg, opts, true)),
    vscode.commands.registerCommand(PASTE_AI_PROPOSAL, () => pasteAiProposal(context)),
    vscode.commands.registerCommand(CHECK_FOR_LEAKS, checkForLeaks),
  );
}

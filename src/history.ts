/** Output history, Run All as Copy and Compare With Previous Run. */

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CellInput,
  HISTORY_KEY,
  HistoryEntry,
  RunHistory,
  clearOutputBlocks,
  copyFileName,
  isCodeMeta,
  isCopyFileName,
  isRunHistory,
  loadedOutputEntry,
  nextHistory,
  processOutputText,
  serialize,
} from './core';
import { SECTION, writeOptions } from './config';
import { workingDirectory } from './controller';
import { META_KEY, toOutputInput } from './outputs';
import { CellPlan, PrepareContext, RunPipeline } from './pipeline';
import { NOTEBOOK_TYPE } from './serializer';

const SCHEME = 'md-runbook-run';
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

/** A cell's current output (as it would be written) and the one before it. */
function outputsOf(
  outputs: readonly vscode.NotebookCellOutput[],
  metadata: Record<string, unknown> | undefined,
): { current?: HistoryEntry; older: HistoryEntry[] } {
  const input = toOutputInput(outputs);
  if (input?.kind === 'preserved') {
    const meta = metadata?.[META_KEY];
    if (!isCodeMeta(meta)) return { older: [] };
    return { current: loadedOutputEntry(meta), older: meta.history?.entries ?? [] };
  }
  if (!input) return { older: [] };
  const stored = metadata?.[HISTORY_KEY];
  return {
    current: { text: processOutputText(input.text, writeOptions()), attrs: input.attrs },
    older: isRunHistory(stored) ? stored.history : [],
  };
}

/** Before a run: remember the cell's previous output (for `changed=` and the history block). */
async function captureHistory(_plan: CellPlan, ctx: PrepareContext): Promise<void> {
  const { cell, notebook } = ctx;
  const { current: previous, older } = outputsOf(ctx.previousOutputs ?? [], cell.metadata);
  if (!previous && cell.metadata?.[HISTORY_KEY] === undefined) return;
  const size = Math.max(0, Math.floor(cfg().get<number>('output.historySize', 0)));
  const metadata: Record<string, unknown> = { ...cell.metadata };
  if (previous) metadata[HISTORY_KEY] = { previous, history: nextHistory(previous, older, size) } satisfies RunHistory;
  else delete metadata[HISTORY_KEY];
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, metadata)]);
  await vscode.workspace.applyEdit(edit);
}

// ---- Run All as Copy ---------------------------------------------------------------------------

/** Copies made in another folder -> folder of the original, so cells still run where they belong. */
const copyOrigins = new Map<string, string>();
const copyHinted = new Set<string>();

function isCopy(uri: vscode.Uri): boolean {
  return copyOrigins.has(uri.toString()) || isCopyFileName(path.basename(uri.path));
}

function copyPreparer(plan: CellPlan, ctx: PrepareContext): void {
  const uri = ctx.notebook.uri;
  const origin = copyOrigins.get(uri.toString());
  if (origin && plan.cwd === workingDirectory(uri)) plan.cwd = origin;
  if (cfg().get<string>('output.mode', 'inPlace') !== 'copy' || isCopy(uri) || copyHinted.has(uri.toString())) return;
  copyHinted.add(uri.toString());
  void vscode.window
    .showInformationMessage('md-runbook: output mode is "copy". Use Run All as Copy to keep this runbook free of outputs.', 'Run All as Copy')
    .then((choice) => choice && vscode.commands.executeCommand('mdRunbook.runAllAsCopy', uri));
}

/** The runbook's current content (unsaved edits included) without any output blocks. */
async function contentWithoutOutputs(uri: vscode.Uri): Promise<string> {
  const nb = vscode.workspace.notebookDocuments.find((d) => d.notebookType === NOTEBOOK_TYPE && d.uri.toString() === uri.toString());
  if (nb) {
    const cells: CellInput[] = nb.getCells().map((c) => ({
      kind: c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup',
      value: c.document.getText(),
      languageId: c.document.languageId,
      meta: c.metadata?.[META_KEY],
    }));
    return serialize(nb.metadata?.[META_KEY], cells, writeOptions());
  }
  const textDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return clearOutputBlocks(textDoc ? textDoc.getText() : decoder.decode(await vscode.workspace.fs.readFile(uri)));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function waitForEditor(uri: vscode.Uri): Promise<vscode.NotebookEditor> {
  const end = Date.now() + 15_000;
  for (;;) {
    const editor = vscode.window.visibleNotebookEditors.find((e) => e.notebook.uri.toString() === uri.toString());
    if (editor) return editor;
    if (Date.now() > end) throw new Error(`could not open ${uri.fsPath} as a runbook`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function sourceUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  return vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
}

/** Copy the runbook without outputs to `<name>.<yyyyMMdd-HHmmss>.md`, open it, run all and save. */
async function runAllAsCopy(arg?: unknown): Promise<vscode.Uri | undefined> {
  const source = sourceUri(arg);
  if (!source) return undefined;
  const text = await contentWithoutOutputs(source);
  const dir = vscode.Uri.joinPath(source, '..');
  const folderSetting = cfg().get<string>('output.copyFolder', '').trim();
  const folder =
    folderSetting === ''
      ? dir
      : path.isAbsolute(folderSetting)
        ? vscode.Uri.file(folderSetting)
        : vscode.Uri.joinPath(dir, ...folderSetting.split(/[\\/]+/).filter(Boolean));
  await vscode.workspace.fs.createDirectory(folder);

  const name = copyFileName(path.basename(source.path), new Date());
  let target = vscode.Uri.joinPath(folder, name);
  for (let n = 2; await exists(target); n++) target = vscode.Uri.joinPath(folder, name.replace(/\.md$/i, `-${n}.md`));
  await vscode.workspace.fs.writeFile(target, encoder.encode(text));
  if (folder.toString() !== dir.toString()) copyOrigins.set(target.toString(), workingDirectory(source));

  await vscode.commands.executeCommand('vscode.openWith', target, NOTEBOOK_TYPE);
  const editor = await waitForEditor(target);
  await vscode.commands.executeCommand('notebook.selectKernel', { notebookEditor: editor, id: 'md-runbook-shell', extension: 'smojon.md-runbook' });
  await vscode.commands.executeCommand('notebook.execute', target);
  await editor.notebook.save();
  return target;
}

// ---- Compare With Previous Run -----------------------------------------------------------------

const contents = new Map<string, string>();
let compareCount = 0;

function targetCell(arg: unknown): vscode.NotebookCell | undefined {
  const a = arg as Partial<vscode.NotebookCell> | undefined;
  if (a && typeof a.index === 'number' && a.notebook && a.document) return a as vscode.NotebookCell;
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE || editor.notebook.cellCount === 0) return undefined;
  return editor.notebook.cellAt(editor.selection.start);
}

async function compareWithPrevious(arg?: unknown): Promise<void> {
  const cell = targetCell(arg);
  if (!cell || cell.kind !== vscode.NotebookCellKind.Code) return;
  const { current, older } = outputsOf(cell.outputs, cell.metadata);
  const stored = cell.metadata?.[HISTORY_KEY];
  const persisted = toOutputInput(cell.outputs)?.kind === 'preserved';
  const previous = persisted ? older[0] : isRunHistory(stored) ? stored.previous : undefined;
  if (!current || !previous) {
    void vscode.window.showInformationMessage('md-runbook: this cell has no previous run to compare with.');
    return;
  }
  const n = ++compareCount;
  const doc = (label: string, entry: HistoryEntry): vscode.Uri => {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/cell-${cell.index + 1}-${label}.txt`, query: String(n) });
    contents.set(uri.toString(), entry.text === '' ? '' : entry.text + '\n');
    return uri;
  };
  // Keep only the last few comparisons around.
  for (const key of [...contents.keys()].slice(0, Math.max(0, contents.size - 20))) contents.delete(key);
  const when = (e: HistoryEntry): string => e.attrs.ran ?? '?';
  await vscode.commands.executeCommand(
    'vscode.diff',
    doc('previous', previous),
    doc('latest', current),
    `Cell ${cell.index + 1}: ${when(previous)} ↔ ${when(current)}`,
  );
}

export function registerHistory(context: vscode.ExtensionContext, pipeline: RunPipeline): void {
  pipeline.preparers.push({ prepare: captureHistory }, { prepare: copyPreparer });
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: (uri) => contents.get(uri.toString()) ?? '' }),
    vscode.commands.registerCommand('mdRunbook.runAllAsCopy', runAllAsCopy),
    vscode.commands.registerCommand('mdRunbook.compareWithPreviousRun', compareWithPrevious),
  );
}

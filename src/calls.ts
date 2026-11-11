/**
 * Runbook calls in VS Code (core/call.ts): a ```runbook cell runs another runbook as one step.
 * The runbook called is copied (core/node/call.ts), opened beside this one, and its cells (those
 * in `section=`, not those done in an earlier run of the same copy) run there with the parameters
 * the call passes, which are never asked for again. The call cell shows each step as it finishes
 * and records the copy (runbook=, copy=, steps=, sha256=).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ExecuteResult, isCodeMeta, locateCodeCells, parse, stepState, taskItems } from '@md-runbook/core';
import { CallResult, callAttrs, callChainProblem, callFromAttrs, callOutputText, checkCall, fillRefs, formatCallSteps, isCallLanguage, parseCall } from '@md-runbook/core/call';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { withFrontMatterValues } from '@md-runbook/core/incident';
import { resolveKubeContext } from '@md-runbook/core/kubeContext';
import { outputBlockAttrs } from '@md-runbook/core/progress';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { inSections, sectionHeadings } from '@md-runbook/core/sections';
import { osGroups } from '@md-runbook/core/os';
import { callTarget, fileSha256, relativeToCaller, samePath, writeCallCopy } from '@md-runbook/core/node';
import { SECTION } from './config';
import { META_KEY, outputMeta } from './outputs';
import { CellExecutor, CellPlan, ExecuteIO, PrepareContext, RunPipeline } from './pipeline';
import { NOTEBOOK_TYPE } from './serializer';

/** What a call gives the runbook it runs: its parameters, and the files calling it (cycles). */
interface Passed {
  params: Record<string, string>;
  callers: string[];
}

const passed = new Map<string, Passed>();

/** A parameter the call that opened this copy passed (secrets.ts asks for the others). */
export function passedParam(uri: vscode.Uri, name: string): string | undefined {
  return passed.get(uri.toString())?.params[name];
}

/** The controller's part: running cells of a notebook (resolves when they have run), and cancelling them. */
export interface CallHost {
  run(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void>;
  cancel(uri: vscode.Uri): void;
}

/** Cells to run with a fresh copy on their next run (Run with a Fresh Copy). */
const fresh = new Set<string>();
const cellKey = (cell: vscode.NotebookCell): string => `${cell.notebook.uri.toString()}#${cell.index}`;

function infoOf(cell: vscode.NotebookCell): string {
  const meta: unknown = cell.metadata?.[META_KEY];
  return isCodeMeta(meta) ? meta.info : '';
}

/** The marker attributes among these outputs (as cellAttrs reads a cell's own). */
function attrsOf(outputs: readonly vscode.NotebookCellOutput[], cellMeta: unknown): Record<string, string> | undefined {
  let attrs: Record<string, string> | undefined;
  for (const o of outputs) {
    const m = outputMeta(o);
    if (m?.persisted) return isCodeMeta(cellMeta) && cellMeta.output ? outputBlockAttrs(cellMeta.output.raw) : undefined;
    if (m?.run) attrs ??= m.run.attrs;
    if (m?.status && m.attrs) attrs = m.attrs;
  }
  return attrs;
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

export class CallExecutor implements CellExecutor {
  constructor(private readonly host: CallHost) {}

  async execute(plan: CellPlan, io: ExecuteIO, ctx: PrepareContext): Promise<ExecuteResult> {
    const started = Date.now();
    const fail = (error: string): ExecuteResult => ({ exitCode: null, signal: null, timedOut: false, cancelled: false, error, durationMs: Date.now() - started });
    const parentFile = ctx.notebook.uri.fsPath;
    if (ctx.notebook.uri.scheme !== 'file') return fail('md-runbook: save the runbook to a file before it calls another one');
    const info = infoOf(ctx.cell);
    const call = parseCall(info, ctx.cell.document.getText());
    if (call.problems.length > 0 || call.src === undefined) return fail(`md-runbook: ${call.problems.map((p) => p.message).join('; ')}`);
    const values = plan.callValues ?? {};
    const fill = (t: string): string => {
      const r = fillRefs(t, (_kind, name) => values[name]);
      return 'text' in r ? r.text : t;
    };
    const target = callTarget(parentFile, fill(call.src));
    const shown = relativeToCaller(parentFile, target);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return fail(`md-runbook: src="${call.src}": no such runbook: ${shown}`);
    const callers = passed.get(ctx.notebook.uri.toString())?.callers ?? [parentFile];
    const chain = callChainProblem(
      callers.map((p) => vscode.workspace.asRelativePath(p)),
      vscode.workspace.asRelativePath(target),
      (a, b) => a === b,
    );
    if (chain || callers.some((p) => samePath(p, target))) return fail(`md-runbook: ${chain ?? `a runbook call cycle: ${[...callers, target].map((p) => vscode.workspace.asRelativePath(p)).join(' → ')}`}`);

    const childText = fs.readFileSync(target, 'utf8');
    const check = checkCall(call, childText);
    const refusal = [...check.unknown.map((a) => `${shown} has no parameter ${a.name}`), ...check.sections];
    if (refusal.length > 0) return fail(`md-runbook: ${refusal.join('; ')}`);
    const params: Record<string, string> = {};
    for (const a of call.args) params[a.name] = fill(a.value);

    // The cluster: the runbook called names the caller's, or none (then it gets the caller's).
    const childFm = parseFrontMatter(childText);
    const mine = plan.kubeContext;
    let theirs: string | undefined;
    try {
      theirs = resolveKubeContext(childFm?.kubeContext, (n) => params[n] ?? childFm?.params.find((p) => p.name === n)?.default);
    } catch {
      theirs = undefined; // a parameter it asks for: its own cells check the cluster
    }
    if (mine !== undefined && theirs !== undefined && mine !== theirs) {
      return fail(`md-runbook: ${shown} runs against the Kubernetes context ${theirs}, this runbook against ${mine}: nothing ran`);
    }

    // Run again after a failure: the same copy, keeping the steps done there.
    const previous = callFromAttrs(attrsOf(ctx.previousOutputs ?? [], ctx.cell.metadata?.[META_KEY]));
    const freshCopy = fresh.delete(cellKey(ctx.cell));
    let copy: string | undefined;
    if (previous && !freshCopy && previous.exit !== undefined && previous.exit !== '0') {
      const old = path.resolve(path.dirname(parentFile), previous.copy);
      if (fs.existsSync(old) && samePath(callTarget(parentFile, previous.runbook), target)) copy = old;
    }
    const resumed = copy !== undefined;
    if (!copy) {
      const folder = vscode.workspace.getConfiguration(SECTION).get<string>('output.copyFolder', '').trim();
      copy = writeCallCopy(target, fs.readFileSync(parentFile, 'utf8'), folder || undefined);
      if (mine !== undefined && !childFm?.kubeContext) {
        // The caller's cluster, in the copy's own record.
        const fm = parseFrontMatter(fs.readFileSync(parentFile, 'utf8'));
        const values: Record<string, string> = { 'kube-context': mine, ...(fm?.kubeContextMode ? { 'kube-context-mode': fm.kubeContextMode } : {}) };
        fs.writeFileSync(copy, withFrontMatterValues(fs.readFileSync(copy, 'utf8'), values), 'utf8');
      }
    }
    const copyUri = vscode.Uri.file(copy);
    const copyShown = relativeToCaller(parentFile, copy);
    passed.set(copyUri.toString(), { params, callers: [...callers, target] });
    const part = call.sections.length ? ` (section${call.sections.length === 1 ? '' : 's'} ${call.sections.map((t) => `"${t}"`).join(', ')})` : '';
    io.onStdout(`[md-runbook] ${resumed ? 'continuing' : 'running'} ${shown}${part} as ${copyShown}${resumed ? ' (steps done there are kept)' : ''}\n`);

    // Its cells: in the sections asked for, not done in an earlier run of this copy.
    const copyText = fs.readFileSync(copy, 'utf8');
    const inPart = call.sections.length ? inSections(sectionHeadings(copyText), call.sections) : () => true;
    const toRun = locateCodeCells(parse(copyText))
      .filter((l) => inPart(l.line))
      .filter((l) => {
        if (!resumed) return true;
        const a = l.outputAttrs;
        const s = stepState(a?.exit, a?.lines !== undefined, a?.check);
        return s !== 'done' && s !== 'skipped';
      })
      .map((l) => l.cellIndex);

    await vscode.commands.executeCommand('vscode.openWith', copyUri, NOTEBOOK_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
    const editor = await waitForEditor(copyUri);
    await vscode.commands.executeCommand('notebook.selectKernel', { notebookEditor: editor, id: 'md-runbook-shell', extension: 'smojon.md-runbook' });
    const nb = editor.notebook;

    // Each step of the copy as it finishes, in this cell's output.
    const reported = new Set<number>();
    const progress = vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.uri.toString() !== copyUri.toString()) return;
      for (const c of e.cellChanges) {
        const end = c.executionSummary?.timing?.endTime;
        if (end === undefined || reported.has(c.cell.index) || !toRun.includes(c.cell.index)) continue;
        reported.add(c.cell.index);
        const a = attrsOf(c.cell.outputs, c.cell.metadata?.[META_KEY]);
        const s = stepState(a?.exit, a?.lines !== undefined, a?.check);
        const icon = s === 'done' ? '✓' : s === 'skipped' || s === 'pending' ? '–' : '✗';
        const name = parseCellOptions(infoOf(c.cell)).name ?? c.cell.document.getText().split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
        io.onStdout(`  ${icon} ${name.slice(0, 80)}${a?.exit && a.exit !== '0' ? ` (${a.exit})` : ''}\n`);
      }
    });
    const onAbort = (): void => this.host.cancel(copyUri);
    io.signal.addEventListener('abort', onAbort, { once: true });
    const timeoutS = parseCellOptions(info).timeoutSeconds;
    let timedOut = false;
    const timer = timeoutS ? setTimeout(() => ((timedOut = true), this.host.cancel(copyUri)), timeoutS * 1000) : undefined;
    try {
      if (toRun.length > 0) await this.host.run(toRun.filter((i) => i < nb.cellCount).map((i) => nb.cellAt(i)), nb);
      await nb.save();
    } finally {
      clearTimeout(timer);
      io.signal.removeEventListener('abort', onAbort);
      progress.dispose();
    }

    // The result, from the copy as saved.
    const saved = fs.readFileSync(copy, 'utf8');
    const savedPart = call.sections.length ? inSections(sectionHeadings(saved), call.sections) : () => true;
    // Blocks for another OS (when one is for this one) are alternatives, not steps; host= blocks
    // run from the app only: both are passed over here, as Run All does.
    const savedDoc = parse(saved);
    const slots = osGroups(savedDoc.cells.map((c) => (isCodeMeta(c.meta) ? { kind: 'code' as const, os: parseCellOptions(c.meta.info).os } : { kind: 'markup' as const })));
    const states = locateCodeCells(savedDoc)
      .filter((l) => savedPart(l.line) && !(slots[l.cellIndex] && !slots[l.cellIndex]!.active))
      .map((l) => (parseCellOptions(l.info).host ? 'skipped' : stepState(l.outputAttrs?.exit, l.outputAttrs?.lines !== undefined, l.outputAttrs?.check)));
    const unticked = taskItems(saved).filter((t) => !t.checked && savedPart(t.line)).length;
    const evidence = parseFrontMatter(saved)?.evidence === true;
    const r: CallResult = {
      runbook: shown,
      copy: copyShown,
      sha256: fileSha256(copy),
      done: states.filter((s) => s === 'done').length,
      skipped: states.filter((s) => s === 'skipped').length,
      failed: states.filter((s) => s === 'failed').length,
      notRun: states.filter((s) => s === 'pending').length,
      manual: unticked,
    };
    Object.assign(plan.attrs, callAttrs(r));
    const ok = !timedOut && !io.signal.aborted && r.failed === 0 && r.notRun === 0 && !(evidence && unticked > 0);
    io.onStdout(callOutputText(r, call.sections).split('\n')[1]! + '\n');
    if (timedOut) io.onStderr(`[md-runbook] timed out after ${timeoutS}s; the runbook called was stopped\n`);
    else if (!ok && evidence && unticked > 0 && r.failed === 0 && r.notRun === 0) {
      io.onStderr(`[md-runbook] ${unticked} manual step${unticked === 1 ? '' : 's'} not ticked in ${copyShown}, which keeps evidence: tick ${unticked === 1 ? 'it' : 'them'} there and run the call again\n`);
    } else if (!ok) io.onStderr(`[md-runbook] ${shown}: ${formatCallSteps(r)}\n`);
    return { exitCode: ok ? 0 : 1, signal: null, timedOut, cancelled: io.signal.aborted && !timedOut, durationMs: Date.now() - started };
  }
}

/** The status bar of a call cell: open the copy it ran; run it with a fresh copy. */
function callItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
  if (cell.kind !== vscode.NotebookCellKind.Code || !isCallLanguage(cell.document.languageId)) return [];
  const items: vscode.NotebookCellStatusBarItem[] = [];
  const last = callFromAttrs(attrsOf(cell.outputs, cell.metadata?.[META_KEY]));
  if (last && cell.notebook.uri.scheme === 'file') {
    const open = new vscode.NotebookCellStatusBarItem(`$(go-to-file) Open ${path.basename(last.copy)}`, vscode.NotebookCellStatusBarAlignment.Left);
    open.command = { title: 'Open the copy', command: 'mdRunbook.openCallCopy', arguments: [cell] };
    open.tooltip = `The run copy of ${last.runbook}: its steps and outputs`;
    items.push(open);
  }
  const again = new vscode.NotebookCellStatusBarItem('$(refresh) Fresh copy', vscode.NotebookCellStatusBarAlignment.Left);
  again.command = { title: 'Run with a Fresh Copy', command: 'mdRunbook.runCallFresh', arguments: [cell] };
  again.tooltip = 'Run the runbook called in a new copy, instead of continuing the copy of a failed run';
  items.push(again);
  return items;
}

function targetCell(arg: unknown): vscode.NotebookCell | undefined {
  const a = arg as Partial<vscode.NotebookCell> | undefined;
  if (a && typeof a.index === 'number' && a.notebook && a.document) return a as vscode.NotebookCell;
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE || editor.notebook.cellCount === 0) return undefined;
  return editor.notebook.cellAt(editor.selection.start);
}

export function registerCalls(context: vscode.ExtensionContext, pipeline: RunPipeline, host: CallHost): void {
  pipeline.callExecutor = new CallExecutor(host);
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, { onDidChangeCellStatusBarItems: changed.event, provideCellStatusBarItems: callItems }),
    vscode.commands.registerCommand('mdRunbook.openCallCopy', async (arg?: unknown) => {
      const cell = targetCell(arg);
      const last = cell ? callFromAttrs(attrsOf(cell.outputs, cell.metadata?.[META_KEY])) : undefined;
      if (!cell || !last) return void vscode.window.showInformationMessage('md-runbook: this cell has not run a runbook yet.');
      const copy = vscode.Uri.file(path.resolve(path.dirname(cell.notebook.uri.fsPath), last.copy));
      await vscode.commands.executeCommand('vscode.openWith', copy, NOTEBOOK_TYPE, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }),
    vscode.commands.registerCommand('mdRunbook.runCallFresh', async (arg?: unknown) => {
      const cell = targetCell(arg);
      if (!cell || !isCallLanguage(cell.document.languageId)) return void vscode.window.showInformationMessage('md-runbook: select a runbook call (a ```runbook block).');
      fresh.add(cellKey(cell));
      await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: cell.index, end: cell.index + 1 }], document: cell.notebook.uri });
    }),
  );
}

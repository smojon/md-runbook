/**
 * Run code blocks from the plain Markdown text editor: CodeLens above each runnable fence, output
 * streamed to the "md-runbook" output channel, and the output block written into the document
 * (unsaved, as one undoable edit). Pipeline preparers need a notebook cell, so they don't apply.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  CodeCellLocation,
  ExecuteResult,
  LineBuffer,
  executeCell,
  exitLabel,
  formatDurationAttr,
  formatLocalIso,
  isSuccess,
  locateCodeCells,
  minimalChange,
  outputSummary,
  parse,
  setCellOutput,
} from './core';
import { SECTION, executionConfig, redactionConfig, writeOptions } from './config';
import { workingDirectory } from './controller';
import { knownSecrets } from './knownSecrets';
import { ConfirmMode, DEFAULT_CONFIRM_PATTERNS, compileConfirmPatterns, confirmationFor } from './core/confirm';
import { proposalOf } from './core/proposal';
import { cellConfirmOption } from './safety';

/**
 * Text-editor runs skip the notebook's preparers (approval, policy, secrets), so they refuse
 * proposed or AI-written cells and still ask before risky commands. Returns why a block may not run.
 */
async function textEditorGuard(loc: CodeCellLocation): Promise<string | undefined> {
  const p = proposalOf(loc.info);
  if (p.state === 'proposed') return 'this is a proposed cell; approve and run it in the runbook (notebook) view';
  if (p.by) return 'cells written by an assistant only run in the runbook (notebook) view, where approval, policy and read-only credentials apply';
  const c = vscode.workspace.getConfiguration(SECTION);
  const { regexes } = compileConfirmPatterns(c.get<string[]>('execution.confirmPatterns', DEFAULT_CONFIRM_PATTERNS));
  const match = confirmationFor(loc.source, c.get<ConfirmMode>('execution.confirm', 'patterns'), regexes, cellConfirmOption(loc.info));
  if (match === undefined) return undefined;
  const message = match === '' ? 'Run this block?' : `This block contains a risky command: “${match.trim()}”`;
  const answer = await vscode.window.showWarningMessage(message, { modal: true }, 'Run');
  return answer === 'Run' ? undefined : 'not confirmed';
}

export const RUN_CELL = 'mdRunbook.runCellInEditor';
export const RUN_BELOW = 'mdRunbook.runCellsBelowInEditor';

const locate = (doc: vscode.TextDocument): CodeCellLocation[] => locateCodeCells(parse(doc.getText()));

class EditorRunner {
  readonly channel = vscode.window.createOutputChannel('md-runbook');
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** Cell currently running per document URI. */
  readonly running = new Map<string, number>();
  /** Per-document queue so blocks of one file never run concurrently. */
  private readonly queues = new Map<string, Promise<unknown>>();

  dispose(): void {
    this.channel.dispose();
    this.changed.dispose();
  }

  /** Run cell `cellIndex` (and, with `below`, every code cell after it). Resolves true if all succeeded. */
  run(doc: vscode.TextDocument, cellIndex: number, below: boolean): Promise<boolean> {
    const key = doc.uri.toString();
    const next = (this.queues.get(key) ?? Promise.resolve()).then(() => this.runSequence(doc, cellIndex, below));
    const settled = next.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return next;
  }

  private runSequence(doc: vscode.TextDocument, cellIndex: number, below: boolean): Thenable<boolean> {
    const targets = locate(doc)
      .filter((l) => (below ? l.cellIndex >= cellIndex : l.cellIndex === cellIndex))
      .map((l) => l.cellIndex);
    if (targets.length === 0) {
      void vscode.window.showWarningMessage(`md-runbook: no runnable code block at cell ${cellIndex}.`);
      return Promise.resolve(false);
    }
    const name = path.basename(doc.uri.fsPath || doc.uri.path);
    const options = { location: vscode.ProgressLocation.Notification, title: `md-runbook: ${name}`, cancellable: true };
    return vscode.window.withProgress(options, async (progress, token) => {
      const abort = new AbortController();
      const sub = token.onCancellationRequested(() => abort.abort());
      const cfg = executionConfig();
      try {
        let allOk = true;
        for (const [k, idx] of targets.entries()) {
          if (abort.signal.aborted) return false;
          progress.report({ message: targets.length > 1 ? `block ${k + 1} of ${targets.length}` : 'running…' });
          const ok = await this.runOne(doc, idx, abort.signal);
          allOk &&= ok;
          if (!ok && (abort.signal.aborted || (cfg.stopOnFailure && targets.length > 1))) {
            if (k < targets.length - 1) this.channel.appendLine('[md-runbook] stopped: a block failed');
            return false;
          }
        }
        return allOk;
      } finally {
        sub.dispose();
      }
    });
  }

  private async runOne(doc: vscode.TextDocument, cellIndex: number, signal: AbortSignal): Promise<boolean> {
    // Re-locate on every step: earlier steps (or the user) may have edited the document.
    const loc = locate(doc).find((l) => l.cellIndex === cellIndex);
    if (!loc) return false;
    const blocked = await textEditorGuard(loc);
    if (blocked) {
      this.channel.show(true);
      this.channel.appendLine(`[md-runbook] not run: ${blocked}`);
      return false;
    }
    const cfg = executionConfig();
    const started = new Date();
    const cwd = workingDirectory(doc.uri);
    const key = doc.uri.toString();
    this.running.set(key, cellIndex);
    this.changed.fire();

    this.channel.show(true);
    this.channel.appendLine(`▶ ${path.basename(doc.uri.fsPath || doc.uri.path)}:${loc.line + 1} (${loc.language}) · ${formatLocalIso(started)}`);

    const redaction = redactionConfig();
    const liveRedact =
      redaction.enabled && redaction.applyToLiveOutput ? (t: string) => knownSecrets.redact(redaction.redactor.redact(t)) : undefined;
    let transcript = '';
    const live = new LineBuffer((t) => this.channel.append(t), liveRedact);
    const write = (t: string): void => {
      transcript += t;
      live.write(t);
      if (!liveRedact) live.flush();
    };
    const failed = (error: string): ExecuteResult => ({ exitCode: null, signal: null, timedOut: false, cancelled: false, error, durationMs: 0 });

    let result: ExecuteResult;
    try {
      result = fs.existsSync(cwd)
        ? await executeCell({
            language: loc.language,
            source: loc.source,
            cwd,
            settings: cfg.shell,
            timeoutMs: cfg.timeoutMs,
            env: cfg.env,
            signal,
            onStdout: write,
            onStderr: write,
          })
        : failed(`Working directory not found: ${cwd}`);
    } catch (e) {
      result = failed(e instanceof Error ? e.message : String(e));
    } finally {
      if (this.running.get(key) === cellIndex) this.running.delete(key);
    }
    if (result.error !== undefined) write(result.error + '\n');
    if (result.timedOut) write(`[md-runbook] timed out after ${cfg.timeoutMs / 1000}s; process tree killed\n`);
    live.flush();

    const ended = new Date();
    const attrs = { exit: exitLabel(result), ran: formatLocalIso(started), ended: formatLocalIso(ended), duration: formatDurationAttr(ended.getTime() - started.getTime()) };
    this.channel.appendLine(`${outputSummary(attrs, ended)}${result.shell ? ` · ${result.shell.label}` : ''}\n`);
    await this.writeOutput(doc, cellIndex, transcript, attrs);
    this.changed.fire();
    return isSuccess(result);
  }

  /** Put the output block into the document as one minimal edit; the file is not saved. */
  private async writeOutput(doc: vscode.TextDocument, cellIndex: number, text: string, attrs: Record<string, string>): Promise<void> {
    const opts = writeOptions();
    if (!opts.persistOutputs) return;
    const old = doc.getText();
    const next = setCellOutput(old, cellIndex, { kind: 'new', text, attrs }, opts);
    if (next === undefined) {
      void vscode.window.showWarningMessage('md-runbook: the document changed during the run; output was not written.');
      return;
    }
    if (next === old) return;
    const c = minimalChange(old, next);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(c.start), doc.positionAt(c.end)), c.text);
    await vscode.workspace.applyEdit(edit);
  }
}

class RunbookCodeLensProvider implements vscode.CodeLensProvider {
  constructor(
    private readonly runner: EditorRunner,
    readonly onDidChangeCodeLenses: vscode.Event<void>,
  ) {}

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration(SECTION, doc.uri).get<boolean>('codeLens.enabled', false)) return [];
    const running = this.runner.running.get(doc.uri.toString());
    const now = new Date();
    const lenses: vscode.CodeLens[] = [];
    for (const loc of locate(doc)) {
      const range = new vscode.Range(loc.line, 0, loc.line, 0);
      if (running === loc.cellIndex) {
        lenses.push(new vscode.CodeLens(range, { title: '$(sync~spin) Running…', command: '' }));
        continue;
      }
      const args = [doc.uri, loc.cellIndex];
      lenses.push(new vscode.CodeLens(range, { title: '▶ Run', command: RUN_CELL, arguments: args, tooltip: 'Run this block and write its output into the document' }));
      lenses.push(new vscode.CodeLens(range, { title: '▶ Run below', command: RUN_BELOW, arguments: args, tooltip: 'Run this block and every block after it' }));
      if (loc.outputAttrs) {
        const a = loc.outputAttrs;
        const tooltip = [a.ran && `ran ${a.ran}`, a.ended && `ended ${a.ended}`].filter(Boolean).join('\n');
        lenses.push(new vscode.CodeLens(range, { title: outputSummary(a, now), command: '', tooltip }));
      }
    }
    return lenses;
  }
}

/** Command arguments: (uri, cellIndex). Without them, the block at the cursor of the active editor. */
async function resolveTarget(uri: unknown, cellIndex: unknown): Promise<{ doc: vscode.TextDocument; cellIndex: number } | undefined> {
  if ((uri instanceof vscode.Uri || typeof uri === 'string') && typeof cellIndex === 'number') {
    const doc = await vscode.workspace.openTextDocument(typeof uri === 'string' ? vscode.Uri.parse(uri) : uri);
    return { doc, cellIndex };
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const line = editor.selection.active.line;
  const loc = locate(editor.document)
    .filter((l) => l.line <= line)
    .pop();
  if (!loc) {
    void vscode.window.showInformationMessage('md-runbook: put the cursor in or below a runnable code block.');
    return undefined;
  }
  return { doc: editor.document, cellIndex: loc.cellIndex };
}

export function registerCodeLens(context: vscode.ExtensionContext): void {
  const runner = new EditorRunner();
  const refresh = new vscode.EventEmitter<void>();
  const command = (below: boolean) => async (uri?: unknown, cellIndex?: unknown) => {
    if (!vscode.workspace.getConfiguration(SECTION).get<boolean>('codeLens.enabled', false)) {
      const open = await vscode.window.showInformationMessage(
        'md-runbook: running blocks from the text editor is off (mdRunbook.codeLens.enabled). Use Open as Runbook, or enable it.',
        'Open Setting',
      );
      if (open) await vscode.commands.executeCommand('workbench.action.openSettings', 'mdRunbook.codeLens.enabled');
      return false;
    }
    const t = await resolveTarget(uri, cellIndex);
    return t ? runner.run(t.doc, t.cellIndex, below) : false;
  };
  context.subscriptions.push(
    runner,
    refresh,
    runner.onDidChange(() => refresh.fire()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.codeLens.enabled`)) refresh.fire();
    }),
    vscode.languages.registerCodeLensProvider({ language: 'markdown' }, new RunbookCodeLensProvider(runner, refresh.event)),
    vscode.commands.registerCommand(RUN_CELL, command(false)),
    vscode.commands.registerCommand(RUN_BELOW, command(true)),
  );
}

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
  exitLabel,
  formatDurationAttr,
  formatLocalIso,
  isSuccess,
  locateCodeCells,
  minimalChange,
  outputSummary,
  parse,
  setCellOutput,
} from '@md-runbook/core';
import { executeCell } from '@md-runbook/core/node';
import { ExecutionConfig, SECTION, executionConfig, redactionConfig, writeOptions } from './config';
import { workingDirectory } from './controller';
import { knownSecrets } from './knownSecrets';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { currentOs, osLabel } from '@md-runbook/core/os';
import { ConfirmMode, DEFAULT_CONFIRM_PATTERNS, compileConfirmPatterns, confirmationFor } from '@md-runbook/core/confirm';
import { proposalOf } from '@md-runbook/core/proposal';
import { cellConfirmOption } from './safety';

/**
 * Text-editor runs skip the notebook's preparers (approval, policy, secrets), so they refuse
 * proposed or AI-written cells and still ask before risky commands. Returns why a block may not run.
 */
async function textEditorGuard(loc: CodeCellLocation): Promise<string | undefined> {
  const p = proposalOf(loc.info);
  if (p.state === 'proposed') return 'this is a proposed cell; approve and run it in the runbook (notebook) view';
  if (p.by) return 'cells written by an assistant only run in the runbook (notebook) view, where approval, policy and read-only credentials apply';
  // Unresolved, a shell would misread these (bash: `${param:X}` is a substring expansion -> empty).
  const ref = /\$\{(secret|input|param|out):[^}]*\}/.exec(loc.source);
  if (ref) return `this block uses ${ref[0]}; \${secret:…}, \${input:…}, \${param:…} and \${out:…} references are resolved only in the runbook (notebook) view`;
  const c = vscode.workspace.getConfiguration(SECTION);
  const { regexes } = compileConfirmPatterns(c.get<string[]>('execution.confirmPatterns', DEFAULT_CONFIRM_PATTERNS));
  const match = confirmationFor(loc.source, c.get<ConfirmMode>('execution.confirm', 'patterns'), regexes, cellConfirmOption(loc.info));
  if (match === undefined) return undefined;
  const message = match === '' ? 'Run this block?' : `This block contains a risky command: “${match.trim()}”`;
  const answer = await vscode.window.showWarningMessage(message, { modal: true }, 'Run');
  return answer === 'Run' ? undefined : 'not confirmed';
}

interface RunOptions {
  skip: boolean;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  /** Invalid cell options: the block fails with this message instead of running. */
  error?: string;
}

/**
 * The fence options of a block (`skip`, `cwd=`, `timeout=`, `env.*`), applied like the notebook's
 * options preparer: cwd relative to the .md file's folder, invalid options fail the block.
 */
function runOptions(info: string, baseDir: string, cfg: ExecutionConfig, docText: string): RunOptions {
  // Front matter `cwd:` and `timeout:` are the runbook's defaults, as in the notebook.
  const fm = parseFrontMatter(docText);
  const cwd = fm?.cwd ? path.resolve(baseDir, fm.cwd) : baseDir;
  const timeoutMs = fm?.timeoutSeconds !== undefined ? fm.timeoutSeconds * 1000 : cfg.timeoutMs;
  const out: RunOptions = { skip: false, cwd, timeoutMs, env: { ...cfg.env } };
  if (!vscode.workspace.getConfiguration(SECTION).get<boolean>('cellOptions.enabled', true)) return out;
  const o = parseCellOptions(info);
  if (o.errors.length > 0) out.error = `md-runbook: invalid cell option ${o.errors.join('; ')}`;
  if (o.skip && out.error === undefined) out.skip = true;
  if (o.timeoutSeconds !== undefined) out.timeoutMs = o.timeoutSeconds * 1000;
  if (o.cwd !== undefined) out.cwd = path.resolve(baseDir, o.cwd);
  Object.assign(out.env, o.env);
  return out;
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
    const cfg = executionConfig();
    const opts = runOptions(loc.info, workingDirectory(doc.uri), cfg, doc.getText());
    if (opts.skip) {
      this.channel.show(true);
      this.channel.appendLine(`[md-runbook] skipped: ${path.basename(doc.uri.fsPath || doc.uri.path)}:${loc.line + 1} (skip option)`);
      return true;
    }
    // A block for another OS is an alternative: pass over it (Run Below carries on).
    const os = vscode.workspace.getConfiguration(SECTION).get<boolean>('cellOptions.enabled', true) ? parseCellOptions(loc.info).os : undefined;
    if (os && !os.includes(currentOs())) {
      this.channel.appendLine(`[md-runbook] not run: this block is for ${osLabel(os)}`);
      return true;
    }
    // host=: runs on a remote host from the md-runbook app, never on this machine.
    const host = parseCellOptions(loc.info).host;
    if (host) {
      this.channel.appendLine(`[md-runbook] not run: this block runs on the host ${host} (from the md-runbook app)`);
      return true;
    }
    const blocked = await textEditorGuard(loc);
    if (blocked) {
      this.channel.show(true);
      this.channel.appendLine(`[md-runbook] not run: ${blocked}`);
      return false;
    }
    const started = new Date();
    const cwd = opts.cwd;
    const key = doc.uri.toString();
    this.running.set(key, cellIndex);
    this.changed.fire();

    this.channel.show(true);
    this.channel.appendLine(`▶ ${path.basename(doc.uri.fsPath || doc.uri.path)}:${loc.line + 1} (${loc.language}) · ${formatLocalIso(started)}`);

    // The output channel is also logged to disk, so known secrets are always redacted there;
    // patterns too when live redaction is on.
    const redaction = redactionConfig();
    const liveRedact =
      redaction.enabled && redaction.applyToLiveOutput
        ? (t: string) => knownSecrets.redact(redaction.redactor.redact(t))
        : (t: string) => knownSecrets.redact(t);
    let transcript = '';
    const live = new LineBuffer((t) => this.channel.append(t), liveRedact);
    const write = (t: string): void => {
      transcript += t;
      live.write(t);
    };
    const failed = (error: string): ExecuteResult => ({ exitCode: null, signal: null, timedOut: false, cancelled: false, error, durationMs: 0 });

    let result: ExecuteResult;
    try {
      result = opts.error !== undefined
        ? failed(opts.error)
        : fs.existsSync(cwd)
        ? await executeCell({
            language: loc.language,
            source: loc.source,
            cwd,
            settings: cfg.shell,
            timeoutMs: opts.timeoutMs,
            env: opts.env,
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
    if (result.timedOut) write(`[md-runbook] timed out after ${opts.timeoutMs / 1000}s; process tree killed\n`);
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

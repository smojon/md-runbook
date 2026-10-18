/**
 * Per-cell fence options, confirmation of risky cells, and recording the target context
 * (cluster, server, ...) as output marker attributes, with a status bar item for it.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { isCodeMeta } from './core';
import { parseCellOptions } from './core/cellOptions';
import { ConfirmMode, DEFAULT_CONFIRM_PATTERNS, compileConfirmPatterns, confirmationFor } from './core/confirm';
import { runContextCommand } from './core/context';
import { SECTION, executionConfig, redactionConfig } from './config';
import { workingDirectory } from './controller';
import { knownSecrets } from './knownSecrets';
import { META_KEY } from './outputs';
import { CellPlan, CellPreparer, PrepareContext, RunPipeline } from './pipeline';
import { NOTEBOOK_TYPE } from './serializer';

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

function infoOf(cell: vscode.NotebookCell): string {
  const meta: unknown = cell.metadata?.[META_KEY];
  return isCodeMeta(meta) ? meta.info : '';
}

/** Applies the options written after the language word of the fence. */
const optionsPreparer: CellPreparer = {
  prepare(plan, { cell, notebook }) {
    if (!cfg().get<boolean>('cellOptions.enabled', true)) return;
    const o = parseCellOptions(infoOf(cell));
    if (o.errors.length > 0) throw new Error(`md-runbook: invalid cell option ${o.errors.join('; ')}`);
    if (o.timeoutSeconds !== undefined) plan.timeoutMs = o.timeoutSeconds * 1000;
    if (o.cwd !== undefined) plan.cwd = path.resolve(workingDirectory(notebook.uri), o.cwd);
    if (o.continueOnError) plan.continueOnError = true;
    if (o.skip) plan.skip = 'skip option';
    Object.assign(plan.env, o.env);
    if (o.name !== undefined) plan.attrs.name = o.name;
  },
};

function recordContextCommands(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg().get<Record<string, unknown>>('output.recordContext', {}))) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v;
  }
  return out;
}

const contextAttr = (): string => cfg().get<string>('statusBar.contextAttr', 'context');

class ContextRecorder implements CellPreparer, vscode.Disposable {
  private readonly cache = new Map<string, { at: number; sig: string; values: Promise<Record<string, string>> }>();
  /** Last values per notebook, for the status bar. */
  private readonly last = new Map<string, Record<string, string>>();
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  async prepare(plan: CellPlan, { notebook }: PrepareContext): Promise<void> {
    if (plan.skip !== undefined) return;
    Object.assign(plan.attrs, await this.values(notebook, plan.env));
  }

  /** Context values for a notebook, cached for `recordContextCacheSeconds`. */
  values(notebook: vscode.NotebookDocument, extraEnv: Record<string, string> = {}): Promise<Record<string, string>> {
    const commands = recordContextCommands();
    if (Object.keys(commands).length === 0) return Promise.resolve({});
    const cwd = workingDirectory(notebook.uri);
    const key = notebook.uri.toString();
    const sig = JSON.stringify([commands, cwd, extraEnv]);
    const ttl = Math.max(0, cfg().get<number>('output.recordContextCacheSeconds', 30)) * 1000;
    const hit = this.cache.get(key);
    if (hit && hit.sig === sig && Date.now() - hit.at < ttl) return hit.values;
    const env = { ...process.env, ...extraEnv };
    const values = (async () => {
      const r = redactionConfig();
      const redact = (s: string): string => knownSecrets.redact(r.enabled ? r.redactor.redact(s) : s);
      const entries = await Promise.all(
        Object.entries(commands).map(async ([attr, cmd]) => [attr, redact(await runContextCommand(cmd, cwd, env))] as const),
      );
      const v = Object.fromEntries(entries);
      this.last.set(key, v);
      return v;
    })();
    this.cache.set(key, { at: Date.now(), sig, values });
    return values;
  }

  /** Show the context of the active runbook, fetching it once if nothing is known yet. */
  refresh(fetch = true): void {
    const nb = vscode.window.activeNotebookEditor?.notebook;
    const attr = contextAttr();
    if (!nb || nb.notebookType !== NOTEBOOK_TYPE || !(attr in recordContextCommands())) return void this.item.hide();
    const known = this.last.get(nb.uri.toString());
    if (!known) {
      this.item.hide();
      if (fetch) void this.values(nb, executionConfig().env).then(() => this.refresh(false));
      return;
    }
    this.item.text = `$(cloud) ${known[attr] ?? 'unknown'}`;
    this.item.tooltip = `md-runbook context\n${Object.entries(known).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
    this.item.show();
  }

  /** After a run, the recorded attributes are the freshest values. */
  noteRun(notebook: vscode.NotebookDocument, attrs: Record<string, string>): void {
    const picked = Object.keys(recordContextCommands()).filter((k) => k in attrs);
    if (picked.length > 0) this.last.set(notebook.uri.toString(), Object.fromEntries(picked.map((k) => [k, attrs[k]!])));
    this.refresh(false);
  }

  /** Forget everything, e.g. after the commands changed. */
  reset(): void {
    this.cache.clear();
    this.last.clear();
    this.refresh();
  }

  dispose(): void {
    this.item.dispose();
  }
}

let lastPatternErrors = '';

/**
 * The cell's own `confirm` / `no-confirm` option. `no-confirm` lets the file switch the safety net
 * off, so it is ignored unless the user allows it in their own settings.
 */
export function cellConfirmOption(info: string): boolean | undefined {
  const c = cfg();
  if (!c.get<boolean>('cellOptions.enabled', true)) return undefined;
  const o = parseCellOptions(info).confirm;
  return o === false && !c.get<boolean>('execution.allowNoConfirmOption', false) ? undefined : o;
}

/** Asks before running a cell that matches a risky pattern (or always/never, per settings and cell options). */
const confirmPreparer: CellPreparer = {
  async prepare(plan, { cell }) {
    if (plan.skip !== undefined) return;
    const c = cfg();
    const { regexes, errors } = compileConfirmPatterns(c.get<string[]>('execution.confirmPatterns', DEFAULT_CONFIRM_PATTERNS));
    const errorText = errors.join('\n');
    if (errorText && errorText !== lastPatternErrors) void vscode.window.showWarningMessage(`md-runbook: invalid confirm pattern(s) ignored:\n${errorText}`);
    lastPatternErrors = errorText;

    const mode = c.get<ConfirmMode>('execution.confirm', 'patterns');
    const match = confirmationFor(plan.source, mode, regexes, cellConfirmOption(infoOf(cell)));
    if (match === undefined) return;

    const ctxLines = Object.keys(recordContextCommands())
      .filter((k) => k in plan.attrs)
      .map((k) => `${k}: ${plan.attrs[k]}`);
    const message = match === '' ? `Run cell ${cell.index + 1}?` : `Cell ${cell.index + 1} contains a risky command: “${match.trim()}”`;
    const detail = ctxLines.length > 0 ? `Current context:\n${ctxLines.join('\n')}` : 'No context recorded (see mdRunbook.output.recordContext).';
    const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Run');
    if (answer !== 'Run') {
      plan.skip = 'not confirmed';
      // Later steps usually depend on this one; don't carry on without it.
      plan.stopSequence = true;
    }
  },
};

export function registerSafety(context: vscode.ExtensionContext, pipeline: RunPipeline): void {
  const recorder = new ContextRecorder();
  // Order matters: options can skip the cell; the context is known before the confirmation shows it.
  pipeline.preparers.push(optionsPreparer, recorder, confirmPreparer);
  pipeline.observers.push({ onDidRunCell: (run) => recorder.noteRun(run.notebook, run.attrs) });
  context.subscriptions.push(
    recorder,
    vscode.window.onDidChangeActiveNotebookEditor(() => recorder.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.output.recordContext`)) recorder.reset();
      else if (e.affectsConfiguration(`${SECTION}.statusBar.contextAttr`)) recorder.refresh();
    }),
  );
  recorder.refresh();
}

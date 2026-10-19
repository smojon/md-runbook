/**
 * Per-cell fence options, confirmation of risky cells, and recording the target context
 * (cluster, server, ...) as output marker attributes, with a status bar item for it.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { isCodeMeta } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { ConfirmMode, DEFAULT_CONFIRM_PATTERNS, compileConfirmPatterns, confirmationFor } from '@md-runbook/core/confirm';
import { runContextCommand } from '@md-runbook/core/node/context';
import { currentOs, osLabel } from '@md-runbook/core/os';
import { SECTION, executionConfig, redactionConfig } from './config';
import { runbookCwd, workingDirectory } from './controller';
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
    if (o.checks) plan.checks = o.checks;
    if (o.retry) plan.retry = o.retry;
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
    Object.assign(plan.attrs, await this.values(notebook, plan.env, plan.cwd));
  }

  /** Context values for a notebook, cached for `recordContextCacheSeconds`. */
  values(notebook: vscode.NotebookDocument, extraEnv: Record<string, string> = {}, folder?: string): Promise<Record<string, string>> {
    const commands = recordContextCommands();
    if (Object.keys(commands).length === 0) return Promise.resolve({});
    // Where the cell runs (front matter cwd:, a cell's cwd=), so the context matches it.
    const cwd = folder ?? runbookCwd(notebook);
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

  /** The last known context of a runbook (no command runs for it). */
  known(notebook: vscode.NotebookDocument): Record<string, string> | undefined {
    return Object.keys(recordContextCommands()).length > 0 ? this.last.get(notebook.uri.toString()) : undefined;
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

/** Ask the user; on anything but Run the cell is recorded as declined and Run All stops. */
async function askToRun(plan: CellPlan, cell: vscode.NotebookCell, match: string): Promise<void> {
  const ctxLines = Object.keys(recordContextCommands())
    .filter((k) => k in plan.attrs)
    .map((k) => `${k}: ${plan.attrs[k]}`);
  const message = match === '' ? `Run cell ${cell.index + 1}?` : `Cell ${cell.index + 1} contains a risky command: “${match.trim()}”`;
  const retries = plan.retry && plan.retry.attempts > 1 ? `\n\nIt runs up to ${plan.retry.attempts} times (retry=) until it passes.` : '';
  const detail =
    (ctxLines.length > 0 ? `Context the cell will run in:\n${ctxLines.join('\n')}` : 'No context recorded (see mdRunbook.output.recordContext).') + retries;
  const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Run');
  if (answer !== 'Run') {
    plan.skip = 'not confirmed';
    plan.skipExit = 'declined'; // not done: progress keeps it pending, Resume Run offers it again
    // Later steps usually depend on this one; don't carry on without it.
    plan.stopSequence = true;
  }
}

/**
 * Decides whether a cell needs confirmation (a risky pattern, or always/never per settings and
 * cell options). Without context recording it asks right away, before any secret or input prompt.
 * With context recording the question waits for `finalPreparer`, so it can show the context
 * computed with the cell's final environment (.env, secrets, read-only credentials).
 */
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
    if (Object.keys(recordContextCommands()).length === 0) await askToRun(plan, cell, match);
    else plan.confirm = match;
  },
};

/** What a run of `source` in the cell would ask first, as `confirmationFor` (no message on bad patterns). */
function confirmationOf(cell: vscode.NotebookCell, source: string): string | undefined {
  const c = cfg();
  const { regexes } = compileConfirmPatterns(c.get<string[]>('execution.confirmPatterns', DEFAULT_CONFIRM_PATTERNS));
  return confirmationFor(source, c.get<ConfirmMode>('execution.confirm', 'patterns'), regexes, cellConfirmOption(infoOf(cell)));
}

export interface SafetyInfo {
  final: CellPreparer;
  /** undefined if running `source` in the cell won't ask; else the risky match ('' when it always asks). */
  confirmation(cell: vscode.NotebookCell, source: string): string | undefined;
  /** The last known context (cluster, ...) of a runbook, with `output.recordContext` set. */
  context(notebook: vscode.NotebookDocument): Record<string, string> | undefined;
}

export function registerSafety(context: vscode.ExtensionContext, pipeline: RunPipeline): SafetyInfo {
  const recorder = new ContextRecorder();
  // Order matters: options can skip the cell; the confirmation (when no context is recorded) comes
  // before secrets and inputs are asked for. `final` must be registered after every preparer that
  // changes plan.env (extension.ts: after approval.credentials).
  pipeline.preparers.push(optionsPreparer, confirmPreparer);
  // os=: a block for another OS is an alternative, not a step to run here.
  pipeline.excluders.push((cell) => {
    if (!cfg().get<boolean>('cellOptions.enabled', true)) return undefined;
    const os = parseCellOptions(infoOf(cell)).os;
    return os && !os.includes(currentOs()) ? `this block is for ${osLabel(os)}` : undefined;
  });
  const final: CellPreparer = {
    async prepare(plan, ctx) {
      if (plan.skip !== undefined) return;
      await recorder.prepare(plan, ctx);
      if (plan.confirm !== undefined) await askToRun(plan, ctx.cell, plan.confirm);
    },
  };
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
  return { final, confirmation: confirmationOf, context: (nb) => recorder.known(nb) };
}

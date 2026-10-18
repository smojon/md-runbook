/**
 * Secrets (OS keychain via SecretStorage), prompted inputs, runbook parameters and `.env` files,
 * all passed to cells as environment variables by one CellPreparer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { shellKindForLanguage } from './core';
import { RunbookParam, VAR_NAME_RE, findRefs, isRedactableValue, parseDotenv, parseFrontMatter, rewriteRefs } from './core/secrets';
import { CellPlan, PrepareContext, RunPipeline } from './pipeline';
import { SECTION } from './config';
import { NOTEBOOK_TYPE } from './serializer';

/** SecretStorage can't enumerate, so the names are kept here. */
const INDEX_KEY = 'mdRunbook.secretNames';
const KEY_PREFIX = 'mdRunbook.secret.';

const validateName = (v: string): string | undefined =>
  VAR_NAME_RE.test(v) ? undefined : 'Letters, digits and _ only, not starting with a digit.';

function runbookName(nb: vscode.NotebookDocument): string {
  return path.posix.basename(nb.uri.path);
}

function activeRunbook(): vscode.NotebookDocument | undefined {
  const nb = vscode.window.activeNotebookEditor?.notebook;
  if (nb?.notebookType === NOTEBOOK_TYPE) return nb;
  void vscode.window.showInformationMessage('md-runbook: open a runbook first.');
  return undefined;
}

/** Declared parameters of a runbook: front matter in its first (markup) cell. */
function declaredParams(nb: vscode.NotebookDocument): RunbookParam[] {
  const first = nb.cellCount > 0 ? nb.cellAt(0) : undefined;
  if (first?.kind !== vscode.NotebookCellKind.Markup) return [];
  return parseFrontMatter(first.document.getText())?.params ?? [];
}

/** Expand `${workspaceFolder}`; relative paths are relative to the runbook's folder. */
function resolveEnvFile(setting: string, cwd: string, uri: vscode.Uri): string {
  const ws = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  const expanded = setting.replace(/\$\{workspaceFolder\}/g, ws?.uri.fsPath ?? cwd);
  return path.resolve(cwd, expanded);
}

class SecretsFeature {
  /** Per-notebook session values, cleared when the notebook closes or on Reset Inputs. */
  private readonly inputs = new Map<string, Map<string, string>>();
  private readonly params = new Map<string, Map<string, string>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  names(): string[] {
    return this.context.globalState.get<string[]>(INDEX_KEY, []);
  }

  async storeSecret(name: string, value: string): Promise<void> {
    await this.context.secrets.store(KEY_PREFIX + name, value);
    await this.context.globalState.update(INDEX_KEY, [...new Set([...this.names(), name])].sort());
  }

  async deleteSecret(name: string): Promise<void> {
    await this.context.secrets.delete(KEY_PREFIX + name);
    await this.context.globalState.update(INDEX_KEY, this.names().filter((n) => n !== name));
  }

  /** A stored secret; if it's missing, ask for it once and store it. */
  private async secret(name: string, token: vscode.CancellationToken): Promise<string> {
    const stored = await this.context.secrets.get(KEY_PREFIX + name);
    if (stored !== undefined) return stored;
    const value = await vscode.window.showInputBox(
      {
        title: `md-runbook: secret ${name}`,
        prompt: `Secret ${name} is not set. Enter a value to store it in the OS keychain.`,
        password: true,
        ignoreFocusOut: true,
      },
      token,
    );
    if (!value) throw new Error(`secret ${name} is not set (md-runbook: Set Secret)`);
    await this.storeSecret(name, value);
    return value;
  }

  private session(map: Map<string, Map<string, string>>, nb: vscode.NotebookDocument): Map<string, string> {
    const key = nb.uri.toString();
    let m = map.get(key);
    if (!m) map.set(key, (m = new Map()));
    return m;
  }

  private async input(name: string, secret: boolean, ctx: PrepareContext): Promise<string> {
    const cache = this.session(this.inputs, ctx.notebook);
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const value = await vscode.window.showInputBox(
      { title: `${runbookName(ctx.notebook)}: input ${name}`, prompt: `Value for ${name}`, password: secret, ignoreFocusOut: true },
      ctx.token,
    );
    if (value === undefined) throw new Error(`input ${name} cancelled`);
    cache.set(name, value);
    return value;
  }

  private async param(name: string, ctx: PrepareContext): Promise<string> {
    const cache = this.session(this.params, ctx.notebook);
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const def = declaredParams(ctx.notebook).find((p) => p.name === name)?.default;
    const useDefaults = vscode.workspace.getConfiguration(SECTION).get<boolean>('params.useDefaults', false);
    const value =
      def !== undefined && useDefaults
        ? def
        : await vscode.window.showInputBox(
            { title: `${runbookName(ctx.notebook)}: parameter ${name}`, prompt: `Value for ${name}`, value: def, ignoreFocusOut: true },
            ctx.token,
          );
    if (value === undefined) throw new Error(`parameter ${name} cancelled`);
    cache.set(name, value);
    return value;
  }

  async prepare(plan: CellPlan, ctx: PrepareContext): Promise<void> {
    if (plan.skip !== undefined) return;
    const c = vscode.workspace.getConfiguration(SECTION);

    const envFile = c.get<string>('execution.envFile', '').trim();
    if (envFile) {
      const file = resolveEnvFile(envFile, plan.cwd, ctx.notebook.uri);
      if (fs.existsSync(file)) {
        const vars = parseDotenv(await fs.promises.readFile(file, 'utf8'));
        Object.assign(plan.env, vars);
        if (c.get<boolean>('redaction.redactKnownSecrets', true)) plan.secrets.push(...Object.values(vars).filter(isRedactableValue));
      }
    }

    for (const name of c.get<string[]>('secrets.inject', [])) {
      if (validateName(name)) throw new Error(`invalid secret name in mdRunbook.secrets.inject: ${name}`);
      const value = await this.secret(name, ctx.token);
      plan.env[name] = value;
      plan.secrets.push(value);
    }

    const shell = shellKindForLanguage(plan.language);
    if (!shell) return;
    const refs = findRefs(plan.source);
    for (const ref of refs) {
      const value =
        ref.kind === 'secret'
          ? await this.secret(ref.name, ctx.token)
          : ref.kind === 'input'
            ? await this.input(ref.name, ref.secret, ctx)
            : await this.param(ref.name, ctx);
      plan.env[ref.name] = value;
      if (ref.secret) plan.secrets.push(value);
    }
    if (refs.length > 0) plan.source = rewriteRefs(plan.source, shell);
  }

  forget(nb: vscode.NotebookDocument): void {
    this.inputs.delete(nb.uri.toString());
    this.params.delete(nb.uri.toString());
  }

  /** Ask for every declared parameter (or take `values` as given, e.g. from another extension). */
  async setParameters(values?: unknown): Promise<void> {
    const nb = activeRunbook();
    if (!nb) return;
    const cache = this.session(this.params, nb);
    if (typeof values === 'object' && values !== null && Object.values(values).every((v) => typeof v === 'string')) {
      for (const [k, v] of Object.entries(values as Record<string, string>)) if (VAR_NAME_RE.test(k)) cache.set(k, v);
      return;
    }
    const params = declaredParams(nb);
    if (params.length === 0) return void vscode.window.showInformationMessage('md-runbook: this runbook declares no params in its front matter.');
    for (const p of params) {
      const value = await vscode.window.showInputBox({
        title: `${runbookName(nb)}: parameter ${p.name}`,
        prompt: `Value for ${p.name}`,
        value: cache.get(p.name) ?? p.default,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      cache.set(p.name, value);
    }
  }

  async setSecretCommand(name?: unknown, value?: unknown): Promise<void> {
    if (typeof name === 'string' && typeof value === 'string' && !validateName(name) && value) return this.storeSecret(name, value);
    const n = await vscode.window.showInputBox({ title: 'md-runbook: Set Secret', prompt: 'Secret name, used as ${secret:NAME}', validateInput: validateName });
    if (!n) return;
    const v = await vscode.window.showInputBox({
      title: `md-runbook: Set Secret ${n}`,
      prompt: this.names().includes(n) ? 'New value (replaces the stored one)' : 'Value (stored in the OS keychain)',
      password: true,
      ignoreFocusOut: true,
      validateInput: (s) => (s ? undefined : 'The value must not be empty.'),
    });
    if (v) await this.storeSecret(n, v);
  }

  async deleteSecretCommand(name?: unknown): Promise<void> {
    const n = typeof name === 'string' ? name : await vscode.window.showQuickPick(this.names(), { title: 'md-runbook: Delete Secret' });
    if (n) await this.deleteSecret(n);
  }

  async listSecretsCommand(): Promise<void> {
    const names = this.names();
    if (names.length === 0) return void vscode.window.showInformationMessage('md-runbook: no secrets stored. Use md-runbook: Set Secret.');
    const pick = await vscode.window.showQuickPick(names, { title: 'md-runbook: Secrets (pick one to copy its reference)' });
    if (pick) await vscode.env.clipboard.writeText('${secret:' + pick + '}');
  }
}

export function registerSecrets(context: vscode.ExtensionContext, pipeline: RunPipeline): void {
  const f = new SecretsFeature(context);
  pipeline.preparers.push(f);
  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((nb) => f.forget(nb)),
    vscode.commands.registerCommand('mdRunbook.setSecret', (n?: unknown, v?: unknown) => f.setSecretCommand(n, v)),
    vscode.commands.registerCommand('mdRunbook.deleteSecret', (n?: unknown) => f.deleteSecretCommand(n)),
    vscode.commands.registerCommand('mdRunbook.listSecrets', () => f.listSecretsCommand()),
    vscode.commands.registerCommand('mdRunbook.setParameters', (values?: unknown) => f.setParameters(values)),
    vscode.commands.registerCommand('mdRunbook.resetInputs', () => {
      const nb = activeRunbook();
      if (nb) f.forget(nb);
    }),
  );
}

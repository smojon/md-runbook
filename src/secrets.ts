/**
 * Secrets (OS keychain via SecretStorage), prompted inputs, runbook parameters and `.env` files,
 * all passed to cells as environment variables by one CellPreparer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isCallLanguage, parseCall } from '@md-runbook/core/call';
import { passedParam } from './calls';
import { isCodeMeta, shellKindForLanguage } from '@md-runbook/core';
import { Captured, checkRefText, resolveChecks } from '@md-runbook/core/checks';
import { cellRefs, parseCellOptions } from '@md-runbook/core/cellOptions';
import { kubeContextParam, kubeContextRefText, resolveKubeContext, wantedKubeContext } from '@md-runbook/core/kubeContext';
import { proposalOf } from '@md-runbook/core/proposal';
import {
  FrontMatter,
  RefKind,
  RunbookParam,
  VAR_NAME_RE,
  VarRef,
  choiceProblem,
  dotenvSecrets,
  fillShown,
  findRefs,
  looksSecret,
  parseDotenv,
  parseFrontMatter,
  rewriteRefs,
  withDotenv,
} from '@md-runbook/core/secrets';
import { ALERT_PARAMS } from '@md-runbook/core/runReport';
import { META_KEY } from './outputs';
import { currentOs } from '@md-runbook/core/os';
import { CellPlan, PrepareContext, PromptCancelled, RunPipeline } from './pipeline';
import { SECTION } from './config';
import { NOTEBOOK_TYPE } from './serializer';
import { whileWaiting } from './waiting';
import { hostSkipped } from './remoteHosts';
import { testOnlyValues } from './testValues';
import { InputValues } from './inputValues';

/** SecretStorage can't enumerate, so the names are kept here. */
const INDEX_KEY = 'mdRunbook.secretNames';
const KEY_PREFIX = 'mdRunbook.secret.';

const validateName = (v: string): string | undefined =>
  VAR_NAME_RE.test(v) ? undefined : 'Letters, digits and _ only, not starting with a digit.';

function runbookName(nb: vscode.NotebookDocument): string {
  return path.posix.basename(nb.uri.path);
}

/** Where a value is asked for: the runbook and, when known, the cell that uses it. */
interface Asking {
  notebook: vscode.NotebookDocument;
  cell?: vscode.NotebookCell;
  token?: vscode.CancellationToken;
}

/** " · cell 4" in a prompt's title: the box opens at the top of the window, away from the cell. */
const forCell = (a: Asking): string => (a.cell ? ` · cell ${a.cell.index + 1}` : '');

function activeRunbook(): vscode.NotebookDocument | undefined {
  const nb = vscode.window.activeNotebookEditor?.notebook;
  if (nb?.notebookType === NOTEBOOK_TYPE) return nb;
  void vscode.window.showInformationMessage('md-runbook: open a runbook first.');
  return undefined;
}

/** A runbook's front matter: in its first (markup) cell. */
function frontMatter(nb: vscode.NotebookDocument): FrontMatter | undefined {
  const first = nb.cellCount > 0 ? nb.cellAt(0) : undefined;
  return first?.kind === vscode.NotebookCellKind.Markup ? parseFrontMatter(first.document.getText()) : undefined;
}

/** A parameter with choices (`One of: a, b` in its comment): the box takes only one of them. */
function choicesCheck(p: RunbookParam | undefined): Pick<vscode.InputBoxOptions, 'validateInput'> {
  const choices = p?.choices;
  return choices ? { validateInput: (v) => (choices.includes(v) ? undefined : `One of: ${choices.join(', ')}`) } : {};
}

/** Declared parameters of a runbook. */
function declaredParams(nb: vscode.NotebookDocument): RunbookParam[] {
  return frontMatter(nb)?.params ?? [];
}

/** The `${…}` references of the runbook's shell cells, in order (cells with malformed ones are skipped). */
function usedRefs(nb: vscode.NotebookDocument): ReturnType<typeof findRefs> {
  const out: ReturnType<typeof findRefs> = [];
  const fm = frontMatter(nb);
  for (const cell of nb.getCells()) {
    if (cell.kind !== vscode.NotebookCellKind.Code || !shellKindForLanguage(cell.document.languageId)) continue;
    try {
      const meta: unknown = cell.metadata?.[META_KEY];
      out.push(...cellRefs(cell.document.getText(), isCodeMeta(meta) ? meta.info : '', fm));
    } catch {
      // a name used as two kinds: the run reports it
    }
  }
  return out;
}

/**
 * The parameters, inputs and secrets a run of `cells` uses, once each, with the first cell that
 * uses it: not the setup, ready check and teardown (they may not run), skipped cells, cells for
 * another OS or another host, or an assistant's cells; not a parameter a runbook call passed.
 */
function upFrontRefs(nb: vscode.NotebookDocument, cells: readonly vscode.NotebookCell[]): { ref: VarRef; cell: vscode.NotebookCell }[] {
  const fm = frontMatter(nb);
  const seen = new Set<string>();
  const out: { ref: VarRef; cell: vscode.NotebookCell }[] = [];
  for (const cell of cells) {
    if (cell.kind !== vscode.NotebookCellKind.Code || !shellKindForLanguage(cell.document.languageId)) continue;
    const meta: unknown = cell.metadata?.[META_KEY];
    const info = isCodeMeta(meta) ? meta.info : '';
    const o = parseCellOptions(info);
    if (o.skip || o.part !== undefined || hostSkipped(info, nb) || (o.host === undefined && o.os && !o.os.includes(currentOs())) || proposalOf(info).by !== undefined) continue;
    let refs: VarRef[];
    try {
      refs = cellRefs(cell.document.getText(), info, fm);
    } catch {
      continue; // a name used as two kinds: the run reports it
    }
    for (const r of refs) {
      if (r.kind === 'out' || seen.has(`${r.kind}:${r.name}`)) continue;
      seen.add(`${r.kind}:${r.name}`);
      if (r.kind === 'param' && passedParam(nb.uri, r.name) !== undefined) continue;
      out.push({ ref: r, cell });
    }
  }
  return out;
}

/** Expand `${workspaceFolder}`; relative paths are relative to the runbook's folder. */
function resolveEnvFile(setting: string, cwd: string, uri: vscode.Uri): string {
  const ws = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  const expanded = setting.replace(/\$\{workspaceFolder\}/g, ws?.uri.fsPath ?? cwd);
  return path.resolve(cwd, expanded);
}

class SecretsFeature {
  /** Per-notebook session values, cleared when the notebook closes or on Reset Inputs. */
  private readonly inputs = new Map<string, InputValues>();
  private readonly params = new Map<string, Map<string, string>>();
  /** Values captured from cell output (`capture=`), for `${out:NAME}`. */
  private readonly outs = new Map<string, Map<string, Captured>>();

  /** The session's input values of `nb` (made when missing). */
  private inputsOf(nb: vscode.NotebookDocument): InputValues {
    const key = nb.uri.toString();
    let v = this.inputs.get(key);
    if (!v) this.inputs.set(key, (v = new InputValues()));
    return v;
  }

  /**
   * Whether `${input:NAME}` is a secret input in `nb`: written `${input:NAME:secret}` in any of its
   * cells, or asked as one this session. Then every use of the name is masked and redacted.
   */
  private secretInput(nb: vscode.NotebookDocument, name: string): boolean {
    return this.inputs.get(nb.uri.toString())?.isSecret(name) === true || usedRefs(nb).some((r) => r.kind === 'input' && r.secret && r.name === name);
  }

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

  /**
   * Secrets live in the OS keychain for all workspaces, so the first time runbooks in a workspace
   * use one, the user is asked to allow it (remembered for that workspace).
   */
  private async allowedHere(name: string, ctx: Asking): Promise<void> {
    const allowed = this.context.workspaceState.get<string[]>(ALLOWED_KEY, []);
    if (allowed.includes(name)) return;
    const answer = await whileWaiting(ctx.cell, `allow secret ${name}`, () =>
      vscode.window.showWarningMessage(
        `Allow runbooks in this workspace to use the stored secret ${name}?`,
        { modal: true, detail: `${runbookName(ctx.notebook)} references \${secret:${name}}. The value is passed to the cell as an environment variable and redacted from output by exact match.` },
        'Allow',
      ),
      'dialog',
    );
    if (answer !== 'Allow') throw new Error(`secret ${name} was not allowed for this workspace`);
    await this.context.workspaceState.update(ALLOWED_KEY, [...allowed, name]);
  }

  /** Mark a secret as allowed for this workspace (test helper and after storing one here). */
  async allow(name: string): Promise<void> {
    const allowed = this.context.workspaceState.get<string[]>(ALLOWED_KEY, []);
    if (!allowed.includes(name)) await this.context.workspaceState.update(ALLOWED_KEY, [...allowed, name]);
  }

  /** A stored secret; if it's missing, ask for it once and store it. */
  private async secret(name: string, ctx: Asking): Promise<string> {
    const token = ctx.token;
    const stored = await this.context.secrets.get(KEY_PREFIX + name);
    if (stored !== undefined) {
      await this.allowedHere(name, ctx);
      return stored;
    }
    const value = await whileWaiting(ctx.cell, `secret ${name}`, () =>
      vscode.window.showInputBox(
        {
          title: `md-runbook: secret ${name}${forCell(ctx)}`,
          prompt: `Secret ${name} is not set. Enter a value to store it in the OS keychain.`,
          password: true,
          ignoreFocusOut: true,
        },
        token,
      ),
    );
    if (!value) throw new Error(`secret ${name} is not set (md-runbook: Set Secret)`);
    await this.storeSecret(name, value);
    await this.allow(name); // entered here, for this workspace
    return value;
  }

  private session<T>(map: Map<string, Map<string, T>>, nb: vscode.NotebookDocument): Map<string, T> {
    const key = nb.uri.toString();
    let m = map.get(key);
    if (!m) map.set(key, (m = new Map()));
    return m;
  }

  /**
   * The value a parameter or a non-secret input had the last time it was given for this runbook
   * (kept in the workspace's state, never for secrets), to fill the box in: Enter takes it again.
   */
  private last(nb: vscode.NotebookDocument, kind: 'param' | 'input', name: string): { value: string; at: number } | undefined {
    const all = this.context.workspaceState.get<Record<string, Record<string, { value: string; at: number }>>>(LAST_KEY, {});
    return all[nb.uri.toString()]?.[`${kind}:${name}`];
  }

  private remember(nb: vscode.NotebookDocument, kind: 'param' | 'input', name: string, value: string): void {
    const all = { ...this.context.workspaceState.get<Record<string, Record<string, { value: string; at: number }>>>(LAST_KEY, {}) };
    all[nb.uri.toString()] = { ...all[nb.uri.toString()], [`${kind}:${name}`]: { value, at: Date.now() } };
    void this.context.workspaceState.update(LAST_KEY, all);
  }

  private async input(name: string, asSecret: boolean, ctx: Asking): Promise<string> {
    const cache = this.inputsOf(ctx.notebook);
    // `${input:NAME:secret}` anywhere in the runbook makes every use of NAME secret.
    const secret = asSecret || this.secretInput(ctx.notebook, name);
    const cached = cache.get(name);
    if (cached !== undefined) {
      if (secret) cache.markSecret(name);
      return cached;
    }
    const last = secret ? undefined : this.last(ctx.notebook, 'input', name);
    const value = await whileWaiting(ctx.cell, `input ${name}`, () =>
      vscode.window.showInputBox(
        {
          title: `${runbookName(ctx.notebook)}: input ${name}${forCell(ctx)}`,
          prompt: last ? `Value for ${name} (last used ${ago(last.at)}; Enter keeps it)` : `Value for ${name}`,
          ...(last ? { value: last.value } : {}),
          password: secret,
          ignoreFocusOut: true,
        },
        ctx.token,
      ),
    );
    if (value === undefined) throw new PromptCancelled(`input ${name} cancelled`);
    cache.set(name, value, secret);
    if (!secret) this.remember(ctx.notebook, 'input', name, value);
    return value;
  }

  private async param(name: string, ctx: Asking): Promise<string> {
    const declared = declaredParams(ctx.notebook).find((p) => p.name === name);
    // One of its choices ("One of: a, b"), wherever the value comes from: a call, a link, the default.
    const checked = (value: string): string => {
      const off = choiceProblem(declared, value);
      if (off) throw new Error(`md-runbook: ${off}`);
      return value;
    };
    // A copy run by a runbook call: the value the call passed.
    const fromCall = passedParam(ctx.notebook.uri, name);
    if (fromCall !== undefined) return checked(fromCall);
    const cache = this.session(this.params, ctx.notebook);
    const cached = cache.get(name);
    if (cached !== undefined) {
      if (choiceProblem(declared, cached)) cache.delete(name); // asked again next time
      return checked(cached);
    }
    const def = declared?.default;
    const useDefaults = vscode.workspace.getConfiguration(SECTION).get<boolean>('params.useDefaults', false);
    if (def !== undefined && useDefaults) {
      checked(def);
      cache.set(name, def);
      return def;
    }
    // Filled in: the value last used for this runbook, else the default (Enter takes it).
    const last = this.last(ctx.notebook, 'param', name);
    const value = await whileWaiting(ctx.cell, `parameter ${name}`, () =>
      vscode.window.showInputBox(
        {
          title: `${runbookName(ctx.notebook)}: parameter ${name}${forCell(ctx)}`,
          prompt:
            (declared?.description ? `${declared.description} ` : '') +
            (last ? `Value for ${name} (last used ${ago(last.at)}; Enter keeps it)` : def !== undefined ? `Value for ${name} (the default; Enter keeps it)` : `Value for ${name}`),
          value: last?.value ?? def,
          ignoreFocusOut: true,
          ...choicesCheck(declared),
        },
        ctx.token,
      ),
    );
    if (value === undefined) throw new PromptCancelled(`parameter ${name} cancelled`);
    cache.set(name, value);
    this.remember(ctx.notebook, 'param', name, value);
    return value;
  }

  async prepare(plan: CellPlan, ctx: PrepareContext): Promise<void> {
    if (plan.skip !== undefined) return;
    const c = vscode.workspace.getConfiguration(SECTION);
    // Cells written by an assistant get none of your secrets: no .env file, no injected secrets,
    // no ${secret:} / secret inputs. Their only credentials are mdRunbook.approval.readOnlyEnv.
    const meta: unknown = ctx.cell.metadata?.[META_KEY];
    const by = isCodeMeta(meta) ? proposalOf(meta.info).by : undefined;

    const envFile = c.get<string>('execution.envFile', '').trim();
    if (envFile && !by) {
      const file = resolveEnvFile(envFile, plan.cwd, ctx.notebook.uri);
      if (fs.existsSync(file)) {
        const vars = parseDotenv(await fs.promises.readFile(file, 'utf8'));
        // The cell's own env.NAME= options win over the file (optionsPreparer set them already).
        const own = c.get<boolean>('cellOptions.enabled', true) ? parseCellOptions(isCodeMeta(meta) ? meta.info : '').env : {};
        plan.env = withDotenv(plan.env, vars, own);
        // Only values that look like secrets (by name or by entropy): REGION=eu-west-1 must not be
        // redacted everywhere for the rest of the session.
        if (c.get<boolean>('redaction.redactKnownSecrets', true)) plan.secrets.push(...dotenvSecrets(vars));
      }
    }

    for (const name of by ? [] : c.get<string[]>('secrets.inject', [])) {
      if (validateName(name)) throw new Error(`invalid secret name in mdRunbook.secrets.inject: ${name}`);
      const value = await this.secret(name, ctx);
      plan.env[name] = value;
      plan.secrets.push(value);
    }

    const shell = shellKindForLanguage(plan.language);
    const call = isCallLanguage(plan.language) ? parseCall(isCodeMeta(meta) ? meta.info : '', plan.source) : undefined;
    if (!shell && !call) return;
    // The checks' references too (expect="${out:NAME}"): asked and filled in like the code's.
    const checkText = checkRefText(plan.checks);
    // And kube-context=${param:NAME} (or the front matter's): the parameter is asked like the others.
    const wantedContext = wantedKubeContext(parseCellOptions(isCodeMeta(meta) ? meta.info : ''), frontMatter(ctx.notebook));
    // A call: the placeholders of its src= and of the values it passes.
    const own = call ? [call.src ?? '', ...call.args.map((a) => a.value)].join('\n') : plan.source;
    const refs = findRefs([own, checkText, kubeContextRefText(wantedContext)].filter((t) => t !== '').join('\n'));
    const secretRefs = by ? refs.filter((r) => r.secret) : [];
    if (secretRefs.length > 0) {
      const names = secretRefs.map((r) => (r.kind === 'secret' ? `\${secret:${r.name}}` : `\${input:${r.name}} (secret)`)).join(', ');
      throw new Error(
        `md-runbook: cells proposed by an assistant (by=${by}) cannot use secrets (${names}). ` +
          'They only get the credentials in "mdRunbook.approval.readOnlyEnv".',
      );
    }
    const values: Record<string, string> = {};
    const secrets = new Set<string>();
    for (const ref of refs) {
      let value: string;
      let secret = ref.secret;
      if (ref.kind === 'out') {
        const captured = this.session(this.outs, ctx.notebook).get(ref.name);
        if (!captured) throw new Error(`md-runbook: \${out:${ref.name}} has no value yet; run the cell with capture=${ref.name} first`);
        if (captured.secret && by) {
          throw new Error(`md-runbook: cells proposed by an assistant (by=${by}) cannot use values captured as secret (\${out:${ref.name}}).`);
        }
        // An assistant cell's output must not steer a cell of yours, which runs with your credentials.
        if (captured.fromAssistant && !by) {
          throw new Error(
            `md-runbook: \${out:${ref.name}} was captured by a cell written by an assistant, and your own cells don't use values an assistant cell produced. Capture it in a cell of your own.`,
          );
        }
        ({ value, secret } = captured);
      } else {
        value =
          ref.kind === 'secret'
            ? await this.secret(ref.name, ctx)
            : ref.kind === 'input'
              ? await this.input(ref.name, ref.secret, ctx)
              : await this.param(ref.name, ctx);
        // The same input written `${input:NAME:secret}` elsewhere: secret here too (redacted).
        if (ref.kind === 'input') secret ||= this.secretInput(ctx.notebook, ref.name);
      }
      plan.env[ref.name] = value;
      values[ref.name] = value;
      if (secret) {
        plan.secrets.push(value);
        secrets.add(ref.name);
      }
    }
    plan.refValues = values;
    if (plan.checks && checkText !== '') plan.checks = resolveChecks(plan.checks, values, (n) => secrets.has(n));
    plan.kubeContext = resolveKubeContext(wantedContext, (n) => values[n]);
    // The parameter's value isn't in the file: the run records it.
    if (plan.kubeContext !== undefined && kubeContextParam(wantedContext) !== undefined) plan.attrs['kube-context'] = plan.kubeContext;
    if (call) {
      plan.callValues = values;
      return;
    }
    if (refs.length > 0 && shell) {
      // What a confirmation shows and its risky patterns see: the values, not the placeholders (secrets stay).
      plan.shown = fillShown(plan.source, (ref) => (values[ref.name] !== undefined ? { value: values[ref.name]!, secret: secrets.has(ref.name) } : undefined));
      plan.source = rewriteRefs(plan.source, shell);
      plan.steps = plan.steps?.map((step) => rewriteRefs(step, shell));
    }
  }

  /**
   * What each `${…}` reference in `source` stands for now, without asking for anything: the
   * value, or why there is none yet. Secret values are never shown or copied.
   */
  peek(nb: vscode.NotebookDocument, source: string): RefValue[] {
    let refs;
    try {
      refs = findRefs(source);
    } catch {
      return []; // a name used as two kinds: the run reports it
    }
    const known = (map: Map<string, Map<string, string>>, name: string): string | undefined => map.get(nb.uri.toString())?.get(name);
    return refs.map((ref): RefValue => {
      const r = { kind: ref.kind, name: ref.name };
      switch (ref.kind) {
        case 'secret':
          return { ...r, secret: true, shown: this.names().includes(ref.name) ? undefined : 'not set: asked when it runs' };
        case 'input': {
          const v = this.inputs.get(nb.uri.toString())?.get(ref.name);
          const secret = ref.secret || this.secretInput(nb, ref.name);
          if (v === undefined) return { ...r, secret, shown: 'asked when it runs' };
          return secret ? { ...r, secret: true } : { ...r, secret: false, value: v };
        }
        case 'param': {
          const v = known(this.params, ref.name);
          if (v !== undefined) return { ...r, secret: false, value: v };
          const def = declaredParams(nb).find((p) => p.name === ref.name)?.default;
          if (def !== undefined && vscode.workspace.getConfiguration(SECTION).get<boolean>('params.useDefaults', false)) return { ...r, secret: false, value: def };
          return { ...r, secret: false, shown: def === undefined ? 'asked when it runs' : `asked when it runs (default ${def})` };
        }
        case 'out': {
          const c = this.outs.get(nb.uri.toString())?.get(ref.name);
          if (!c) return { ...r, secret: false, shown: `no value yet: run the cell with capture=${ref.name} first` };
          if (c.secret) return { ...r, secret: true };
          return { ...r, secret: false, value: c.value, ...(c.fromAssistant ? { note: 'captured by an assistant cell' } : {}) };
        }
      }
    });
  }

  /**
   * Run All (several cells): ask now, at the click, for the parameters and inputs of the cells
   * about to run, instead of halfway through when the reader may have looked away. Not for the
   * setup, ready check and teardown (they may not run), skipped cells, cells for another OS or
   * another host, or an assistant's cells. False: Escape, so nothing should run.
   */
  async askUpFront(nb: vscode.NotebookDocument, cells: readonly vscode.NotebookCell[]): Promise<boolean> {
    for (const { ref: r, cell } of upFrontRefs(nb, cells)) {
      if (r.kind !== 'param' && r.kind !== 'input') continue;
      try {
        if (r.kind === 'param') await this.param(r.name, { notebook: nb, cell });
        else await this.input(r.name, r.secret, { notebook: nb, cell });
      } catch (e) {
        // Escape stops quietly; a value that isn't one of its choices says so.
        if (!(e instanceof PromptCancelled)) void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
        return false;
      }
    }
    return true;
  }

  /**
   * The launch form's values for a run of `cells` (the same ones askUpFront asks, and the secrets
   * they use): each parameter with its description and choices, filled in with the value of this
   * session, else the last one used, else the default; each input (a secret one never filled in);
   * each secret, stored or not. Asks nothing.
   */
  launchValues(nb: vscode.NotebookDocument, cells: readonly vscode.NotebookCell[]): LaunchValues {
    const declared = declaredParams(nb);
    const params: LaunchValues['params'] = [];
    const inputs: LaunchValues['inputs'] = [];
    const secrets: LaunchValues['secrets'] = [];
    const stored = new Set(this.names());
    const allowed = new Set(this.context.workspaceState.get<string[]>(ALLOWED_KEY, []));
    const session = (map: Map<string, Map<string, string>>, name: string): string | undefined => map.get(nb.uri.toString())?.get(name);
    const addSecret = (name: string): void => {
      if (!secrets.some((s) => s.name === name)) secrets.push({ name, stored: stored.has(name), ...(stored.has(name) && !allowed.has(name) ? { askAllow: true } : {}) });
    };
    for (const { ref: r } of upFrontRefs(nb, cells)) {
      if (r.kind === 'param') {
        const p = declared.find((d) => d.name === r.name);
        const now = session(this.params, r.name);
        const last = this.last(nb, 'param', r.name)?.value;
        const value = now ?? last ?? p?.default;
        params.push({
          name: r.name,
          ...(p?.description ? { description: p.description } : {}),
          ...(p?.choices ? { choices: p.choices } : {}),
          ...(p?.default !== undefined ? { default: p.default } : {}),
          ...(value !== undefined ? { value, from: now !== undefined ? 'session' : last !== undefined ? 'last' : 'default' } : {}),
        });
      } else if (r.kind === 'input') {
        const now = this.inputs.get(nb.uri.toString())?.get(r.name);
        if (r.secret || this.secretInput(nb, r.name)) inputs.push({ name: r.name, secret: true, ...(now !== undefined ? { set: true } : {}) });
        else {
          const value = now ?? this.last(nb, 'input', r.name)?.value;
          inputs.push({ name: r.name, secret: false, ...(value !== undefined ? { value } : {}) });
        }
      } else if (r.kind === 'secret') addSecret(r.name);
    }
    // Secrets every cell gets (mdRunbook.secrets.inject): asked when missing too.
    for (const name of vscode.workspace.getConfiguration(SECTION).get<string[]>('secrets.inject', [])) if (!validateName(name)) addSecret(name);
    // Declared first, in the order of the front matter, then the others in the order of use.
    const order = (name: string): number => {
      const i = declared.findIndex((d) => d.name === name);
      return i < 0 ? declared.length : i;
    };
    params.sort((a, b) => order(a.name) - order(b.name));
    return { params, inputs, secrets };
  }

  /**
   * Values for this session, as if typed in the boxes (the launch form's Start): a Run All then
   * finds them and asks nothing. Remembered as the last values, except secret inputs.
   */
  setSessionValues(nb: vscode.NotebookDocument, values: { params?: Readonly<Record<string, string>>; inputs?: Readonly<Record<string, string>> }): void {
    const secretInputs = new Set(usedRefs(nb).filter((r) => r.kind === 'input' && r.secret).map((r) => r.name));
    const params = this.session(this.params, nb);
    for (const [k, v] of Object.entries(values.params ?? {})) {
      if (!VAR_NAME_RE.test(k)) continue;
      params.set(k, v);
      this.remember(nb, 'param', k, v);
    }
    const inputs = this.inputsOf(nb);
    for (const [k, v] of Object.entries(values.inputs ?? {})) {
      if (!VAR_NAME_RE.test(k)) continue;
      inputs.set(k, v, secretInputs.has(k));
      if (!inputs.isSecret(k) && !looksSecret(k)) this.remember(nb, 'input', k, v);
    }
  }

  forget(nb: vscode.NotebookDocument): void {
    this.inputs.delete(nb.uri.toString());
    this.params.delete(nb.uri.toString());
    this.outs.delete(nb.uri.toString());
  }

  /** Keep values a cell captured (`capture=`) for later cells' `${out:NAME}`. */
  capture(nb: vscode.NotebookDocument, values: readonly Captured[], fromAssistant: boolean): void {
    const m = this.session(this.outs, nb);
    for (const v of values) m.set(v.name, { ...v, fromAssistant });
  }

  /**
   * The run's ALERT, ALERT_FINGERPRINT and ALERT_LABELS parameter values (a run report says which
   * alert a run answered, core/runReport.ts): no other parameter.
   */
  alertParams(nb: vscode.NotebookDocument): Record<string, string> {
    const cache = this.params.get(nb.uri.toString());
    const out: Record<string, string> = {};
    for (const k of ALERT_PARAMS) {
      const v = cache?.get(k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /** A stored secret's value, or undefined; asks nothing (a run report's token). */
  storedSecret(name: string): Thenable<string | undefined> {
    return this.context.secrets.get(KEY_PREFIX + name);
  }

  /** Set parameter values for `nb` without asking (a runbook link's values, checked by parseRunbookLink; one not among its choices is not taken). */
  fillParameters(nb: vscode.NotebookDocument, values: Readonly<Record<string, string>>): void {
    const cache = this.session(this.params, nb);
    const declared = declaredParams(nb);
    const refused: string[] = [];
    for (const [k, v] of Object.entries(values)) {
      if (!VAR_NAME_RE.test(k)) continue;
      // Not one of its choices: not taken, so it is asked (the box takes only a choice).
      const off = choiceProblem(declared.find((p) => p.name === k), v);
      if (off) refused.push(off);
      else cache.set(k, v);
    }
    if (refused.length > 0) void vscode.window.showWarningMessage(`md-runbook: the link's value is not taken: ${refused.join('; ')}. It is asked when the runbook runs.`);
  }

  /** Test mode only (mdRunbook._test.setParameters): parameter values for the active runbook, not asked. */
  setParameterValues(values: unknown): void {
    const checked = testOnlyValues(values, isTestMode(this.context));
    const nb = activeRunbook();
    if (!nb) return;
    const cache = this.session(this.params, nb);
    for (const [k, v] of Object.entries(checked)) cache.set(k, v);
  }

  /** Test mode only (mdRunbook._test.setInputs): input values for the active runbook, not asked. */
  setInputValues(values: unknown): void {
    const checked = testOnlyValues(values, isTestMode(this.context));
    const nb = activeRunbook();
    if (!nb) return;
    const cache = this.inputsOf(nb);
    for (const [k, v] of Object.entries(checked)) cache.set(k, v, false);
  }

  /** Ask for every declared parameter (Set Parameters). Takes no values: a command link can't set any. */
  async setParameters(): Promise<void> {
    const nb = activeRunbook();
    if (!nb) return;
    const cache = this.session(this.params, nb);
    // Declared ones first (with their defaults), then any other the cells use.
    const params: RunbookParam[] = [...declaredParams(nb)];
    for (const r of usedRefs(nb)) if (r.kind === 'param' && !params.some((p) => p.name === r.name)) params.push({ name: r.name });
    if (params.length === 0) return void vscode.window.showInformationMessage('md-runbook: this runbook has no parameters (${param:NAME}).');
    for (const p of params) {
      const value = await vscode.window.showInputBox({
        title: `${runbookName(nb)}: parameter ${p.name}`,
        prompt: (p.description ? `${p.description} ` : '') + `Value for ${p.name}`,
        value: cache.get(p.name) ?? this.last(nb, 'param', p.name)?.value ?? p.default,
        ignoreFocusOut: true,
        ...choicesCheck(p),
      });
      if (value === undefined) return;
      cache.set(p.name, value);
      this.remember(nb, 'param', p.name, value);
    }
  }

  /**
   * Ask for every `${input:NAME}` the runbook's cells use, the current value filled in (a secret
   * one is masked and never shown: empty keeps it). Escape stops; the values set so far stay.
   */
  async setInputs(): Promise<void> {
    const nb = activeRunbook();
    if (!nb) return;
    const cache = this.inputsOf(nb);
    const inputs = new Map<string, boolean>();
    for (const r of usedRefs(nb)) if (r.kind === 'input') inputs.set(r.name, (inputs.get(r.name) ?? false) || r.secret);
    if (inputs.size === 0) return void vscode.window.showInformationMessage('md-runbook: this runbook has no inputs (${input:NAME}).');
    for (const [name, written] of inputs) {
      const secret = written || cache.isSecret(name);
      const current = cache.get(name);
      const value = await vscode.window.showInputBox({
        title: `${runbookName(nb)}: input ${name}`,
        prompt: secret && current !== undefined ? `Value for ${name} (empty keeps the current one)` : `Value for ${name}`,
        value: secret ? undefined : (current ?? this.last(nb, 'input', name)?.value),
        password: secret,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      if (secret && value === '' && current !== undefined) continue;
      cache.set(name, value, secret);
      if (!secret) this.remember(nb, 'input', name, value);
    }
  }

  /**
   * Set Secret: the name, then the value (masked). `name` (the launch form's Set button, never a
   * command argument) skips the first box; the value is always typed.
   */
  async setSecretCommand(name?: string): Promise<void> {
    const n =
      name !== undefined && !validateName(name)
        ? name
        : await vscode.window.showInputBox({ title: 'md-runbook: Set Secret', prompt: 'Secret name, used as ${secret:NAME}', validateInput: validateName });
    if (!n) return;
    const v = await vscode.window.showInputBox({
      title: `md-runbook: Set Secret ${n}`,
      prompt: this.names().includes(n) ? 'New value (replaces the stored one)' : 'Value (stored in the OS keychain)',
      password: true,
      ignoreFocusOut: true,
      validateInput: (s) => (s ? undefined : 'The value must not be empty.'),
    });
    if (v) {
      await this.storeSecret(n, v);
      await this.allow(n);
    }
  }

  async deleteSecretCommand(): Promise<void> {
    const n = await vscode.window.showQuickPick(this.names(), { title: 'md-runbook: Delete Secret' });
    if (n) await this.deleteSecret(n);
  }

  async listSecretsCommand(): Promise<void> {
    const names = this.names();
    if (names.length === 0) return void vscode.window.showInformationMessage('md-runbook: no secrets stored. Use md-runbook: Set Secret.');
    const pick = await vscode.window.showQuickPick(names, { title: 'md-runbook: Secrets (pick one to copy its reference)' });
    if (pick) await vscode.env.clipboard.writeText('${secret:' + pick + '}');
  }
}

const ALLOWED_KEY = 'mdRunbook.allowedSecrets';
/** Per runbook: the last value of each parameter and non-secret input (never secrets). */
const LAST_KEY = 'mdRunbook.lastValues';

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: number, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** A `${kind:name}` reference as it stands now (see `peek`). */
export interface RefValue {
  kind: RefKind;
  name: string;
  /** Never shown or copied. */
  secret: boolean;
  /** The value a run would use now (never set for a secret). */
  value?: string;
  /** Why there is no value yet, e.g. "asked when it runs". */
  shown?: string;
  note?: string;
}

/** The values a run of some cells uses, for the launch form (SecretsFeature.launchValues). */
export interface LaunchValues {
  params: {
    name: string;
    description?: string;
    choices?: string[];
    default?: string;
    /** What the field starts with, and where it comes from. */
    value?: string;
    from?: 'session' | 'last' | 'default';
  }[];
  /** A secret input is never filled in: `set` says this session has a value for it. */
  inputs: { name: string; secret: boolean; value?: string; set?: boolean }[];
  /** `askAllow`: stored, but this workspace hasn't used it yet (the run asks to allow it). */
  secrets: { name: string; stored: boolean; askAllow?: boolean }[];
}

export interface SecretsInfo {
  /** The references in `source` and their current values, without asking for anything. */
  values(notebook: vscode.NotebookDocument, source: string): RefValue[];
  /** Fill parameter values for this session (a runbook link's p.NAME=); a run still uses them as values, never as code. */
  fillParameters(notebook: vscode.NotebookDocument, values: Readonly<Record<string, string>>): void;
  /** The launch form's parameters, inputs and secrets for a run of `cells`; asks nothing. */
  launchValues(notebook: vscode.NotebookDocument, cells: readonly vscode.NotebookCell[]): LaunchValues;
  /** The launch form's Start: the values for this session, remembered as the last ones (never secrets). */
  setSessionValues(notebook: vscode.NotebookDocument, values: { params?: Readonly<Record<string, string>>; inputs?: Readonly<Record<string, string>> }): void;
  /** Set Secret for one name (the value is typed in a masked box). */
  setSecret(name: string): Promise<void>;
  /** The run's ALERT, ALERT_FINGERPRINT and ALERT_LABELS parameter values, for its run report. */
  alertParams(notebook: vscode.NotebookDocument): Record<string, string>;
  /** A stored secret, without asking (a run report's token). */
  storedSecret(name: string): Thenable<string | undefined>;
}

/** Test-only helpers are registered only under the extension test runner (or the test harness). */
export function isTestMode(context: vscode.ExtensionContext): boolean {
  return context.extensionMode === vscode.ExtensionMode.Test || process.env.MD_RUNBOOK_TEST === '1';
}

export function registerSecrets(context: vscode.ExtensionContext, pipeline: RunPipeline): SecretsInfo {
  const f = new SecretsFeature(context);
  pipeline.preparers.push(f);
  pipeline.observers.push({
    // One cell asks when it runs (right away); a run of several asks for all its values first.
    onWillRunSequence: (nb, cells) => (cells.length > 1 ? f.askUpFront(nb, cells) : undefined),
    onDidRunCell: (run) => {
      if (!run.captured) return;
      const meta: unknown = run.cell.metadata?.[META_KEY];
      f.capture(run.notebook, run.captured, isCodeMeta(meta) && proposalOf(meta.info).by !== undefined);
    },
  });
  if (isTestMode(context)) {
    context.subscriptions.push(
      vscode.commands.registerCommand('mdRunbook._test.setSecret', async (name: string, value: string) => {
        await f.storeSecret(name, value);
        await f.allow(name);
      }),
      vscode.commands.registerCommand('mdRunbook._test.deleteSecret', (name: string) => f.deleteSecret(name)),
      vscode.commands.registerCommand('mdRunbook._test.setParameters', (values: unknown) => f.setParameterValues(values)),
      vscode.commands.registerCommand('mdRunbook._test.setInputs', (values: unknown) => f.setInputValues(values)),
    );
  }
  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((nb) => f.forget(nb)),
    // Public commands take no values as arguments, so a command link can't set or delete anything.
    vscode.commands.registerCommand('mdRunbook.setSecret', () => f.setSecretCommand()),
    vscode.commands.registerCommand('mdRunbook.deleteSecret', () => f.deleteSecretCommand()),
    vscode.commands.registerCommand('mdRunbook.listSecrets', () => f.listSecretsCommand()),
    vscode.commands.registerCommand('mdRunbook.setParameters', () => f.setParameters()),
    vscode.commands.registerCommand('mdRunbook.setInputs', () => f.setInputs()),
    vscode.commands.registerCommand('mdRunbook.resetInputs', () => {
      const nb = activeRunbook();
      if (nb) f.forget(nb);
    }),
  );
  return {
    values: (nb, source) => f.peek(nb, source),
    fillParameters: (nb, values) => f.fillParameters(nb, values),
    launchValues: (nb, cells) => f.launchValues(nb, cells),
    setSessionValues: (nb, values) => f.setSessionValues(nb, values),
    setSecret: (name) => f.setSecretCommand(name),
    alertParams: (nb) => f.alertParams(nb),
    storedSecret: (name) => f.storedSecret(name),
  };
}

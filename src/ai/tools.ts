/**
 * Tools for VS Code's agent mode (Language Model Tools API, stable since VS Code 1.95; agent mode
 * uses them from 1.99): md-runbook_runState reads where a run is, md-runbook_proposeStep adds a
 * proposed step. Nothing here runs anything: a proposal lands as a proposed cell, the same as
 * from Suggest Next Steps (commands.ts insertProposals), and the approval gate (approval.ts)
 * skips it until a person approves it on the cell.
 *
 * Both tools follow md-runbook's assistant settings: with mdRunbook.ai.provider "off" nothing
 * from a runbook goes to a model, so they refuse; with mdRunbook.approval.enabled off a proposal
 * would run unapproved, so proposeStep refuses.
 *
 * engines.vscode is ^1.93 and @types/vscode 1.85 has no tools API: the few members used are
 * declared here, and the tools are registered only where vscode.lm.registerTool exists.
 */

import * as vscode from 'vscode';
import { DEFAULT_PATTERNS, createRedactor, isCodeMeta } from '@md-runbook/core';
import { proposalOf } from '@md-runbook/core/proposal';
import { SECTION, redactionConfig } from '../config';
import { currentRunbook } from '../currentRunbook';
import { knownSecrets } from '../knownSecrets';
import { META_KEY, outputMeta } from '../outputs';
import { labelOf, notebookProgress } from '../progress';
import { isTestMode } from '../secrets';
import { NOTEBOOK_TYPE } from '../serializer';
import { PreflightSources, StepsRow, stepsModel } from '../stepsView';
import { waitingIn } from '../waiting';
import { aiSettings } from '../aiContextGlue';
import { insertProposals } from './commands';
import { providerSetting } from './providers';
import {
  MAX_FAILURES_SHOWN,
  ProposeStepInput,
  RunStateChapter,
  RunStateFailure,
  RunStateStep,
  RunStateView,
  checkProposeInput,
  failureTail,
  formatRunState,
  pickRunbook,
  proposalTarget,
  proposeConfirmation,
  redactForModel,
} from './toolText';

export const RUN_STATE_TOOL = 'md-runbook_runState';
export const PROPOSE_STEP_TOOL = 'md-runbook_proposeStep';

// --- The tools API, declared locally (VS Code 1.95 vscode.d.ts) ---------------------------------

interface PreparedToolInvocation {
  invocationMessage?: string;
  /** Present = VS Code asks before invoke, with Continue / Cancel. */
  confirmationMessages?: { title: string; message: string | vscode.MarkdownString };
}
interface LmTool<T> {
  invoke(options: { input: T; toolInvocationToken?: unknown }, token: vscode.CancellationToken): vscode.ProviderResult<unknown>;
  prepareInvocation?(options: { input: T }, token: vscode.CancellationToken): vscode.ProviderResult<PreparedToolInvocation>;
}
interface LmToolsApi {
  lm?: { registerTool?<T>(name: string, tool: LmTool<T>): vscode.Disposable };
  LanguageModelToolResult?: new (content: unknown[]) => unknown;
  LanguageModelTextPart?: new (value: string) => unknown;
}
const api = vscode as unknown as LmToolsApi;

// --- Shared --------------------------------------------------------------------------------------

const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(SECTION);

/** An error whose message is for the model (the API passes it on): what went wrong, what to do. */
class ToolError extends Error {}

function assistantOn(): void {
  if (providerSetting() === 'off') {
    throw new ToolError(
      'md-runbook\'s assistant is off (mdRunbook.ai.provider is "off"), and then nothing from a runbook is shared with a model. ' +
        'Ask the user to run "md-runbook: Turn On the Assistant" (or set mdRunbook.ai.provider), then try again.',
    );
  }
}

/**
 * Redaction for what goes to the model. With redaction turned off for saved files, the default
 * patterns still apply here: the setting is about the user's own files, not about sharing.
 */
function redactor(): (s: string) => string {
  const r = redactionConfig();
  const patterns = r.enabled ? r.redactor : createRedactor(DEFAULT_PATTERNS);
  return redactForModel((s) => knownSecrets.redact(s), (s) => patterns.redact(s), aiSettings().internalDomains);
}

const openRunbooks = (): vscode.NotebookDocument[] => vscode.workspace.notebookDocuments.filter((d) => d.notebookType === NOTEBOOK_TYPE && !d.isClosed);
const fileName = (nb: vscode.NotebookDocument): string => nb.uri.path.split('/').pop() ?? 'runbook';
const shownPath = (nb: vscode.NotebookDocument): string => vscode.workspace.asRelativePath(nb.uri, false);

/** The runbook `query` names (an open one), else the current one (currentRunbook.ts). */
function findRunbook(query: string | undefined): vscode.NotebookDocument {
  const open = openRunbooks();
  if (query) {
    const r = pickRunbook(query, open.map((nb) => ({ path: nb.uri.scheme === 'file' ? nb.uri.fsPath : nb.uri.toString(), relative: shownPath(nb) })));
    if (!r.ok) throw new ToolError(r.error);
    return open[r.value]!;
  }
  const nb = currentRunbook();
  if (nb) return nb;
  throw new ToolError(
    open.length
      ? `No runbook is in front. Name one with the runbook input: ${open.map(shownPath).join(', ')}.`
      : 'No runbook is open in VS Code. Ask the user to open one as a runbook (md-runbook: Open as Runbook), or name an open one with the runbook input.',
  );
}

type StepRow = Extract<StepsRow, { kind: 'step' }>;

// --- md-runbook_runState -------------------------------------------------------------------------

const STDOUT = 'application/vnd.code.notebook.stdout';
const STDERR = 'application/vnd.code.notebook.stderr';
const decoder = new TextDecoder();

/** What a step printed, as on screen now (live or loaded from the file); not the status lines or earlier runs. */
function outputText(cell: vscode.NotebookCell): string {
  let saved: string | undefined;
  const parts: string[] = [];
  for (const o of cell.outputs) {
    const m = outputMeta(o);
    // The finished run's plain text (no colours), when its status output carries it.
    if (m?.status) {
      if (m.text !== undefined) saved = m.text;
      continue;
    }
    if (m?.running || m?.earlier || m?.cloud) continue;
    for (const item of o.items) if (item.mime === STDOUT || item.mime === STDERR || item.mime === 'text/plain') parts.push(decoder.decode(item.data));
  }
  return saved ?? parts.join('');
}

/** The run state of `nb`, as the Steps view and the status bar see it, redacted. */
export function runStateView(nb: vscode.NotebookDocument, sources: PreflightSources | undefined): RunStateView {
  const redact = redactor();
  const m = stepsModel(nb, undefined, Date.now(), sources);
  const rows: (RunStateStep | RunStateChapter)[] = m.rows.map((r) =>
    r.kind === 'chapter'
      ? { kind: 'chapter', title: redact(r.title), level: r.level }
      : {
          kind: 'step',
          index: r.index,
          ...(r.step !== undefined ? { step: r.step } : {}),
          label: redact(r.label),
          state: r.state,
          ...(r.time !== undefined ? { time: r.time } : {}),
          // Names only (a secret's or a parameter's), never their values.
          ...(r.needs?.length ? { needs: r.needs } : {}),
        },
  );
  const steps = m.rows.filter((r): r is StepRow => r.kind === 'step');
  const failures: RunStateFailure[] = steps
    .filter((r) => r.state === 'failed')
    .slice(0, MAX_FAILURES_SHOWN)
    .map((r) => {
      const cell = nb.cellAt(r.index);
      const tail = failureTail(outputText(cell), redact);
      const meta: unknown = cell.metadata?.[META_KEY];
      // The fence's language as written (bash, pwsh), not VS Code's id for it (shellscript).
      const fenceLang = isCodeMeta(meta) ? meta.info.trim().split(/\s+/)[0] : undefined;
      return {
        ...(r.step !== undefined ? { step: r.step } : {}),
        index: r.index,
        label: redact(r.label),
        language: fenceLang || cell.document.languageId,
        code: redact(cell.document.getText()),
        tail: tail.lines,
        omitted: tail.omitted,
      };
    });
  const w = waitingIn(nb);
  const waitingRow = w ? steps.find((r) => r.index === w.cell.index) : undefined;
  const proposals = nb.getCells().filter((c) => {
    const meta: unknown = c.metadata?.[META_KEY];
    return c.kind === vscode.NotebookCellKind.Code && isCodeMeta(meta) && proposalOf(meta.info).state === 'proposed';
  }).length;
  return {
    name: fileName(nb),
    path: shownPath(nb),
    headline: redact(m.headline),
    state: m.state,
    ...(m.share ? { share: m.share } : {}),
    ...(m.left ? { left: m.left } : {}),
    ...(w
      ? { waiting: { what: w.what, label: redact(waitingRow?.label ?? labelOf(w.cell)), ...(waitingRow?.step !== undefined ? { step: waitingRow.step } : {}), where: w.where } }
      : {}),
    ...(m.preflight ? { preflight: m.preflight } : {}),
    rows,
    failures,
    proposals,
    others: openRunbooks()
      .filter((d) => d !== nb)
      .map(shownPath),
  };
}

interface RunStateInput {
  runbook?: string;
}

function runState(raw: unknown): string {
  assistantOn();
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as RunStateInput;
  const nb = findRunbook(typeof input.runbook === 'string' && input.runbook.trim() ? input.runbook.trim() : undefined);
  return formatRunState(runStateView(nb, sources));
}

// --- md-runbook_proposeStep ----------------------------------------------------------------------

function proposalsAllowed(): void {
  assistantOn();
  if (!cfg().get<boolean>('approval.enabled', true)) {
    throw new ToolError(
      'md-runbook adds no proposed steps here: mdRunbook.approval.enabled is off, so a proposed step would run without approval. ' +
        'Show the command to the user in the chat instead; they can add it to the runbook themselves.',
    );
  }
}

/** Where the step would go, without changing anything (prepareInvocation must be free of side effects). */
function plan(raw: unknown): { nb: vscode.NotebookDocument; input: ProposeStepInput; at: number; after?: number } {
  const checked = checkProposeInput(raw);
  if (!checked.ok) throw new ToolError(checked.error);
  const input = checked.value;
  const nb = findRunbook(input.runbook);
  const steps = stepsModel(nb).rows.filter((r): r is StepRow => r.kind === 'step');
  const t = proposalTarget(steps, nb.cellCount, input.afterStep);
  if (!t.ok) throw new ToolError(t.error);
  return { nb, input, at: t.value.at, ...(t.value.after !== undefined ? { after: t.value.after } : {}) };
}

/** The confirmation VS Code shows before invoke: where it goes, why, and the code. */
function proposeQuestion(raw: unknown): { title: string; message: vscode.MarkdownString } | undefined {
  try {
    proposalsAllowed();
    const p = plan(raw);
    const q = proposeConfirmation(fileName(p.nb), p.input, p.after !== undefined ? `step ${p.after}` : undefined);
    const message = new vscode.MarkdownString(`${q.message}\n\n`);
    message.appendCodeblock(p.input.code, p.input.language);
    return { title: q.title, message };
  } catch {
    // invoke refuses with the reason; there is nothing to confirm.
    return undefined;
  }
}

async function proposeStep(raw: unknown): Promise<string> {
  proposalsAllowed();
  const p = plan(raw);
  const v = p.input;
  const n = await insertProposals(p.nb, p.at, [{ lang: v.language, code: v.code, reason: v.reason, ...(v.name ? { name: v.name } : {}) }]);
  if (n === 0) throw new ToolError('VS Code did not accept the edit (is the runbook read-only?); nothing was added.');
  const step = notebookProgress(p.nb).stepOfCell[p.at];
  const where = p.after !== undefined ? `after step ${p.after}` : 'at the end';
  return [
    `Added a proposed step to ${fileName(p.nb)} ${where}${step !== undefined ? `; it is now step ${step}` : ''} (cell ${p.at + 1}).`,
    "It awaits the user's approval: md-runbook does not run it until they click Approve on the cell, and Run All skips it until then. Nothing was run.",
    // So the model doesn't promise a run with the user's own credentials (approval.ts credentials).
    ...(cfg().get<boolean>('approval.readOnlyOnly', true) ? ['Once approved, it runs only with the read-only credentials in mdRunbook.approval.readOnlyEnv, and not at all until those are set.'] : []),
  ].join(' ');
}

// --- Registration --------------------------------------------------------------------------------

let sources: PreflightSources | undefined;

function textResult(text: string): unknown {
  return new api.LanguageModelToolResult!([new api.LanguageModelTextPart!(text)]);
}

/** Runs a tool's work; a ToolError becomes the thrown message the model reads. */
async function run(name: string, input: unknown): Promise<string> {
  if (name === RUN_STATE_TOOL) return runState(input);
  if (name === PROPOSE_STEP_TOOL) return proposeStep(input);
  throw new ToolError(`Unknown tool ${name}.`);
}

const runbookName = (raw: unknown): string => {
  try {
    const q = (raw as RunStateInput | undefined)?.runbook;
    return fileName(findRunbook(typeof q === 'string' && q.trim() ? q.trim() : undefined));
  } catch {
    return 'the runbook';
  }
};

export function registerLmTools(context: vscode.ExtensionContext, preflight?: PreflightSources): void {
  sources = preflight;
  const lm = api.lm;
  if (typeof lm?.registerTool === 'function' && api.LanguageModelToolResult && api.LanguageModelTextPart) {
    context.subscriptions.push(
      lm.registerTool!<unknown>(RUN_STATE_TOOL, {
        // Read-only: no confirmation of its own (VS Code may still ask, as for any extension tool).
        prepareInvocation: ({ input }) => ({ invocationMessage: `Reading the run state of ${runbookName(input)}` }),
        invoke: async ({ input }) => textResult(await run(RUN_STATE_TOOL, input)),
      }),
      lm.registerTool!<unknown>(PROPOSE_STEP_TOOL, {
        prepareInvocation: ({ input }) => {
          const q = proposeQuestion(input);
          return { invocationMessage: `Adding a proposed step to ${runbookName(input)}`, ...(q ? { confirmationMessages: q } : {}) };
        },
        invoke: async ({ input }) => textResult(await run(PROPOSE_STEP_TOOL, input)),
      }),
    );
  }
  // For integration tests (any VS Code version): a tool's invoke and its confirmation, without a chat.
  if (isTestMode(context)) {
    context.subscriptions.push(
      vscode.commands.registerCommand('mdRunbook._lmTool', async (name: string, input: unknown) => {
        try {
          return { text: await run(name, input) };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      }),
      vscode.commands.registerCommand('mdRunbook._lmToolConfirmation', (input: unknown) => {
        const q = proposeQuestion(input);
        return q ? { title: q.title, message: q.message.value } : undefined;
      }),
    );
  }
}

/**
 * Run reports in VS Code (core/runReport.ts, docs/features/run-reports.md): at the end of every run
 * (one cell, a range, Run All) of a runbook whose front matter names `report-runs:`, a summary of
 * it goes to that address: which runbook, who, when, and how each step ended, never an output or a
 * value. Asked once per address (Allow / Not now / Never) unless `mdRunbook.reports.allowedAddresses`
 * names it. A runbook signed as a whole by a signer in `mdRunbook.signing.allowedSigners` can
 * require it (a notice before the run: Run / Don't run) and require it signed with your key
 * (`mdRunbook.signing.key`). Sending never holds up a run: a summary that can't be sent waits in
 * global state and is tried again later.
 */

import * as os from 'node:os';
import * as vscode from 'vscode';
import { isCodeMeta, stepState, taskItems } from '@md-runbook/core';
import { isManualMark } from '@md-runbook/core/progress';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import {
  PostOutcome,
  QueuedReport,
  ReportPlan,
  RunStepState,
  afterTry,
  addressAllowed,
  buildRunSummary,
  consentKey,
  enqueueReport,
  postRunReport,
  pruneReports,
  reportBody,
  reportConsentText,
  reportPlan,
  reportRequiredText,
} from '@md-runbook/core/runReport';
import { sha256Hex } from '@md-runbook/core/sha256';
import { signRunSummary, trustedRunbookSigner } from '@md-runbook/core/node';
import { isCallCopy } from './calls';
import { SECTION } from './config';
import { META_KEY } from './outputs';
import type { RunPipeline, RunRecord } from './pipeline';
import { cellAttrs, labelOf, notebookProgress } from './progress';
import type { SecretsInfo } from './secrets';
import { NOTEBOOK_TYPE, notebookTextWithOutputs } from './serializer';
import { SIGNING_KEY_MISSING, SIGNING_KEY_MISSING_CANCEL, reportGate, summarySigning } from './reportGate';

const CONSENT_KEY = 'mdRunbook.reports.consent';
const QUEUE_KEY = 'mdRunbook.reports.queue';
type Answer = 'allow' | 'never';

const home = (p: string): string => p.replace(/^~(?=$|[\\/])/, os.homedir());

function userName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

/** What a run of the notebook's cells looked like at the end: each step's state, as the progress counts it. */
function steps(nb: vscode.NotebookDocument, runs: readonly RunRecord[]): { label: string; state: RunStepState; ms?: number; ran?: boolean }[] {
  const p = notebookProgress(nb);
  const out: { label: string; state: RunStepState; ms?: number; ran?: boolean }[] = [];
  for (const cell of nb.getCells()) {
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      const text = cell.document.getText();
      const lines = text.split('\n');
      for (const item of taskItems(text)) {
        const label = (lines[item.line] ?? '').replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]*/, '');
        out.push({ label, state: item.checked ? 'by-hand' : 'not-run' });
      }
      continue;
    }
    if (p.stepOfCell[cell.index] === undefined) continue;
    const meta: unknown = cell.metadata?.[META_KEY];
    const attrs = cellAttrs(cell);
    const run = runs.find((r) => r.cell === cell);
    const elsewhere = isCodeMeta(meta) && parseCellOptions(meta.info).host !== undefined;
    const s = elsewhere ? 'skipped' : stepState(attrs?.exit, attrs?.lines !== undefined, attrs?.check);
    const state: RunStepState = isManualMark(attrs) && s === 'done' ? 'by-hand' : s === 'done' ? 'passed' : s === 'pending' ? 'not-run' : s;
    out.push({ label: labelOf(cell), state, ...(run && !run.plan.skip ? { ms: run.result.durationMs, ran: true } : {}) });
  }
  return out;
}

class RunReports {
  /** Runbooks whose required report was agreed to this session (Run), by uri and address. */
  private readonly agreed = new Set<string>();
  /** The trusted signer of a text (by its hash): ssh-keygen runs once per version of a runbook. */
  private readonly trust = new Map<string, string | undefined>();
  private readonly started = new Map<string, number>();
  private sending = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: Pick<SecretsInfo, 'alertParams' | 'storedSecret'>,
  ) {}

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
  }

  /** The signer of `mdRunbook.signing.allowedSigners` whose key signed this text, or undefined. */
  private async trustedSigner(text: string): Promise<string | undefined> {
    const file = this.config().get<string>('signing.allowedSigners', '').trim();
    if (!file || !/md-runbook:signature v1/.test(text)) return undefined;
    const key = `${file}\n${sha256Hex(text)}`;
    if (!this.trust.has(key)) this.trust.set(key, await trustedRunbookSigner(text, home(file)).catch(() => undefined));
    return this.trust.get(key);
  }

  private async planOf(nb: vscode.NotebookDocument): Promise<{ plan: ReportPlan; text: string; signer?: string } | undefined> {
    if (nb.notebookType !== NOTEBOOK_TYPE || isCallCopy(nb.uri)) return undefined;
    // The front matter is in the first cell: most runbooks stop here, without writing the text.
    const first = nb.cellCount > 0 ? nb.cellAt(0) : undefined;
    if (first?.kind !== vscode.NotebookCellKind.Markup || !/^report-runs\s*:/m.test(first.document.getText())) return undefined;
    const text = notebookTextWithOutputs(nb);
    const signer = await this.trustedSigner(text);
    const plan = reportPlan(text, signer);
    return plan ? { plan, text, ...(signer ? { signer } : {}) } : undefined;
  }

  private keySet(): boolean {
    return this.config().get<string>('signing.key', '').trim() !== '';
  }

  /** Before a run: a required signature has a key, a required report is agreed to; else the run doesn't start. */
  async willRun(nb: vscode.NotebookDocument): Promise<void | { cancel: string }> {
    this.started.set(nb.uri.toString(), Date.now());
    const p = await this.planOf(nb);
    if (!p) return undefined;
    const key = `${nb.uri.toString()}\n${consentKey(p.plan)}`;
    const gate = reportGate(p.plan, { keySet: this.keySet(), agreed: this.agreed.has(key) });
    if (gate.kind === 'go') return undefined;
    if (gate.kind === 'refuse') {
      const open = 'Open Settings';
      void vscode.window
        .showErrorMessage(SIGNING_KEY_MISSING, open)
        .then((a) => a === open && vscode.commands.executeCommand('workbench.action.openSettings', 'mdRunbook.signing.key'));
      return { cancel: SIGNING_KEY_MISSING_CANCEL };
    }
    const run = 'Run';
    const answer = await vscode.window.showWarningMessage(`md-runbook: ${p.plan.host} gets a report of this run`, { modal: true, detail: reportRequiredText(p.plan) }, run, "Don't run");
    if (answer !== run) return { cancel: 'md-runbook: not run: this runbook runs only when its runs are reported' };
    this.agreed.add(key);
    return undefined;
  }

  /** After a run: the summary, sent when allowed (asked once per address). Never awaited by the run. */
  async didRun(nb: vscode.NotebookDocument, runs: readonly RunRecord[]): Promise<void> {
    const started = this.started.get(nb.uri.toString());
    this.started.delete(nb.uri.toString());
    if (runs.length === 0) return;
    const p = await this.planOf(nb);
    if (!p) return;
    const { plan } = p;
    const ran = runs.map((r) => Date.parse(r.attrs.ran ?? '')).filter((t) => Number.isFinite(t));
    const summary = buildRunSummary({
      file: nb.uri.path,
      text: p.text,
      who: userName(),
      client: 'vscode',
      started: ran.length > 0 ? Math.min(...ran) : (started ?? Date.now()),
      ended: Date.now(),
      steps: steps(nb, runs),
      stopped: runs.some((r) => r.result.cancelled || r.result.timedOut),
      ...(p.signer ? { trustedSigner: p.signer } : {}),
      alertParams: this.secrets.alertParams(nb),
    });
    if (!(await this.allowed(plan, nb))) return;
    // Signed when a key is set; a runbook that requires it signed sends nothing unsigned.
    const keyFile = this.config().get<string>('signing.key', '').trim();
    const signing = summarySigning(plan, keyFile !== '');
    if (signing === 'refuse') {
      // The key was removed after the run started.
      void vscode.window.showWarningMessage(`md-runbook: the run report to ${plan.host} was not sent: it must be signed, and mdRunbook.signing.key is not set`);
      return;
    }
    let body: string;
    if (signing === 'sign') {
      try {
        body = reportBody(summary, { signature: await signRunSummary(summary, home(keyFile), { interactive: false }) });
      } catch (e) {
        if (plan.signed) {
          void vscode.window.showWarningMessage(`md-runbook: the run report to ${plan.host} was not sent: it must be signed, and signing failed: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        body = reportBody(summary);
      }
    } else body = reportBody(summary);
    const item = { url: plan.url, body, ...(plan.token ? { token: plan.token } : {}) };
    const outcome = await this.post(item);
    if (!outcome.ok && outcome.retry) await this.queue(enqueueReport(this.queued(), item));
    if (!outcome.ok) this.notSent(item.url, outcome);
    // And what waited from before.
    await this.flush();
  }

  /** POST one report, its token read from the secret store now (never kept). */
  private async post(item: Pick<QueuedReport, 'url' | 'body' | 'token'>): Promise<PostOutcome> {
    const token = item.token ? await this.secrets.storedSecret(item.token) : undefined;
    if (item.token && token === undefined) return { ok: false, retry: true, why: `the secret ${item.token} is not set (md-runbook: Set Secret)` };
    return postRunReport({ url: item.url, body: item.body, ...(token ? { token } : {}) });
  }

  private notSent(url: string, outcome: PostOutcome): void {
    if (outcome.ok) return;
    vscode.window.setStatusBarMessage(`md-runbook: run report to ${url.replace(/^https?:\/\/([^/]+).*$/, '$1')} not sent (${outcome.why})${outcome.retry ? ': tried again later' : ''}`, 8000);
  }

  /** Whether this summary may go: required and agreed, pre-approved, or answered Allow (asked once). */
  private async allowed(plan: ReportPlan, nb: vscode.NotebookDocument): Promise<boolean> {
    if (plan.required) return this.agreed.has(`${nb.uri.toString()}\n${consentKey(plan)}`);
    if (addressAllowed(plan.url, this.config().get<string[]>('reports.allowedAddresses', []))) return true;
    const answers = this.context.globalState.get<Record<string, Answer>>(CONSENT_KEY, {});
    const known = answers[consentKey(plan)];
    if (known) return known === 'allow';
    // Not modal: the run is over, the reader may be elsewhere.
    const answer = await vscode.window.showInformationMessage(`md-runbook: ${reportConsentText(plan)}`, 'Allow', 'Not now', 'Never');
    if (answer === 'Allow' || answer === 'Never') {
      await this.context.globalState.update(CONSENT_KEY, { ...this.context.globalState.get<Record<string, Answer>>(CONSENT_KEY, {}), [consentKey(plan)]: answer === 'Allow' ? 'allow' : 'never' });
    }
    return answer === 'Allow';
  }

  private queued(): QueuedReport[] {
    return this.context.globalState.get<QueuedReport[]>(QUEUE_KEY, []);
  }

  private queue(q: QueuedReport[]): Thenable<void> {
    return this.context.globalState.update(QUEUE_KEY, q);
  }

  /** Send what is due; what fails waits for a later try (core retryDelay). */
  async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const now = Date.now();
      for (const item of pruneReports(this.queued(), now).filter((q) => q.next <= now)) {
        const outcome = await this.post(item);
        // The queue may have changed while this one was sent.
        await this.queue(afterTry(this.queued(), item, outcome, Date.now()));
        this.notSent(item.url, outcome);
      }
    } finally {
      this.sending = false;
    }
  }
}

export function registerRunReports(context: vscode.ExtensionContext, pipeline: RunPipeline, secrets: Pick<SecretsInfo, 'alertParams' | 'storedSecret'>): void {
  const reports = new RunReports(context, secrets);
  pipeline.observers.push({
    onWillRunSequence: (nb) => reports.willRun(nb),
    // Not awaited: the report never holds up the run (or the next one).
    onDidRunSequence: (nb, runs) => void reports.didRun(nb, runs).catch(() => undefined),
  });
  // Reports that waited: now, and every few minutes.
  void reports.flush();
  const timer = setInterval(() => void reports.flush(), 5 * 60_000);
  timer.unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

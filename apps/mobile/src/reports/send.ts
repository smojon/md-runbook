/**
 * Run reports (`report-runs:` in a runbook's front matter, core runReport.ts), as the extension
 * and the command line send them: what the runbook asks for and what this app honours, the
 * answers to "may this runbook report its runs to …?", and sending at the end of a run, signed
 * with the app's key when it can be, queued and tried again when the server can't be reached.
 *
 * Trust: `report-runs-required` and `-signed` count only when the runbook is verified against
 * the keys it is checked against everywhere in the app (Hosts & settings → Trusted signers: for a
 * team library copy, the keys trusted from its library; for every runbook, the keys added by
 * you), and the signature covers the whole runbook, its front matter included (signing/trust.ts
 * reportSigner, the same signatureState and coverage() as the library's states and the banner).
 * Otherwise the run is reported only once you allow it.
 */
import { useSyncExternalStore } from 'react';
import {
  PostOutcome,
  QueuedReport,
  RUN_SIGNATURE_NAMESPACE,
  ReportPlan,
  RunSummaryReport,
  addressAllowed,
  afterTry,
  canonicalJson,
  consentKey,
  enqueueReport,
  postRunReport,
  pruneReports,
  reportBody,
  reportPlan,
} from '@md-runbook/core/runReport';
import { armorSignature } from '@md-runbook/core/signing';
import { signSshsig } from '@md-runbook/ssh';
import { readSecret } from '../secrets/store';
import { getRunbook } from '../runbooks/store';
import { runbookKeys } from '../runbooks/library';
import { loadSettings, outputSettings, reportAddresses, signerName } from '../settings/store';
import { keysId, loadTrustedSigners, reportSigner } from '../signing/trust';
import { appKeyInfo } from '../ssh/appKey';
import { getJson, setJson } from '../storage/kv';

const CONSENT_KEY = 'reports.consent.v1';
const QUEUE_KEY = 'reports.queue.v1';

export type Consent = 'allow' | 'never';

// ---- what the runbook asks for ----

export interface RunbookReport {
  plan: ReportPlan;
  /** The trusted signer whose signature of the runbook is good, if any. */
  signer?: string;
}

/** One entry: a runbook's text changes with every output written, the check is redone then. */
let lastPlan: { text: string; keys: string; result: Promise<RunbookReport | undefined> } | undefined;

/**
 * Where and how the runbook's runs are reported; undefined when it names no address. `runbookId`:
 * the runbook it is, whose library (if it is a library copy) decides which keys count.
 */
export async function planOf(text: string, runbookId?: string): Promise<RunbookReport | undefined> {
  if (!/^report-runs\s*:/im.test(text)) return undefined;
  await Promise.all([loadSettings(), loadTrustedSigners()]);
  const keys = runbookKeys(runbookId !== undefined ? getRunbook(runbookId) : undefined);
  const id = keysId(keys);
  if (lastPlan?.text === text && lastPlan.keys === id) return lastPlan.result;
  const result = (async () => {
    const signer = await reportSigner(text, keys).catch(() => undefined);
    const plan = reportPlan(text, signer);
    return plan ? { plan, ...(signer !== undefined ? { signer } : {}) } : undefined;
  })();
  lastPlan = { text, keys: id, result };
  return result;
}

// ---- consent ----

const isConsents = (v: unknown): v is Record<string, Consent> =>
  typeof v === 'object' && v !== null && Object.values(v).every((x) => x === 'allow' || x === 'never');

let consents: Readonly<Record<string, Consent>> = {};
let consentsLoaded: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function loadConsents(): Promise<void> {
  return (consentsLoaded ??= getJson(CONSENT_KEY, isConsents).then((saved) => {
    consents = { ...(saved ?? {}), ...consents };
    emit();
  }));
}

function saveConsents(next: Record<string, Consent>): void {
  consents = next;
  emit();
  void setJson(CONSENT_KEY, consents).catch(() => undefined);
}

/** Remember Allow or Never for this address (and the secret sent with it). */
export async function rememberConsent(plan: ReportPlan, answer: Consent): Promise<void> {
  await loadConsents();
  saveConsents({ ...consents, [consentKey(plan)]: answer });
}

/** Forget one remembered answer (Hosts & settings), or all of them. */
export async function forgetConsent(key?: string): Promise<void> {
  await loadConsents();
  if (key === undefined) return saveConsents({});
  const next = { ...consents };
  delete next[key];
  saveConsents(next);
}

export function useConsents(): Readonly<Record<string, Consent>> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => consents,
  );
}

/** At the end of a run that isn't required to be reported: send, don't, or ask. */
export async function consentFor(plan: ReportPlan): Promise<'allow' | 'never' | 'ask'> {
  await Promise.all([loadSettings(), loadConsents()]);
  if (addressAllowed(plan.url, reportAddresses())) return 'allow';
  return consents[consentKey(plan)] ?? 'ask';
}

/**
 * Runbooks whose required reporting was agreed to (Run on the notice) in this app session, by
 * runbook and address: their steps don't ask again. A restart asks again.
 */
const agreed = new Set<string>();
const agreedKey = (runbookId: string, plan: ReportPlan): string => `${runbookId}|${consentKey(plan)}`;

export function agreeRequired(runbookId: string, plan: ReportPlan): void {
  agreed.add(agreedKey(runbookId, plan));
}

export type Gate = { kind: 'go' } | { kind: 'ask'; plan: ReportPlan } | { kind: 'refuse'; why: 'key' };

/**
 * Before a run: whether it may start. A signed runbook that requires reporting waits for Run on
 * its notice (once per runbook and address in this session); one that requires signed reports
 * doesn't start without the app's key.
 */
export async function reportGate(runbookId: string, text: string): Promise<Gate> {
  const r = await planOf(text, runbookId);
  if (!r || (!r.plan.required && !r.plan.signed)) return { kind: 'go' };
  if (r.plan.signed) {
    try {
      await appKeyInfo();
    } catch {
      return { kind: 'refuse', why: 'key' };
    }
  }
  if (r.plan.required && !agreed.has(agreedKey(runbookId, r.plan))) return { kind: 'ask', plan: r.plan };
  return { kind: 'go' };
}

// ---- sending ----

/** The body to send: signed with the app's key when it can sign without asking you, or when the runbook requires it. */
async function bodyOf(summary: RunSummaryReport, plan: ReportPlan): Promise<string | undefined> {
  // A key that asks for Face ID or a passkey at every use would ask at every run's end: unsigned then, unless required.
  if (!plan.signed && outputSettings().keyNeedsUser) return reportBody(summary);
  try {
    const { pair } = await appKeyInfo();
    const blob = await signSshsig(pair, canonicalJson(summary), RUN_SIGNATURE_NAMESPACE);
    const name = signerName();
    return reportBody(summary, { signature: armorSignature(blob), ...(name ? { signer: name } : {}) });
  } catch {
    // Required to be signed: nothing unsigned goes out.
    return plan.signed ? undefined : reportBody(summary);
  }
}

const isQueue = (v: unknown): v is QueuedReport[] =>
  Array.isArray(v) &&
  v.every(
    (q: Partial<QueuedReport>) =>
      typeof q === 'object' && q !== null && typeof q.url === 'string' && typeof q.body === 'string' && typeof q.next === 'number',
  );

/** The reports waiting to be sent again (oldest first). */
export async function queuedReports(): Promise<QueuedReport[]> {
  return (await getJson(QUEUE_KEY, isQueue)) ?? [];
}

/** One change of the queue at a time (a run's end and a retry may overlap). */
let queueLock: Promise<unknown> = Promise.resolve();
function changeQueue(f: (q: QueuedReport[]) => QueuedReport[] | Promise<QueuedReport[]>): Promise<void> {
  const next = queueLock.then(async () => setJson(QUEUE_KEY, await f(await queuedReports())));
  queueLock = next.catch(() => undefined);
  return next;
}

/** One try; the token's value read from the secret store each time (the queue keeps only its name). */
async function tryOnce(url: string, body: string, token: string | undefined): Promise<PostOutcome> {
  const value = token ? await readSecret(token) : undefined;
  if (token && value === undefined) return { ok: false, retry: true, why: `no secret ${token} stored yet` };
  return postRunReport({ url, body, ...(value !== undefined ? { token: value } : {}) });
}

/**
 * Send a run's summary (never waited for by the run): on failure it is queued and tried again
 * after later runs and at the next start. What happened, for tests and the caller's notice.
 */
export async function sendReport(plan: ReportPlan, summary: RunSummaryReport): Promise<'sent' | 'queued' | 'refused' | 'unsigned'> {
  const body = await bodyOf(summary, plan);
  if (body === undefined) return 'unsigned';
  const outcome = await tryOnce(plan.url, body, plan.token);
  if (outcome.ok) return 'sent';
  if (!outcome.retry) return 'refused';
  await changeQueue((q) => enqueueReport(q, { url: plan.url, body, ...(plan.token ? { token: plan.token } : {}) }));
  return 'queued';
}

let retrying: Promise<void> | undefined;

/** Try the queued reports that are due (at the app's start and after each run). */
export function retryReports(now = Date.now()): Promise<void> {
  return (retrying ??= (async () => {
    try {
      for (const item of (await queuedReports()).filter((q) => q.next <= now)) {
        const outcome = await tryOnce(item.url, item.body, item.token);
        await changeQueue((q) => afterTry(q, q.find((x) => x.url === item.url && x.body === item.body) ?? item, outcome, now));
      }
      await changeQueue((q) => pruneReports(q, now));
    } catch {
      // Storage or the network: the next run tries again.
    } finally {
      retrying = undefined;
    }
  })());
}

/** Tests. */
export function resetReports(): void {
  consents = {};
  consentsLoaded = undefined;
  agreed.clear();
  lastPlan = undefined;
  retrying = undefined;
  queueLock = Promise.resolve();
  emit();
}

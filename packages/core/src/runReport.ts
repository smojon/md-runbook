/**
 * Run reports: at the end of a run, every client (VS Code, the app, the command line) sends a
 * short summary of it to the address the runbook names (`report-runs:` in the front matter). The
 * summary says which runbook ran, who ran it where and when, and how each step ended: never an
 * output, a parameter or input value, or a secret. It can be signed with the runner's own SSH key
 * (namespace `md-runbook-run`, never a runbook's `md-runbook`), so a server can reject fakes.
 * See docs/features/run-reports.md.
 *
 * Platform-neutral: the app runs it. Signing and checking with ssh-keygen are in node/runReport.ts.
 */

import { clearOutputBlocks } from './writer';
import { SIGNATURE_NAMESPACE, allSignatures, parseManifest, readSignature, signedStatus } from './signing';
import { SubtleLike, verifySshsig } from './sshsigVerify';
import { parseFrontMatter, reportAddressProblem } from './secrets';
import { sha256Hex } from './sha256';
import { runbookTitle } from './title';

/** The summary format's version (`v`). A server should refuse a version it doesn't know. */
export const RUN_SUMMARY_VERSION = 1;

/** The `-n` namespace of a run summary's signature: a runbook signature (`md-runbook`) never verifies as one, nor the reverse. */
export const RUN_SIGNATURE_NAMESPACE = 'md-runbook-run';

/**
 * Where a run was reported from. `gate`: md-runbook-gate's own record of a session on a server
 * (GateRunSummary): it never sees the runbook's text, only its signed manifest.
 */
export const RUN_CLIENTS = ['vscode', 'app-ios', 'app-android', 'app-web', 'cli', 'gate'] as const;
export type RunClient = (typeof RUN_CLIENTS)[number];

/**
 * How a step stands after the run: `passed` (ran, or marked done, and passed), `failed`,
 * `skipped` (an option or a choice skipped it), `not-run` (still to do), `by-hand` (a checklist
 * item ticked, or a step marked done by hand).
 */
export const RUN_STEP_STATES = ['passed', 'failed', 'skipped', 'not-run', 'by-hand'] as const;
export type RunStepState = (typeof RUN_STEP_STATES)[number];

/** A step's label is cut to this many characters. */
export const RUN_LABEL_MAX = 120;

export interface RunSummaryStep {
  /** 1-based, in the runbook's order. */
  n: number;
  /** The step's heading or name=, else the first line of its code as written (never a value). */
  label: string;
  state: RunStepState;
  /** How long it ran in this run, in milliseconds; absent for a step this run didn't run. */
  ms?: number;
}

export interface RunSummaryRunbook {
  /** The file name, without its folder. */
  file: string;
  title?: string;
  /** SHA-256 (hex) of the runbook without its outputs (clearOutputBlocks): the same text gives the same hash. */
  sha256: string;
  /** When the runbook carries a signature block. */
  signed?: {
    name: string;
    version: number;
    /** SHA-256 (hex) of the manifest: what a gate logs and a `revoked` file lists. */
    manifest: string;
    /** The signer's name: the principal the client's trusted signers matched, else what the file says. */
    signer: string;
    /** Whether this client checked the signature against signers it trusts. */
    trusted: boolean;
  };
}

/**
 * Which alert a run answered: from the run's parameter values `ALERT` (the alert's name, as an
 * alert link passes it: `&p.ALERT={{ $labels.alertname }}`), `ALERT_FINGERPRINT`,
 * `ALERT_STARTS_AT` and `ALERT_LABELS` (`name=value,name=value`, only when the runbook or the
 * link passes it), whether or not a block uses them; empty ones are left out. No other
 * parameter's value is ever sent.
 */
export interface RunSummaryAlert {
  name: string;
  fingerprint?: string;
  /** When the alert started, as the link gave it (Alertmanager's startsAt, RFC 3339). */
  startsAt?: string;
  labels?: Record<string, string>;
}

/** The parameters a summary's `alert` is made of: no other parameter's value is read. */
export const ALERT_PARAMS = ['ALERT', 'ALERT_FINGERPRINT', 'ALERT_STARTS_AT', 'ALERT_LABELS'] as const;

/** Labels sent at most. */
export const ALERT_LABELS_MAX = 20;
const FINGERPRINT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const LABEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const STARTS_AT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * The alert of a run from its parameter values: only ALERT_PARAMS are read; undefined without
 * `ALERT`. A fingerprint, start time or label that isn't plain is left out, as are empty ones.
 */
export function alertFromParams(params: Readonly<Record<string, string | undefined>>): RunSummaryAlert | undefined {
  const name = summaryLabel(params.ALERT ?? '');
  if (name === '') return undefined;
  const fp = params.ALERT_FINGERPRINT?.trim();
  const labels: Record<string, string> = {};
  for (const pair of (params.ALERT_LABELS ?? '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = summaryLabel(pair.slice(eq + 1));
    if (LABEL_NAME_RE.test(k) && v !== '' && Object.keys(labels).length < ALERT_LABELS_MAX && !(k in labels)) labels[k] = v;
  }
  const startsAt = params.ALERT_STARTS_AT?.trim();
  return {
    name,
    ...(fp && FINGERPRINT_RE.test(fp) ? { fingerprint: fp } : {}),
    ...(startsAt && STARTS_AT_RE.test(startsAt) ? { startsAt } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
  };
}

/** A run's summary, as sent (format version 1). */
export interface RunSummaryReport {
  v: 1;
  runbook: RunSummaryRunbook;
  /** The user name on the machine, or the name set in the app. */
  who: string;
  client: RunClient;
  /** ISO 8601, UTC. */
  started: string;
  ended: string;
  steps: RunSummaryStep[];
  /** The step numbers this run ran (a single step, a range, or all of them). */
  ran: number[];
  totals: { steps: number; passed: number; failed: number; skipped: number; notRun: number; byHand: number };
  /** Every step passed, was skipped or was done by hand: nothing failed, nothing left. */
  green: boolean;
  /** Stopped (Stop, a timeout, or the reader) rather than run to its end. */
  stopped?: boolean;
  /** The alert the run answered (alertFromParams), when it got an `ALERT` parameter. */
  alert?: RunSummaryAlert;
}

/** Where a gate's summary comes from: the server, the account the key logs in to, the SSH client's address. */
export interface RunSummaryGate {
  host: string;
  account: string;
  from?: string;
}

/**
 * md-runbook-gate's summary of what a session ran of one signed runbook (client `gate`, the same
 * format version). The gate has only the signed manifest, so `runbook.file` and `runbook.sha256`
 * are absent and `runbook.signed` is always there (`trusted`: the gate checked it against its
 * allowed_signers). `who` is the key's fingerprint (or `--who=`); steps are the signed blocks, in
 * order, labelled by the first line of their code.
 */
export interface GateRunSummary extends Omit<RunSummaryReport, 'runbook' | 'client'> {
  client: 'gate';
  runbook: Omit<RunSummaryRunbook, 'file' | 'sha256' | 'signed'> & { file?: string; sha256?: string; signed: NonNullable<RunSummaryRunbook['signed']> };
  gate?: RunSummaryGate;
}

/** A summary as a server receives it: a client's, or a gate's. */
export type ReceivedRunSummary = RunSummaryReport | GateRunSummary;

export interface RunSummaryInput {
  /** The runbook's file name (a path is cut to its last part). */
  file: string;
  /** The runbook's text (outputs are ignored). */
  text: string;
  who: string;
  client: RunClient;
  started: number | Date;
  ended: number | Date;
  steps: readonly { label: string; state: RunStepState; ms?: number; ran?: boolean }[];
  stopped?: boolean;
  /** The signer this client's trusted signers matched, when it checked the signature. */
  trustedSigner?: string;
  /** The run's parameter values: only ALERT_PARAMS are read, the others are ignored. */
  alertParams?: Readonly<Record<string, string | undefined>>;
}

const iso = (t: number | Date): string => new Date(typeof t === 'number' ? t : t.getTime()).toISOString();

/** A label as sent: one line, at most RUN_LABEL_MAX characters. */
export function summaryLabel(label: string): string {
  const one = label.replace(/\s+/g, ' ').trim();
  return one.length > RUN_LABEL_MAX ? one.slice(0, RUN_LABEL_MAX - 1) + '…' : one;
}

/** The runbook part of a summary: name, title, hashes and signer, from the text. */
export function summaryRunbook(file: string, text: string, trustedSigner?: string): RunSummaryRunbook {
  const name = file.split(/[\\/]/).pop() || 'runbook.md';
  const title = runbookTitle(text);
  const block = readSignature(text);
  let signed: RunSummaryRunbook['signed'];
  if (block) {
    try {
      const m = parseManifest(block.manifest);
      signed = { name: m.name, version: m.version, manifest: sha256Hex(block.manifest), signer: trustedSigner ?? block.signer, trusted: trustedSigner !== undefined };
    } catch {
      signed = undefined;
    }
  }
  return { file: name, ...(title ? { title: summaryLabel(title) } : {}), sha256: sha256Hex(clearOutputBlocks(text.replace(/^﻿/, ''))), ...(signed ? { signed } : {}) };
}

/** The summary of a run. It takes only names, states and times: nothing a step printed or was given. */
export function buildRunSummary(i: RunSummaryInput): RunSummaryReport {
  const started = typeof i.started === 'number' ? i.started : i.started.getTime();
  const ended = Math.max(started, typeof i.ended === 'number' ? i.ended : i.ended.getTime());
  const steps: RunSummaryStep[] = i.steps.map((s, k) => ({
    n: k + 1,
    label: summaryLabel(s.label) || `Step ${k + 1}`,
    state: s.state,
    ...(s.ms !== undefined && Number.isFinite(s.ms) ? { ms: Math.max(0, Math.round(s.ms)) } : {}),
  }));
  const count = (state: RunStepState): number => steps.filter((s) => s.state === state).length;
  const alert = i.alertParams ? alertFromParams(i.alertParams) : undefined;
  const totals = { steps: steps.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), notRun: count('not-run'), byHand: count('by-hand') };
  return {
    v: RUN_SUMMARY_VERSION,
    runbook: summaryRunbook(i.file, i.text, i.trustedSigner),
    who: summaryLabel(i.who) || 'unknown',
    client: i.client,
    started: iso(started),
    ended: iso(ended),
    steps,
    ran: i.steps.flatMap((s, k) => (s.ran ? [k + 1] : [])),
    totals,
    green: steps.length > 0 && totals.failed === 0 && totals.notRun === 0,
    ...(i.stopped ? { stopped: true } : {}),
    ...(alert ? { alert } : {}),
  };
}

// ---- the canonical form (what is signed) ----

/**
 * The canonical JSON of a value: object keys sorted (by UTF-16 code units), no whitespace,
 * undefined members left out. For the strings, whole numbers and booleans of a summary this is the
 * same text as RFC 8785 (JCS). What a signature covers, and what is sent.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON: not a finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  throw new Error(`canonical JSON: can't write a ${typeof value}`);
}

// ---- checking a summary (a server, or a test) ----

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function onlyKeys(o: Record<string, unknown>, keys: readonly string[], where: string, out: string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) out.push(`${where}: unknown field "${k}"`);
}

/**
 * What is wrong with a summary as received: [] when it is a well-formed version 1 summary. Strict:
 * unknown fields are refused, so a summary can't carry anything else (outputs, values). A gate's
 * summary (client `gate`, GateRunSummary) may leave out the runbook's file and hash, must name
 * the signed runbook, and may carry `gate`; no other client's may.
 */
export function runSummaryProblems(x: unknown): string[] {
  const out: string[] = [];
  if (!isObj(x)) return ['not a JSON object'];
  if (x.v !== RUN_SUMMARY_VERSION) return [`v: ${JSON.stringify(x.v)} is not a summary version this reads (${RUN_SUMMARY_VERSION})`];
  const fromGate = x.client === 'gate';
  onlyKeys(x, ['v', 'runbook', 'who', 'client', 'started', 'ended', 'steps', 'ran', 'totals', 'green', 'stopped', 'alert', ...(fromGate ? ['gate'] : [])], 'summary', out);
  const str = (v: unknown, where: string, max = RUN_LABEL_MAX): void => {
    if (typeof v !== 'string' || v === '' || v.length > max || /[\r\n]/.test(v)) out.push(`${where}: expected one line of text (at most ${max})`);
  };
  const rb = x.runbook;
  if (!isObj(rb)) out.push('runbook: missing');
  else {
    onlyKeys(rb, ['file', 'title', 'sha256', 'signed'], 'runbook', out);
    if (!(fromGate && rb.file === undefined)) str(rb.file, 'runbook.file', 255);
    if (typeof rb.file === 'string' && /[\\/]/.test(rb.file)) out.push('runbook.file: a file name, without folders');
    if (rb.title !== undefined) str(rb.title, 'runbook.title');
    if (!(fromGate && rb.sha256 === undefined) && (typeof rb.sha256 !== 'string' || !HEX64.test(rb.sha256))) out.push('runbook.sha256: expected 64 hex digits');
    if (fromGate && rb.signed === undefined) out.push('runbook.signed: a gate runs signed runbooks only');
    if (rb.signed !== undefined) {
      const s = rb.signed;
      if (!isObj(s)) out.push('runbook.signed: expected an object');
      else {
        onlyKeys(s, ['name', 'version', 'manifest', 'signer', 'trusted'], 'runbook.signed', out);
        str(s.name, 'runbook.signed.name');
        if (!Number.isInteger(s.version) || (s.version as number) < 1) out.push('runbook.signed.version: expected a positive whole number');
        if (typeof s.manifest !== 'string' || !HEX64.test(s.manifest)) out.push('runbook.signed.manifest: expected 64 hex digits');
        str(s.signer, 'runbook.signed.signer');
        if (typeof s.trusted !== 'boolean') out.push('runbook.signed.trusted: expected true or false');
      }
    }
  }
  str(x.who, 'who');
  if (!(RUN_CLIENTS as readonly unknown[]).includes(x.client)) out.push(`client: expected one of ${RUN_CLIENTS.join(', ')}`);
  for (const k of ['started', 'ended'] as const) if (typeof x[k] !== 'string' || !ISO_RE.test(x[k] as string)) out.push(`${k}: expected an ISO 8601 UTC time`);
  if (!Array.isArray(x.steps)) out.push('steps: expected a list');
  else
    x.steps.forEach((s: unknown, k) => {
      const where = `steps[${k}]`;
      if (!isObj(s)) return void out.push(`${where}: expected an object`);
      onlyKeys(s, ['n', 'label', 'state', 'ms'], where, out);
      if (s.n !== k + 1) out.push(`${where}.n: expected ${k + 1}`);
      str(s.label, `${where}.label`);
      if (!(RUN_STEP_STATES as readonly unknown[]).includes(s.state)) out.push(`${where}.state: expected one of ${RUN_STEP_STATES.join(', ')}`);
      if (s.ms !== undefined && (!Number.isInteger(s.ms) || (s.ms as number) < 0)) out.push(`${where}.ms: expected milliseconds`);
    });
  const n = Array.isArray(x.steps) ? x.steps.length : 0;
  if (!Array.isArray(x.ran) || !x.ran.every((r) => Number.isInteger(r) && r >= 1 && r <= n)) out.push('ran: expected step numbers');
  const t = x.totals;
  if (!isObj(t)) out.push('totals: missing');
  else {
    onlyKeys(t, ['steps', 'passed', 'failed', 'skipped', 'notRun', 'byHand'], 'totals', out);
    for (const k of ['steps', 'passed', 'failed', 'skipped', 'notRun', 'byHand']) if (!Number.isInteger(t[k]) || (t[k] as number) < 0) out.push(`totals.${k}: expected a count`);
  }
  if (typeof x.green !== 'boolean') out.push('green: expected true or false');
  if (x.stopped !== undefined && x.stopped !== true) out.push('stopped: expected true, or absent');
  if (x.gate !== undefined) {
    const g = x.gate;
    if (!isObj(g)) out.push('gate: expected an object');
    else {
      onlyKeys(g, ['host', 'account', 'from'], 'gate', out);
      str(g.host, 'gate.host', 255);
      str(g.account, 'gate.account', 64);
      if (g.from !== undefined) str(g.from, 'gate.from', 64);
    }
  }
  if (x.alert !== undefined) {
    const a = x.alert;
    if (!isObj(a)) out.push('alert: expected an object');
    else {
      onlyKeys(a, ['name', 'fingerprint', 'startsAt', 'labels'], 'alert', out);
      if (a.startsAt !== undefined && (typeof a.startsAt !== 'string' || !STARTS_AT_RE.test(a.startsAt))) out.push('alert.startsAt: expected a time (RFC 3339)');
      str(a.name, 'alert.name');
      if (a.fingerprint !== undefined && (typeof a.fingerprint !== 'string' || !FINGERPRINT_RE.test(a.fingerprint))) out.push('alert.fingerprint: expected letters, digits and . _ : -');
      if (a.labels !== undefined) {
        if (!isObj(a.labels) || Object.keys(a.labels).length > ALERT_LABELS_MAX) out.push(`alert.labels: expected at most ${ALERT_LABELS_MAX} name: value pairs`);
        else for (const [k, v] of Object.entries(a.labels)) {
          if (!LABEL_NAME_RE.test(k)) out.push(`alert.labels: "${k.slice(0, 40)}" is not a label name`);
          str(v, `alert.labels.${k.slice(0, 40)}`);
        }
      }
    }
  }
  return out;
}

// ---- the signed envelope ----

/** What a signed summary is sent as: the summary, and an SSH signature over its canonical JSON. */
export interface RunEnvelope {
  summary: RunSummaryReport;
  /** `-----BEGIN SSH SIGNATURE-----…`, namespace md-runbook-run, over canonicalJson(summary). */
  signature: string;
  /** The runner's name as the client knows it (the server's allowed signers decide who it is). */
  signer?: string;
}

/** The JSON body to POST: the envelope when signed, else the summary itself. */
export function reportBody(summary: RunSummaryReport, signed?: { signature: string; signer?: string }): string {
  return signed ? canonicalJson({ summary, signature: signed.signature, ...(signed.signer ? { signer: signed.signer } : {}) }) : canonicalJson(summary);
}

/** An envelope from its JSON, or the reasons it isn't one (the summary is checked too). */
export function parseRunEnvelope(json: string): { envelope: RunEnvelope } | { problems: string[] } {
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch (e) {
    return { problems: [`not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!isObj(x)) return { problems: ['not a JSON object'] };
  const problems: string[] = [];
  onlyKeys(x, ['summary', 'signature', 'signer'], 'envelope', problems);
  if (typeof x.signature !== 'string' || !/-----BEGIN SSH SIGNATURE-----[\s\S]+-----END SSH SIGNATURE-----/.test(x.signature)) problems.push('signature: expected an SSH signature (-----BEGIN SSH SIGNATURE-----)');
  if (x.signer !== undefined && typeof x.signer !== 'string') problems.push('signer: expected text');
  problems.push(...runSummaryProblems(x.summary).map((p) => `summary: ${p}`));
  return problems.length > 0 ? { problems } : { envelope: x as unknown as RunEnvelope };
}

// ---- what the runbook asks for, and what this client honours ----

/** The address a report goes to: `https://host[:port]`, what consent is remembered by. */
export function reportOrigin(url: string): string {
  const m = /^([a-z]+:\/\/[^/?#]+)/i.exec(url);
  return (m ? m[1]! : url).toLowerCase();
}

/** The host name of a report address (for the consent question). */
export const reportHost = (url: string): string => reportOrigin(url).replace(/^[a-z]+:\/\//, '');

export interface ReportPlan {
  url: string;
  /** `https://host[:port]`. */
  origin: string;
  host: string;
  /** The run starts only once reporting is agreed to (honoured: the runbook is signed by a trusted signer, and the signature covers it). */
  required: boolean;
  /** The summary must be signed with the runner's key (honoured as `required`). */
  signed: boolean;
  /** The secret whose value is sent as a bearer token. */
  token?: string;
  /** Why `report-runs-required`/`-signed` in the file are not honoured here; undefined when honoured or not asked for. */
  ignored?: string;
}

/** The front matter's run report settings, or undefined without a valid `report-runs:` address. */
export function reportSettings(text: string): { url: string; required: boolean; signed: boolean; token?: string } | undefined {
  const fm = parseFrontMatter(text);
  if (!fm?.reportRuns) return undefined;
  return { url: fm.reportRuns, required: fm.reportRunsRequired === true, signed: fm.reportRunsSigned === true, ...(fm.reportRunsToken ? { token: fm.reportRunsToken } : {}) };
}

/**
 * Whether the runbook's signature can make reporting required: it signs the whole runbook
 * (manifest version 2, so the front matter too) and the text is as signed, it hasn't expired, and
 * `trustedSigner` is set (the client checked a signature of it against the signers it trusts).
 * Undefined when it can; else why not.
 */
export function reportTrustProblem(text: string, trustedSigner: string | undefined, now = new Date()): string | undefined {
  if (!readSignature(text)) return 'the runbook is not signed';
  const status = signedStatus(text);
  if (!status) return 'the signature block is damaged';
  if (status.version !== 2) return 'the signature covers only its blocks, not the front matter (signed before manifest version 2): sign the runbook again';
  if (status.textChanged) return 'the runbook changed since signing: sign it again';
  const expires = status.manifest.expires;
  if (expires && now.toISOString().slice(0, 10) > expires) return `the signature expired on ${expires}`;
  if (trustedSigner === undefined) return 'the signature is not checked against signers this client trusts';
  return undefined;
}

/**
 * Where and how this runbook's runs are reported, or undefined when it names no address.
 * `required` and `signed` count only when reportTrustProblem says the signature can make them
 * so; otherwise reporting is asked for like any other (`ignored` says why).
 */
export function reportPlan(text: string, trustedSigner: string | undefined, now = new Date()): ReportPlan | undefined {
  const asked = reportSettings(text);
  if (!asked || reportAddressProblem(asked.url) !== undefined) return undefined;
  const wants = asked.required || asked.signed;
  const problem = wants ? reportTrustProblem(text, trustedSigner, now) : undefined;
  const honoured = wants && problem === undefined;
  return {
    url: asked.url,
    origin: reportOrigin(asked.url),
    host: reportHost(asked.url),
    required: honoured && asked.required,
    signed: honoured && asked.signed,
    ...(asked.token ? { token: asked.token } : {}),
    ...(problem ? { ignored: problem } : {}),
  };
}

/**
 * The principal of `allowedSigners` (allowed_signers text, as the app keeps it in its settings)
 * whose key made one of the runbook's signatures, checked in JavaScript (sshsigVerify.ts); undefined
 * when none is good, or the key type isn't checked there.
 */
export async function trustedSignerOf(text: string, allowedSigners: string, subtle?: SubtleLike, now = new Date()): Promise<string | undefined> {
  const block = readSignature(text);
  if (!block || allowedSigners.trim() === '') return undefined;
  for (const sig of allSignatures(block)) {
    try {
      return await verifySshsig(block.manifest, sig, SIGNATURE_NAMESPACE, allowedSigners, subtle, now);
    } catch {
      // the next signature (a co-signer's)
    }
  }
  return undefined;
}

/** What a summary holds, in words, for the consent question and the notice. */
export const REPORTED_FIELDS =
  "the runbook's file name, title and hash, your user name, this client, when the run started and ended, and each step's label, result and duration. " +
  'Never outputs, parameter or input values, or secrets.';

/** The question asked before the first report to an address (Allow / Not now / Never). */
export function reportConsentText(plan: ReportPlan): string {
  return `This runbook reports its runs to ${plan.host}: ${REPORTED_FIELDS}${plan.token ? ` The secret ${plan.token} is sent as its access token.` : ''}`;
}

/** The notice of a runbook that requires reporting (Run / Don't run). */
export function reportRequiredText(plan: ReportPlan): string {
  return (
    `This signed runbook runs only if its run is reported to ${plan.host}: ${REPORTED_FIELDS}` +
    `${plan.token ? ` The secret ${plan.token} is sent as its access token.` : ''}${plan.signed ? ' The summary is signed with your key.' : ''}`
  );
}

/**
 * What consent is remembered by: the address, and the secret sent with it (a runbook that sends
 * another secret to the same address is asked about again).
 */
export const consentKey = (plan: Pick<ReportPlan, 'origin' | 'token'>): string => plan.origin + (plan.token ? ` token=${plan.token}` : '');

/**
 * Whether a setting's list pre-approves the address: an entry is a host (`reports.example.net`),
 * an origin (`https://reports.example.net:8443`), or an address prefix (`https://x.net/runs/`).
 */
export function addressAllowed(url: string, entries: readonly string[]): boolean {
  const origin = reportOrigin(url);
  const host = reportHost(url).replace(/:\d+$/, '');
  return entries.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (e === '') return false;
    if (!e.includes('://')) return e === host || e === reportHost(url);
    if (e === origin || e === origin + '/') return true;
    return url.toLowerCase().startsWith(e.endsWith('/') ? e : e + '/') || url.toLowerCase() === e;
  });
}

// ---- sending, and the queue of reports not sent yet ----

/** A report waiting to be sent again; the token's value is never kept, only its secret's name. */
export interface QueuedReport {
  url: string;
  body: string;
  token?: string;
  /** When it was first queued, and when to try next (ms since 1970). */
  queued: number;
  next: number;
  tries: number;
}

/** Reports kept waiting at most: the oldest are dropped first. */
export const REPORT_QUEUE_MAX = 100;
/** A report not sent within this long is dropped. */
export const REPORT_MAX_AGE_MS = 7 * 24 * 3600_000;
/** How long one try may take. */
export const REPORT_TIMEOUT_MS = 10_000;

/** The queue with `item` added (within the caps). */
export function enqueueReport(queue: readonly QueuedReport[], item: Omit<QueuedReport, 'queued' | 'next' | 'tries'>, now = Date.now()): QueuedReport[] {
  return [...pruneReports(queue, now), { ...item, queued: now, next: now + retryDelay(0), tries: 1 }].slice(-REPORT_QUEUE_MAX);
}

/** 1, 2, 4 … minutes after each failed try, at most 6 hours. */
export const retryDelay = (tries: number): number => Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, tries));

/** The queue without reports too old to send. */
export const pruneReports = (queue: readonly QueuedReport[], now = Date.now()): QueuedReport[] => queue.filter((q) => now - q.queued < REPORT_MAX_AGE_MS);

/** The queue after a try of `item`: gone when sent or refused for good, else tried again later. */
export function afterTry(queue: readonly QueuedReport[], item: QueuedReport, outcome: PostOutcome, now = Date.now()): QueuedReport[] {
  const rest = queue.filter((q) => q !== item && !(q.url === item.url && q.body === item.body));
  if (outcome.ok || !outcome.retry) return pruneReports(rest, now);
  return pruneReports([...rest, { ...item, tries: item.tries + 1, next: now + retryDelay(item.tries) }], now);
}

export type PostOutcome = { ok: true } | { ok: false; retry: boolean; why: string };

/** The part of `fetch` sending needs (the app, Node and the web all have it). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect?: 'error' },
) => Promise<{ status: number; ok: boolean }>;

/**
 * POST a report (the summary, or its envelope) with a short timeout. Redirects are refused (the
 * token must not follow one). A 4xx answer other than 408 and 429 is refused for good; anything
 * else that fails is worth another try.
 */
export async function postRunReport(o: { url: string; body: string; token?: string; timeoutMs?: number; fetch?: FetchLike }): Promise<PostOutcome> {
  const f = o.fetch ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (!f) return { ok: false, retry: false, why: 'no fetch here' };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutMs ?? REPORT_TIMEOUT_MS);
  try {
    const r = await f(o.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: o.body,
      signal: abort.signal,
      redirect: 'error',
    });
    if (r.ok) return { ok: true };
    const retry = r.status === 408 || r.status === 429 || r.status >= 500 || r.status < 400;
    return { ok: false, retry, why: `the server answered ${r.status}` };
  } catch (e) {
    return { ok: false, retry: true, why: abort.signal.aborted ? 'no answer in time' : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

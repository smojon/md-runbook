/**
 * Team run summaries: what VS Code, the app, the command line (`report-runs:`) and md-runbook-gate
 * (`report_to`) send at the end of a run (docs/features/run-reports.md). Each is checked strictly
 * (runSummaryProblems: no field it doesn't know, so never an output or a value), its runner
 * signature checked against the allowed runners (ssh-keygen, namespace md-runbook-run), and kept
 * as one JSON line, append-only, with what the check found and when it arrived.
 */
import type { RunsConfig } from './config';
import { ReceivedRunSummary, parseRunEnvelope, runSummaryProblems, verifyRunEnvelope } from './core';
import { HttpError, JsonLog } from './http';
import { nameFitsPath } from './library';

/**
 * How far a summary can be believed: `runner-signed` (a key in the allowed runners signed it),
 * `gate` (sent with a gate token: md-runbook-gate's own record of what it ran), `unverified`
 * (anything else: what the sender says).
 */
export type RunTrust = 'runner-signed' | 'gate' | 'unverified';

export interface RunRecord {
  /** When the server got it (ISO 8601, UTC). */
  received: string;
  trust: RunTrust;
  verified: boolean;
  /** The principal of the allowed runners whose key signed it. */
  runner?: string;
  /** Why it isn't verified (a signature that doesn't check, no allowed runners set, …). */
  why?: string;
  /** The client address it came from, and the name of the token it was sent with. */
  from: string;
  token?: string;
  summary: ReceivedRunSummary;
  /** The runner's signature as sent, to check again later (`md-runbook verify-run`). */
  signature?: string;
  /** The runner's name as the client gave it (a hint; `runner` is who signed). */
  signer?: string;
}

/** Totals, `ran` and `green` must say what the steps say: a summary can't claim green with a failed step. */
export function summaryMismatches(s: ReceivedRunSummary): string[] {
  const out: string[] = [];
  const count = (state: string): number => s.steps.filter((x) => x.state === state).length;
  const want = { steps: s.steps.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), notRun: count('not-run'), byHand: count('by-hand') };
  for (const [k, v] of Object.entries(want)) if (s.totals[k as keyof typeof want] !== v) out.push(`totals.${k}: ${s.totals[k as keyof typeof want]}, but the steps say ${v}`);
  const green = s.steps.length > 0 && want.failed === 0 && want.notRun === 0;
  if (s.green !== green) out.push(`green: ${s.green}, but the steps say ${green}`);
  if (new Set(s.ran).size !== s.ran.length) out.push('ran: a step number twice');
  if (Date.parse(s.ended) < Date.parse(s.started)) out.push('ended: before started');
  return out;
}

/**
 * Whether a summary is of the runbook `q`: a signed name (`ops/restart-api`), or a path in the
 * library (`ops/restart-api.md`), which matches the file name a client sends and the signed name
 * a gate sends (its last part is the file's name).
 */
export function summaryMatches(s: ReceivedRunSummary, q: string): boolean {
  const query = q.replace(/^\/+/, '');
  const signed = s.runbook.signed;
  if (signed && signed.name === query) return true;
  if (!/\.(md|markdown)$/i.test(query)) return false;
  const file = query.split('/').pop()!;
  return s.runbook.file === file || (signed !== undefined && nameFitsPath(signed.name, query));
}

export interface ReceiveContext {
  from: string;
  /** The token it came with, and whether it is a gate's. */
  token?: { label: string; gate: boolean };
}

export class Runs {
  readonly log: JsonLog;
  constructor(
    readonly config: RunsConfig,
    private readonly sshKeygen = 'ssh-keygen',
  ) {
    this.log = new JsonLog(config.dir, 'runs');
  }

  /** Check and keep a summary (or its envelope); the record kept, or an HttpError. */
  async receive(body: string, ctx: ReceiveContext, now = new Date()): Promise<RunRecord> {
    let x: unknown;
    try {
      x = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'not JSON');
    }
    const isEnvelope = typeof x === 'object' && x !== null && !Array.isArray(x) && ('summary' in x || 'signature' in x);
    let summary: ReceivedRunSummary;
    let trust: RunTrust = 'unverified';
    let runner: string | undefined;
    let why: string | undefined;
    let signature: string | undefined;
    let signer: string | undefined;
    if (isEnvelope) {
      const parsed = parseRunEnvelope(body);
      if ('problems' in parsed) throw new HttpError(400, 'not a run summary', parsed.problems);
      summary = parsed.envelope.summary;
      signature = parsed.envelope.signature;
      signer = parsed.envelope.signer;
      if (this.config.allowedRunners) {
        try {
          runner = (await verifyRunEnvelope(body, this.config.allowedRunners, this.sshKeygen)).signer;
          trust = 'runner-signed';
        } catch (e) {
          // The server's file names stay on the server.
          why = (e instanceof Error ? e.message : String(e)).split('\n')[0]!.split(this.config.allowedRunners).join('the allowed runners').slice(0, 200);
        }
      } else why = 'signed, but this server has no allowed runners to check it with (RUNS_ALLOWED_RUNNERS)';
    } else {
      const problems = runSummaryProblems(x);
      if (problems.length > 0) throw new HttpError(400, 'not a run summary', problems);
      summary = x as ReceivedRunSummary;
      why = 'not signed';
    }
    const mismatches = summaryMismatches(summary);
    if (mismatches.length > 0) throw new HttpError(400, 'the summary contradicts itself', mismatches);

    if (summary.client === 'gate' && trust !== 'runner-signed') {
      if (ctx.token?.gate) {
        trust = 'gate';
        why = undefined;
      } else if (this.config.gateTokens.length > 0) throw new HttpError(403, "a gate's summary (client gate) needs a gate token (RUNS_GATE_TOKENS)");
      else why = 'client gate, but this server has no gate tokens to tell a gate (RUNS_GATE_TOKENS)';
    }
    if (this.config.requireSigned && trust === 'unverified') throw new HttpError(403, `this server keeps only summaries signed by a known runner or sent by a gate: ${why ?? 'not verified'}`);

    const record: RunRecord = {
      received: now.toISOString(),
      trust,
      verified: trust !== 'unverified',
      ...(runner ? { runner } : {}),
      ...(why ? { why } : {}),
      from: ctx.from,
      ...(ctx.token ? { token: ctx.token.label } : {}),
      summary,
      ...(signature ? { signature } : {}),
      ...(signer ? { signer } : {}),
    };
    await this.log.append(record, now);
    return record;
  }

  /** The newest runs of runbook `q` (all runbooks without one), newest first. */
  list(q: string | undefined, limit: number): Promise<RunRecord[]> {
    return this.log.recent<RunRecord>((r) => !!r?.summary?.runbook && (q === undefined || summaryMatches(r.summary, q)), limit);
  }

  /**
   * "Last ran green by X at T": the newest green run of `q`, and when that one isn't verified, the
   * newest verified green run too.
   */
  async lastGreen(q: string): Promise<{ last?: RunRecord; lastVerified?: RunRecord; text: string }> {
    const green = (r: RunRecord): boolean => !!r?.summary?.runbook && r.summary.green === true && summaryMatches(r.summary, q);
    const [last] = await this.log.recent<RunRecord>(green, 1);
    if (!last) return { text: `${q}: no green run reported` };
    const lastVerified = last.verified ? last : (await this.log.recent<RunRecord>((r) => green(r) && r.verified, 1))[0];
    const say = (r: RunRecord): string =>
      `${r.runner ?? r.summary.who} at ${r.summary.ended}${r.summary.runbook.signed ? ` (version ${r.summary.runbook.signed.version})` : ''}, ${r.verified ? (r.trust === 'gate' ? 'verified: sent by a gate' : 'verified: signed by the runner') : 'unverified'}`;
    const text = `${q}: last ran green by ${say(last)}` + (lastVerified && lastVerified !== last ? `; last verified green run by ${say(lastVerified)}` : '');
    return { last, ...(lastVerified ? { lastVerified } : {}), text };
  }
}

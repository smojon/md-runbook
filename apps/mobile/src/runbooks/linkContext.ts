/**
 * What a runbook link asked for, for the runbook it opened: how far its text can be trusted, the
 * host it named and whether to open on Co-sign Runbook. Kept in memory, like autorun.ts, until
 * the runbook screen closes: a later visit opens the runbook plainly.
 */
import type { LinkTrust } from '@md-runbook/core/runbookLink';

export interface LinkContext {
  trust: Exclude<LinkTrust, 'mismatch'>;
  /** The link's host=, when the app has a host of that name. */
  hostId?: string;
  /** The link's host=, when the app has none of that name. */
  missingHost?: string;
  /** p.NAME values the runbook has no parameter for (not filled in). */
  ignoredParams: string[];
  /** p.NAME values not among the parameter's choices (not filled in: typed when it runs). */
  refusedParams?: string[];
  cosign: boolean;
  /** The copy the link opened before is running or waiting for an answer: this is a new copy. */
  freshCopy?: boolean;
}

const contexts = new Map<string, LinkContext>();

/**
 * Runbooks whose screen has a run going or a card waiting for an answer (a confirmation, values
 * to type, another host). A link doesn't fill its values into one: Run on a card waiting would run
 * the link's values without asking (security review, round 5). It opens a new copy instead.
 */
const busy = new Set<string>();

export function setRunbookBusy(runbookId: string, on: boolean): void {
  if (on) busy.add(runbookId);
  else busy.delete(runbookId);
}

export function runbookBusy(runbookId: string): boolean {
  return busy.has(runbookId);
}

export function setLinkContext(runbookId: string, c: LinkContext): void {
  contexts.set(runbookId, c);
}

/** The context of a runbook just opened from a link. */
export function linkContext(runbookId: string): LinkContext | undefined {
  return contexts.get(runbookId);
}

/** The runbook screen closed: a later visit opens the runbook plainly. */
export function forgetLinkContext(runbookId: string): void {
  contexts.delete(runbookId);
}

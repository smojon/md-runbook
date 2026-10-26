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
  cosign: boolean;
}

const contexts = new Map<string, LinkContext>();

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

/** Reading the info string of a fenced block pasted from an assistant's answer (Paste AI Proposal). */

import { proposalOf } from './proposal';

/** The rest of an info string after a closing quote: only well-formed tokens (or nothing). */
const TOKENS_RE = /^(?:\s+[A-Za-z][\w.-]*(?:=(?:"[^"]*"|'[^']*'|[^\s"']*))?)*\s*$/;

/**
 * `reason=` of a pasted info string. Assistants sometimes nest quotes
 * (`reason="use the "real" token"`): the closing quote is the first one after which only
 * well-formed tokens follow. The caller sanitizes the value (infoSafe) before writing it.
 */
export function pastedReason(info: string): string | undefined {
  const m = /(?:^|\s)reason=(["'])/i.exec(info);
  if (!m) return proposalOf(info).reason;
  const q = m[1]!;
  const start = m.index + m[0].length;
  for (let k = info.indexOf(q, start); k >= 0; k = info.indexOf(q, k + 1)) {
    if (TOKENS_RE.test(info.slice(k + 1))) return info.slice(start, k);
  }
  return info.slice(start);
}

/** Who proposed a pasted block (`by=claude`), default `ai`. proposedInfo sanitizes it. */
export function pastedBy(info: string): string {
  return proposalOf(info).by ?? 'ai';
}

/**
 * Continuing the run copy of a runbook call (core/call.ts) after a failure. The call's output
 * block names the copy, and output blocks are never signed: so the copy must still be the
 * runbook called (its blocks, its signed name and version) before its done steps are kept.
 * Platform-neutral; the checks on disk are in core/node/call.ts (resumeProblem).
 */

import { locateCodeCells } from './locate';
import { parse } from './parser';
import { parseManifest, readSignature } from './signing';

/** Whether `copyName` is a run copy's name of the runbook file `targetName` (copyFileName). */
export function isCopyNameOf(copyName: string, targetName: string, ignoreCase = false): boolean {
  const base = targetName.replace(/\.md$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${base}\\.\\d{8}-\\d{6}(?:-\\d+)?\\.md$`, ignoreCase ? 'i' : '').test(copyName);
}

/** `name version N` of a signed runbook, or undefined (unsigned, or a malformed block). */
function signedAs(text: string): string | undefined {
  const sig = readSignature(text);
  if (!sig) return undefined;
  try {
    const m = parseManifest(sig.manifest);
    return `${m.name} version ${m.version}`;
  } catch {
    return undefined;
  }
}

/**
 * Why the text of a copy is not that of the runbook called: other blocks, or (when either is
 * signed, or `signed`: a signed run) another manifest name or version. Undefined: it is.
 */
export function copyTextProblem(copyText: string, targetText: string, signed = false): string | undefined {
  const blocks = (t: string): string[] => locateCodeCells(parse(t)).map((l) => `${l.info}\n${l.source}`);
  const a = blocks(copyText);
  const b = blocks(targetText);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return 'its blocks are not those of the runbook called';
  const mine = signedAs(copyText);
  const theirs = signedAs(targetText);
  if ((signed || mine !== undefined || theirs !== undefined) && (mine === undefined || mine !== theirs)) {
    return `it is signed as ${mine ?? 'nothing'}, the runbook called as ${theirs ?? 'nothing'}`;
  }
  return undefined;
}

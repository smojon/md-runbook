/**
 * Continuing the run copy of a runbook call (core/call.ts) after a failure. The call's output
 * block names the copy, and output blocks are never signed: so the copy must still be the
 * runbook called (its blocks, its signed name and version, its front matter) before its done
 * steps are kept, and its outputs must be ones md-runbook wrote (copyDigest, kept where the copy
 * can't change it: VS Code's global state, the command line's state file).
 * Platform-neutral; the checks on disk are in core/node/call.ts (resumeProblem).
 */

import { withFrontMatterValues } from './incident';
import { locateCodeCells } from './locate';
import { parse } from './parser';
import { sha256Hex } from './sha256';
import { frontMatterLines as linesOfFrontMatter } from './secrets';
import { parseManifest, readSignature } from './signing';

/** A text's front matter lines (between the `---` lines, trailing spaces trimmed); none: []. */
function frontMatterLines(text: string): string[] {
  return (linesOfFrontMatter(text) ?? []).map((l) => l.trimEnd());
}

/**
 * Why the copy's front matter is not the one a run copy of `targetText` gets now: the target's,
 * with `added` set as writeCallCopy and the call write them (the caller's record values, the
 * caller's kube-context). A planted copy could otherwise run under its own env:, shell:,
 * kube-context: or choices. Undefined: it is.
 */
export function copyFrontMatterProblem(copyText: string, targetText: string, added: Record<string, string> = {}): string | undefined {
  const expected = Object.keys(added).length > 0 ? withFrontMatterValues(targetText, added) : targetText;
  const a = frontMatterLines(copyText);
  const b = frontMatterLines(expected);
  return a.length === b.length && a.every((l, i) => l === b[i]) ? undefined : 'its front matter is not that of the runbook called';
}

/**
 * What md-runbook keeps of a call copy it wrote (after a run, or a save in VS Code): SHA-256 of
 * its text, with line ends and task-list ticks set aside (ticking a manual step in the copy is
 * fine). A copy whose digest isn't the kept one is not continued: its "done" outputs could be
 * planted.
 */
export function copyDigest(text: string): string {
  return sha256Hex(uncheckTaskBoxes(text.replace(/^﻿/, '').replace(/\r\n/g, '\n')));
}

/** What uncheckTaskBoxes does; kept as the definition (test/hostileText.test.ts compares the two). */
export const TASK_BOX_RE = /^(\s*[-*+]\s+)\[[ xX]\]/gm;

const isLineEnd = (c: string | undefined): boolean => c === '\n' || c === '\r' || c?.charCodeAt(0) === 0x2028 || c?.charCodeAt(0) === 0x2029;
const isRegexSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * `t.replace(TASK_BOX_RE, '$1[ ]')` in one pass. From each line start, `\s*` reads across empty
 * lines to the first other character: every line start in one run of blanks and line ends reads to
 * the same place, so it is read once (10,000 empty lines took seconds).
 */
export function uncheckTaskBoxes(t: string): string {
  let out = '';
  let pos = 0;
  let runFrom = -1;
  let runEnd = -1;
  let failed = -1;
  for (let p = 0; p < t.length; p++) {
    if (p < pos || (p > 0 && !isLineEnd(t[p - 1]))) continue;
    if (p < runFrom || p > runEnd) {
      runFrom = p;
      runEnd = p;
      while (isRegexSpace(t[runEnd])) runEnd++;
    }
    const bullet = runEnd;
    if (bullet === failed || (t[bullet] !== '-' && t[bullet] !== '*' && t[bullet] !== '+')) continue;
    let r = bullet + 1;
    while (isRegexSpace(t[r])) r++;
    if (r === bullet + 1 || t[r] !== '[' || (t[r + 1] !== ' ' && t[r + 1] !== 'x' && t[r + 1] !== 'X') || t[r + 2] !== ']') {
      failed = bullet;
      continue;
    }
    out += t.slice(pos, r) + '[ ]';
    pos = r + 3;
  }
  return out + t.slice(pos);
}

/** Why a call doesn't continue a copy whose digest isn't the one kept for it. */
export const COPY_NOT_RECORDED = 'its step results were not written by md-runbook on this machine, or it changed since';

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

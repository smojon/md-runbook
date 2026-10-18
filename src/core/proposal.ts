/**
 * Proposed cells: code written by an assistant (or a colleague) that must be approved before it
 * can run. The state lives in the fence info string, so it is plain Markdown and survives any
 * editor:
 *
 *   ```bash proposed by=ai reason="check pod restarts"
 *   ```bash approved-by=smojon approved-at=2026-10-18T17:20:00+02:00 by=ai reason="check pod restarts"
 */

import { tokenizeInfo } from './cellOptions';
import { langOf } from './fence';
import type { CodeMeta } from './model';

export interface Proposal {
  state: 'none' | 'proposed' | 'approved';
  /** Who proposed it (`by=`), e.g. `ai` or a model name. */
  by?: string;
  reason?: string;
  approvedBy?: string;
  approvedAt?: string;
}

/** Proposal state of a fence info string (including the language word). */
export function proposalOf(info: string): Proposal {
  const lang = langOf(info);
  const rest = info.slice(info.toLowerCase().indexOf(lang) + lang.length);
  const p: Proposal = { state: 'none' };
  let proposed = false;
  for (const t of tokenizeInfo(rest)) {
    const key = t.key.toLowerCase();
    if (key === 'proposed' && t.value === undefined) proposed = true;
    else if (key === 'by' && t.value) p.by = t.value;
    else if (key === 'reason' && t.value !== undefined) p.reason = t.value;
    else if (key === 'approved-by' && t.value) p.approvedBy = t.value;
    else if (key === 'approved-at' && t.value) p.approvedAt = t.value;
  }
  // An explicit `proposed` flag wins: re-proposing an approved cell makes it need approval again.
  p.state = proposed ? 'proposed' : p.approvedBy ? 'approved' : 'none';
  return p;
}

/** A value safe inside a quoted info-string token (no quotes, backticks or line breaks). */
export function infoSafe(value: string, max = 120): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/["'`]/g, '').trim().slice(0, max);
}

const word = (v: string): string => infoSafe(v, 60).replace(/\s+/g, '-') || 'unknown';

/** Info string for a new proposed cell: `bash proposed by=ai reason="…"`. */
export function proposedInfo(lang: string, by: string, reason?: string): string {
  const r = reason ? infoSafe(reason) : '';
  return `${lang} proposed by=${word(by)}${r ? ` reason="${r}"` : ''}`;
}

/** Replace the `proposed` flag with `approved-by=… approved-at=…`, keeping every other token. */
export function approvedInfo(info: string, user: string, at: string): string {
  const stamp = `approved-by=${word(user)} approved-at=${word(at)}`;
  const replaced = info.replace(/(^|\s)proposed(?=\s|$)/i, `$1${stamp}`);
  return replaced === info ? `${info} ${stamp}` : replaced;
}

const approvalToken = (key: string): RegExp => new RegExp(`(^|\\s)${key}=("[^"]*"|'[^']*'|\\S*)`, 'i');

/**
 * The info string of an approved cell back as a proposal (to approve it again): the first
 * `approved-by=…` token becomes `proposed` (or is dropped if the flag is already there) and
 * `approved-at=…` is dropped.
 */
export function asProposed(info: string): string {
  const hasFlag = /(^|\s)proposed(?=\s|$)/i.test(info);
  return info.replace(approvalToken('approved-by'), hasFlag ? '' : '$1proposed').replace(approvalToken('approved-at'), '');
}

/** A copy of `meta` whose opening fence line carries `info` (same indent, fence and line ending). */
export function withInfo(meta: CodeMeta, info: string): CodeMeta {
  const eol = /\r\n$/.test(meta.open) ? '\r\n' : /\n$/.test(meta.open) ? '\n' : /\r$/.test(meta.open) ? '\r' : meta.eol;
  const open = meta.indent + meta.fenceChar.repeat(meta.fenceLen) + info + eol;
  return { ...meta, info, open };
}

/**
 * Proposed cells approved on this device, as the extension keeps them on its machine: by a hash of
 * the cell's code, its fence options and its runbook (core/policy approvalHash). An `approved-by=`
 * stamp that came with the file is not enough: anything that can edit the file can write one.
 */
import { DEFAULT_WRITE_OPTIONS, isCodeMeta, parse, serialize, toCellInputs } from '@md-runbook/core';
import { approvalHash, approvalStatus } from '@md-runbook/core/policy';
import { approvedInfo, proposalOf, withInfo } from '@md-runbook/core/proposal';
import { getJson, setJson } from '../storage/kv';

const KEY = 'approvals.v1';
const isHashes = (v: unknown): v is string[] => Array.isArray(v) && v.every((h) => typeof h === 'string');
let hashes = new Set<string>();

export async function loadApprovals(): Promise<void> {
  hashes = new Set([...((await getJson(KEY, isHashes)) ?? []), ...hashes]);
}

export const isApprovedHere = (hash: string): boolean => hashes.has(hash);

/** none: not a proposal; approved: approved on this device; else why it can't run yet. */
export function approvalOf(info: string, code: string, runbookId: string): 'none' | 'approved' | 'proposed' | 'unverified' {
  const p = proposalOf(info);
  if (p.state === 'none' && p.by === undefined) return 'none';
  const s = approvalStatus(p.state === 'none' ? 'proposed' : p.state, {
    code,
    info,
    runbook: runbookId,
    loadedCode: code,
    approvedHere: isApprovedHere,
    resetOnEdit: true,
    trustFileApprovals: false,
  });
  return s.state === 'approved' ? 'approved' : s.state === 'proposed' && s.why === 'unverified' ? 'unverified' : 'proposed';
}

/** The cell a review card showed: its code and fence options, as reviewed. */
export interface Reviewed {
  value: string;
  info: string;
}

/** Whether a cell with these fence options is a proposal (proposed, by an assistant, or approved as one). */
const isProposal = (info: string): boolean => {
  const p = proposalOf(info);
  return p.state !== 'none' || p.by !== undefined;
};

/**
 * Cell `index` of `doc` if it is the proposal reviewed (the same code and fence options): an
 * approval or a rejection never lands on another cell that took its place, nor on a step of
 * yours that isn't a proposal.
 */
function reviewedAt(doc: ReturnType<typeof parse>, index: number, reviewed: Reviewed) {
  const cell = doc.cells[index];
  if (!cell || cell.kind !== 'code' || !isCodeMeta(cell.meta)) return undefined;
  if (cell.value !== reviewed.value || cell.meta.info !== reviewed.info || !isProposal(cell.meta.info)) return undefined;
  return { cell, meta: cell.meta };
}

/**
 * The runbook with cell `index` approved (stamp in its fence line), and the approval remembered
 * here; undefined when that cell isn't the proposal `reviewed` (nothing is approved then).
 */
export function approveCell(
  runbookId: string,
  text: string,
  index: number,
  user: string,
  at: string,
  reviewed: Reviewed,
): string | undefined {
  const doc = parse(text);
  const found = reviewedAt(doc, index, reviewed);
  if (!found) return undefined;
  const { cell } = found;
  const p = proposalOf(found.meta.info);
  // An approved stamp from elsewhere is approved again here, with this device's stamp.
  const info = p.state === 'approved' ? found.meta.info : approvedInfo(found.meta.info, user, at);
  const cells = toCellInputs(doc);
  cells[index] = { ...cells[index]!, meta: withInfo(found.meta, info) };
  hashes.add(approvalHash(cell.value, info, runbookId));
  void setJson(KEY, [...hashes]).catch((e: unknown) => console.warn('approval not saved', e));
  return serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
}

/**
 * The runbook without cell `index` (a rejected proposal); undefined when that cell isn't the
 * proposal `reviewed` (nothing is removed then: never a step of yours).
 */
export function rejectCell(text: string, index: number, reviewed: Reviewed): string | undefined {
  const doc = parse(text);
  if (!reviewedAt(doc, index, reviewed)) return undefined;
  return serialize(
    doc.meta,
    toCellInputs(doc).filter((_, i) => i !== index),
    DEFAULT_WRITE_OPTIONS,
  );
}

/** Tests. */
export function resetApprovals(): void {
  hashes = new Set();
}

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

/** The runbook with cell `index` approved (stamp in its fence line), and the approval remembered here. */
export function approveCell(runbookId: string, text: string, index: number, user: string, at: string): string | undefined {
  const doc = parse(text);
  const cell = doc.cells[index];
  if (!cell || cell.kind !== 'code' || !isCodeMeta(cell.meta)) return undefined;
  const p = proposalOf(cell.meta.info);
  // An approved stamp from elsewhere is approved again here, with this device's stamp.
  const info = p.state === 'approved' ? cell.meta.info : approvedInfo(cell.meta.info, user, at);
  const cells = toCellInputs(doc);
  cells[index] = { ...cells[index]!, meta: withInfo(cell.meta, info) };
  hashes.add(approvalHash(cell.value, info, runbookId));
  void setJson(KEY, [...hashes]).catch((e: unknown) => console.warn('approval not saved', e));
  return serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
}

/** The runbook without cell `index` (a rejected proposal). */
export function rejectCell(text: string, index: number): string {
  const doc = parse(text);
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

/** Which cells of a runbook the app can run over SSH, and with which options. */
import { ParsedCell, isCodeMeta, shellKindForLanguage } from '@md-runbook/core';
import { CellOptions, parseCellOptions } from '@md-runbook/core/cellOptions';
import { proposalOf } from '@md-runbook/core/proposal';
import { approvalOf } from '../approvals/store';

export type Runnability =
  | { ok: true; options: CellOptions }
  /**
   * language: not a bash/sh cell; os: only for Windows; skip: `skip` option; invalid: bad options;
   * proposed: written by an assistant or a colleague and not approved on this device.
   */
  | { ok: false; why: 'language' | 'os' | 'skip' | 'invalid' | 'proposed' | 'unverified'; detail?: string };

/**
 * The remote shell is bash or sh on a Unix host: cmd, PowerShell and Windows-only blocks don't run.
 * `runbookId`: the runbook the cell is in, for approvals made on this device (without it, no
 * proposal runs).
 */
export function runnability(cell: ParsedCell, runbookId?: string): Runnability {
  if (cell.kind !== 'code' || !isCodeMeta(cell.meta)) return { ok: false, why: 'language' };
  if (shellKindForLanguage(cell.languageId) !== 'bash') return { ok: false, why: 'language' };
  // As in the extension: a proposal never runs before it is approved on this device; an
  // `approved-by=` stamp that came with the file is not trusted (anything that can edit the file can write one).
  const proposal = proposalOf(cell.meta.info);
  const approval =
    runbookId === undefined
      ? proposal.state === 'none' && proposal.by === undefined
        ? 'none'
        : 'proposed'
      : approvalOf(cell.meta.info, cell.value, runbookId);
  if (approval === 'proposed') return { ok: false, why: 'proposed', detail: proposal.by ?? 'someone' };
  if (approval === 'unverified') return { ok: false, why: 'unverified', detail: proposal.by ?? 'someone' };
  const options = parseCellOptions(cell.meta.info);
  if (options.errors.length > 0) return { ok: false, why: 'invalid', detail: options.errors.join('; ') };
  if (options.skip) return { ok: false, why: 'skip' };
  if (options.os && options.os.every((o) => o === 'windows')) return { ok: false, why: 'os' };
  return { ok: true, options };
}

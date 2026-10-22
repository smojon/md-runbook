/** Which cells of a runbook the app can run over SSH, and with which options. */
import { ParsedCell, ShellKind, isCodeMeta, shellKindForLanguage } from '@md-runbook/core';
import type { RemotePlatform } from '@md-runbook/ssh';
import { CellOptions, parseCellOptions } from '@md-runbook/core/cellOptions';
import { proposalOf } from '@md-runbook/core/proposal';
import { approvalOf } from '../approvals/store';

export type Runnability =
  | { ok: true; options: CellOptions; shell: ShellKind }
  /**
   * language: not a shell cell; platform: a shell the server doesn't run (detail: the platform
   * the cell needs); os: `os=` excludes the server's OS (detail: the server's platform); skip:
   * `skip` option; invalid: bad options; proposed: written by an assistant or a colleague and not
   * approved on this device.
   */
  | { ok: false; why: 'language' | 'platform' | 'os' | 'skip' | 'invalid' | 'proposed' | 'unverified'; detail?: string };

/**
 * Linux and macOS servers run bash and sh cells; Windows servers PowerShell and cmd cells.
 * `platform`: the server's, once the app has connected to it (until then a cell's shell says which
 * kind of server it is for). `runbookId`: the runbook the cell is in, for approvals made on this
 * device (without it, no proposal runs).
 */
export function runnability(cell: ParsedCell, runbookId?: string, platform?: RemotePlatform): Runnability {
  if (cell.kind !== 'code' || !isCodeMeta(cell.meta)) return { ok: false, why: 'language' };
  const shell = shellKindForLanguage(cell.languageId);
  if (shell === undefined) return { ok: false, why: 'language' };
  const needs: RemotePlatform = shell === 'bash' ? 'posix' : 'windows';
  const server = platform ?? needs;
  if (server !== needs) return { ok: false, why: 'platform', detail: needs };
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
  if (options.os && (server === 'windows' ? !options.os.includes('windows') : options.os.every((o) => o === 'windows'))) {
    return { ok: false, why: 'os', detail: server };
  }
  return { ok: true, options, shell };
}

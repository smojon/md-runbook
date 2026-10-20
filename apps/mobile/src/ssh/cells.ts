/** Which cells of a runbook the app can run over SSH, and with which options. */
import { ParsedCell, isCodeMeta, shellKindForLanguage } from '@md-runbook/core';
import { CellOptions, parseCellOptions } from '@md-runbook/core/cellOptions';

export type Runnability =
  | { ok: true; options: CellOptions }
  /** language: not a bash/sh cell; os: only for Windows; skip: `skip` option; invalid: bad options. */
  | { ok: false; why: 'language' | 'os' | 'skip' | 'invalid'; detail?: string };

/** The remote shell is bash or sh on a Unix host: cmd, PowerShell and Windows-only blocks don't run. */
export function runnability(cell: ParsedCell): Runnability {
  if (cell.kind !== 'code' || !isCodeMeta(cell.meta)) return { ok: false, why: 'language' };
  if (shellKindForLanguage(cell.languageId) !== 'bash') return { ok: false, why: 'language' };
  const options = parseCellOptions(cell.meta.info);
  if (options.errors.length > 0) return { ok: false, why: 'invalid', detail: options.errors.join('; ') };
  if (options.skip) return { ok: false, why: 'skip' };
  if (options.os && options.os.every((o) => o === 'windows')) return { ok: false, why: 'os' };
  return { ok: true, options };
}

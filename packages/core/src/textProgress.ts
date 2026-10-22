/**
 * Progress of a runbook from its text, for clients that run cells over SSH (the app): the same
 * rules as the extension's progress (computeProgress), with every `host=` block counted (it runs
 * there) and `os=` alternatives judged for the remote system.
 */

import { isCodeMeta } from './model';
import { parseCellOptions } from './cellOptions';
import { OsName, osGroups } from './os';
import { parse } from './parser';
import { Progress, checklist, computeProgress } from './progress';

export function textProgress(text: string, here: OsName = 'linux'): Progress {
  const cells = parse(text).cells;
  const opts = cells.map((c) => (c.kind === 'code' && isCodeMeta(c.meta) ? parseCellOptions(c.meta.info) : undefined));
  const slots = osGroups(
    cells.map((c, i) => ({ kind: c.kind, ...(opts[i]?.os ? { os: opts[i]!.os } : {}) })),
    here,
  );
  return computeProgress(
    cells.map((c, i) => {
      if (c.kind !== 'code') return { kind: 'markup', tasks: checklist(c.value) };
      const attrs = c.output?.attrs;
      const os = slots[i];
      return { kind: 'code', exit: attrs?.exit, partial: attrs?.lines !== undefined, check: attrs?.check, ...(os ? { os } : {}) };
    }),
  );
}

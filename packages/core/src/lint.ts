/**
 * Static checks on a runbook, before anything runs: invalid or unknown cell options, `every=`
 * without `retry=`, `${out:NAME}` with no earlier `capture=NAME`, `${param:NAME}` not declared
 * in the front matter, a name used as two kinds of placeholder, front matter values that are
 * ignored, blocks changed since the runbook was signed. Used by `md-runbook lint` and by the
 * editor's problem markers.
 */

import { parseCellOptions, tokenizeInfo } from './cellOptions';
import { FenceOpen, isFenceClose, matchFenceOpen } from './fence';
import { isCodeMeta } from './model';
import { parse } from './parser';
import { locateCodeCells } from './locate';
import { findRefs, parseFrontMatter } from './secrets';
import { POWERSHELLS, UNIX_SHELLS, parseShells, shellKindForLanguage } from './shellKind';
import { signedStatus } from './signing';

export type LintSeverity = 'error' | 'warning';

export interface LintProblem {
  severity: LintSeverity;
  message: string;
  /** 0-based line in the file. */
  line: number;
  /** For problems inside a code block: its cell index and the 0-based line in its source (undefined: the fence line). */
  cell?: { index: number; sourceLine?: number };
}

const KNOWN_OPTIONS = new Set([
  // cellOptions.ts
  'timeout', 'cwd', 'continue-on-error', 'skip', 'confirm', 'no-confirm', 'terminal', 'name',
  'expect', 'expect-not', 'expect-exit', 'capture', 'capture-secret', 'os', 'host', 'lines', 'retry', 'every',
  // proposal.ts (assistant proposals and approvals)
  'proposed', 'by', 'reason', 'approved', 'approved-by', 'approved-at',
]);

const LANG_RE = /^\s*[^\s{]*/;

export function lintRunbook(text: string): LintProblem[] {
  const problems: LintProblem[] = [];
  const doc = parse(text);
  const locs = locateCodeCells(doc);

  // Front matter values that were written but not understood.
  const fm = parseFrontMatter(text);
  if (fm) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    for (let i = 1; i < end; i++) {
      const m = /^(mode|timeout|cwd)\s*:\s*(.*?)\s*(#.*)?$/i.exec(lines[i]!);
      if (!m) continue;
      const key = m[1]!.toLowerCase();
      const ignored = (key === 'mode' && fm.mode === undefined) || (key === 'timeout' && fm.timeoutSeconds === undefined) || (key === 'cwd' && fm.cwd === undefined);
      if (ignored) {
        const expected = key === 'mode' ? 'session or isolated' : key === 'timeout' ? 'seconds, e.g. 300' : 'a folder';
        problems.push({ severity: 'warning', line: i, message: `front matter ${key}: "${m[2]}" is ignored (expected ${expected})` });
      }
    }
    const seen: { unix?: string; powershell?: string } = {};
    for (let i = 1; i < end; i++) {
      const m = /^shell\s*:\s*(.*?)\s*(#.*)?$/i.exec(lines[i]!);
      if (!m) continue;
      if (m[1] === '') {
        problems.push({ severity: 'warning', line: i, message: 'front matter shell: is empty: write the names on the same line (shell: zsh, pwsh), not as a list below it' });
        continue;
      }
      const { shells, unknown, twice } = parseShells(m[1]!);
      // Across lines too: an earlier shell: line already chose for those cells.
      for (const kind of ['unix', 'powershell'] as const) {
        const name = shells[kind];
        if (!name) continue;
        if (seen[kind]) twice.push(name);
        else seen[kind] = name;
      }
      for (const name of unknown) {
        const message = /[\\/]/.test(name)
          ? `front matter shell: "${name}" is ignored: name a shell (${[...UNIX_SHELLS, ...POWERSHELLS].join(', ')}), never a path`
          : `front matter shell: "${name}" is ignored (expected ${UNIX_SHELLS.join(', ')} for sh/bash cells, ${POWERSHELLS.join(' or ')} for PowerShell cells)`;
        problems.push({ severity: 'warning', line: i, message });
      }
      for (const name of twice) problems.push({ severity: 'warning', line: i, message: `front matter shell: "${name}" is ignored: one shell per kind of cell, the first one counts` });
    }
  }
  const declared = new Set((fm?.params ?? []).map((p) => p.name));
  const captured = new Set<string>();

  for (const loc of locs) {
    const cell = doc.cells[loc.cellIndex]!;
    if (!isCodeMeta(cell.meta) || !shellKindForLanguage(loc.language)) continue;
    const at = (severity: LintSeverity, message: string, sourceLine?: number): void =>
      void problems.push({
        severity,
        message,
        line: sourceLine === undefined ? loc.line : loc.line + 1 + sourceLine,
        cell: { index: loc.cellIndex, ...(sourceLine !== undefined ? { sourceLine } : {}) },
      });

    const opts = parseCellOptions(loc.info);
    for (const e of opts.errors) at('error', `invalid cell option ${e}`);
    const rest = loc.info.replace(LANG_RE, '');
    for (const t of tokenizeInfo(rest)) {
      const key = t.key.toLowerCase();
      if (!KNOWN_OPTIONS.has(key) && !(key.startsWith('env.') && key.length > 4)) at('warning', `unknown cell option "${t.key}" (ignored)`);
    }
    if (/(^|\s)every=/i.test(rest) && !opts.retry) at('warning', 'every= has no effect without retry=');

    let refs: ReturnType<typeof findRefs> = [];
    try {
      refs = findRefs(loc.source);
    } catch (e) {
      at('error', e instanceof Error ? e.message : String(e));
    }
    const lines = loc.source.split(/\r?\n/);
    const lineOf = (needle: string): number | undefined => {
      const i = lines.findIndex((l) => l.includes(needle));
      return i < 0 ? undefined : i;
    };
    for (const ref of refs) {
      const token = '${' + ref.kind + ':' + ref.name;
      if (ref.kind === 'out' && !captured.has(ref.name)) {
        at('error', `\${out:${ref.name}} is not captured by an earlier block (add capture=${ref.name} to the block that prints it)`, lineOf(token));
      }
      if (ref.kind === 'param' && !declared.has(ref.name)) {
        at('warning', `\${param:${ref.name}} is not declared in the front matter params: (it has no default, and the command line needs --param ${ref.name}=…)`, lineOf(token));
      }
    }
    for (const c of opts.checks?.captures ?? []) captured.add(c.name);
  }

  // A signed runbook whose blocks changed since signing.
  const signed = signedStatus(text);
  if (signed) {
    // The front matter isn't signed: servers run the signed blocks in bash, elsewhere they'd run in this shell.
    const unix = fm?.shell?.unix;
    if (unix && unix !== 'bash') {
      const at = text.replace(/^﻿/, '').split(/\r?\n/).findIndex((l) => /^shell\s*:/i.test(l));
      problems.push({
        severity: 'warning',
        line: Math.max(0, at),
        message: `front matter shell: ${unix} in a signed runbook: servers run its signed blocks in bash, and without the gate they would run in ${unix}`,
      });
    }
    for (const loc of locs.filter((l) => signed.changed.includes(l.cellIndex))) {
      problems.push({
        severity: 'warning',
        line: loc.line,
        cell: { index: loc.cellIndex },
        message: 'block changed since the runbook was signed: servers that only run signed runbooks refuse it (sign the runbook again)',
      });
    }
    for (const loc of locs.filter((l) => signed.moved.includes(l.cellIndex))) {
      problems.push({
        severity: 'warning',
        line: loc.line,
        cell: { index: loc.cellIndex },
        message: `block moved since the runbook was signed: it was signed as block ${signed.cells.get(loc.cellIndex)!.n}, after blocks that now come later`,
      });
    }
    // Signed blocks not in the file unchanged: deleted, or changed (then also reported above).
    if (signed.missing.length > 0) {
      const at = text.split(/\r?\n/).findIndex((l) => l.startsWith('<!-- md-runbook:signature'));
      problems.push({
        severity: 'warning',
        line: Math.max(0, at),
        message: `signed block${signed.missing.length === 1 ? '' : 's'} ${signed.missing.join(', ')} of ${signed.manifest.cells.length} not in the file as signed (deleted or changed since signing)`,
      });
    }
  } else {
    // A block-shaped line inside code is an example, not the signature (as readSignature reads it).
    let open: FenceOpen | null = null;
    const at = text.split(/\r?\n/).findIndex((l) => {
      if (open) {
        if (isFenceClose(l, open)) open = null;
        return false;
      }
      open = matchFenceOpen(l);
      return open === null && l.startsWith('<!-- md-runbook:signature');
    });
    if (at >= 0) problems.push({ severity: 'error', line: at, message: 'the signature block is damaged (sign the runbook again)' });
  }
  return problems.sort((a, b) => a.line - b.line);
}

/** `file:line: error: message`, the format editors and CI systems link to. */
export function formatProblem(file: string, p: LintProblem): string {
  return `${file}:${p.line + 1}: ${p.severity}: ${p.message}`;
}

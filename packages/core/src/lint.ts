/**
 * Static checks on a runbook, before anything runs: invalid or unknown cell options, `every=`
 * without `retry=`, `${out:NAME}` with no earlier `capture=NAME`, `${param:NAME}` not declared
 * in the front matter, a name used as two kinds of placeholder, front matter values that are
 * ignored, blocks changed since the runbook was signed. Used by `md-runbook lint` and by the
 * editor's problem markers.
 */

import { cellRefs, parseCellOptions, tokenizeInfo } from './cellOptions';
import { FenceOpen, isFenceClose, matchFenceOpen } from './fence';
import { isCodeMeta } from './model';
import { parse } from './parser';
import { CodeCellLocation, locateCodeCells } from './locate';
import { FRONT_MATTER_ENV_ENTRY, findRefs, parseFrontMatter } from './secrets';
import { POWERSHELLS, UNIX_SHELLS, parseShells, shellKindForLanguage } from './shellKind';
import { signedStatus } from './signing';
import { CALL_OPTIONS, NOT_ON_A_CALL, callRefs, checkCall, isCallLanguage, isDynamicSrc, parseCall, srcGlob } from './call';

export type LintSeverity = 'error' | 'warning';

export interface LintProblem {
  severity: LintSeverity;
  message: string;
  /** 0-based line in the file. */
  line: number;
  /** For problems inside a code block: its cell index and the 0-based line in its source (undefined: the fence line). */
  cell?: { index: number; sourceLine?: number };
  /** An unknown option that looks like a typo: rename `option` to `to` on the fence line (renameInfoOption). */
  fix?: { option: string; to: string };
}

const KNOWN_OPTIONS = new Set([
  // cellOptions.ts
  'timeout', 'estimate', 'cwd', 'continue-on-error', 'skip', 'confirm', 'no-confirm', 'terminal', 'name',
  'expect', 'expect-not', 'expect-exit', 'capture', 'capture-secret', 'os', 'host', 'kube-context', 'lines', 'retry', 'every',
  // proposal.ts (assistant proposals and approvals)
  'proposed', 'by', 'reason', 'approved', 'approved-by', 'approved-at',
]);

const LANG_RE = /^\s*[^\s{]*/;

/** Edits from `a` to `b`: inserting, deleting or changing a letter, or swapping two neighbours (retires/retries). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The known option an unknown one was probably meant to be: one or two letters off (one for short
 * names), its plural counting as the option (retries, timeouts), and only when one option is
 * nearest. Undefined otherwise.
 */
export function suggestOption(key: string): string | undefined {
  const k = key.toLowerCase();
  const max = k.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Infinity;
  let tie = false;
  for (const option of KNOWN_OPTIONS) {
    const plural = option.endsWith('y') ? `${option.slice(0, -1)}ies` : `${option}s`;
    const distance = Math.min(editDistance(k, option), editDistance(k, plural));
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
      tie = false;
    } else if (distance === bestDistance) {
      tie = true;
    }
  }
  return best !== undefined && bestDistance <= max && !tie ? best : undefined;
}

/**
 * Variables that change what every cell runs, not only how: a front matter that sets them takes
 * over each command (the front matter isn't signed). Warned about, not refused: on your own
 * machine whoever edits the front matter can edit the cells too.
 */
const RISKY_ENV = /^(PATH|BASH_ENV|ENV|IFS|PROMPT_COMMAND|PS4|SHELLOPTS|BASHOPTS|CDPATH|LD_\w+|DYLD_\w+|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|GIT_SSH_COMMAND|GIT_EXEC_PATH)$/i;

/** `env:` in the front matter (lines 1 to end-1): entries that are ignored, risky names, a signed runbook. */
function lintFrontMatterEnv(lines: string[], end: number, signed: boolean): LintProblem[] {
  const problems: LintProblem[] = [];
  const start = lines.findIndex((l, i) => i > 0 && i < end && /^env\s*:/i.test(l));
  if (start < 0) return problems;
  if (!/^env\s*:\s*(#.*)?$/i.test(lines[start]!)) {
    problems.push({ severity: 'warning', line: start, message: 'front matter env: is ignored: write each variable on its own indented line below it (  NAME: value)' });
    return problems;
  }
  const seen = new Set<string>();
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) break; // the next top-level key
    const entry = FRONT_MATTER_ENV_ENTRY.exec(line);
    if (!entry) {
      problems.push({ severity: 'warning', line: i, message: `front matter env: "${line.trim()}" is ignored (expected NAME: value, the name letters, digits and _)` });
      continue;
    }
    const name = entry[1]!;
    if (seen.has(name)) {
      problems.push({ severity: 'warning', line: i, message: `front matter env: ${name} is set twice: the first one counts` });
      continue;
    }
    seen.add(name);
    if (RISKY_ENV.test(name)) {
      problems.push({
        severity: 'warning',
        line: i,
        message: `front matter env: ${name} changes what every cell runs, and the front matter isn't signed: set it on the cells that need it (env.${name}=)`,
      });
    }
  }
  if (signed && seen.size > 0) {
    problems.push({
      severity: 'warning',
      line: start,
      message: "front matter env: is used in VS Code and the command line only: the md-runbook app doesn't use it for a signed runbook's cells (the front matter isn't signed); put what a host needs on the cells (env.NAME=)",
    });
  }
  return problems;
}

export interface LintOptions {
  /**
   * The text of a runbook a call's static src= names (relative to the file linted), or undefined
   * when there is no such file. Without it, calls are checked without reading what they call.
   */
  readRunbook?(src: string): string | undefined;
  /** For a src= with placeholders: the files its glob matches today (releases/*.md). */
  matchRunbooks?(glob: string): string[];
}

export function lintRunbook(text: string, options: LintOptions = {}): LintProblem[] {
  const problems: LintProblem[] = [];
  const doc = parse(text);
  const locs = locateCodeCells(doc);

  // Front matter values that were written but not understood.
  const fm = parseFrontMatter(text);
  if (fm) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    for (let i = 1; i < end; i++) {
      const m = /^(mode|timeout|cwd|kube-context|kube-context-mode|git-bash-path-conversion)\s*:\s*(.*?)\s*(#.*)?$/i.exec(lines[i]!);
      if (!m) continue;
      const key = m[1]!.toLowerCase();
      const ignored =
        (key === 'mode' && fm.mode === undefined) ||
        (key === 'timeout' && fm.timeoutSeconds === undefined) ||
        (key === 'cwd' && fm.cwd === undefined) ||
        (key === 'kube-context' && fm.kubeContext === undefined) ||
        (key === 'kube-context-mode' && fm.kubeContextMode === undefined) ||
        (key === 'git-bash-path-conversion' && fm.gitBashPathConversion === undefined);
      if (ignored) {
        const expected: Record<string, string> = {
          mode: 'session or isolated',
          timeout: 'seconds, e.g. 300',
          cwd: 'a folder',
          'kube-context': 'a Kubernetes context name, e.g. prod-eu, or ${param:NAME}',
          'kube-context-mode': 'check or pin',
          'git-bash-path-conversion': 'on or off',
        };
        problems.push({ severity: 'warning', line: i, message: `front matter ${key}: "${m[2]}" is ignored (expected ${expected[key]})` });
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
    problems.push(...lintFrontMatterEnv(lines, end, signedStatus(text) !== undefined));
  }
  // kube-context-mode: pin sets KUBECONFIG for cells run on this machine; on an SSH host the context is only checked.
  const pin = fm?.kubeContextMode === 'pin';
  const pinLine = (): number => Math.max(0, text.replace(/^﻿/, '').split(/\r?\n/).findIndex((l) => /^kube-context-mode\s*:/i.test(l)));
  if (pin && !fm?.kubeContext && !locs.some((l) => parseCellOptions(l.info).kubeContext !== undefined)) {
    problems.push({ severity: 'warning', line: pinLine(), message: 'front matter kube-context-mode: pin has no effect: no kube-context: in the front matter and no kube-context= on a block' });
  }
  if (pin && fm?.practice) {
    problems.push({
      severity: 'warning',
      line: pinLine(),
      message: `front matter kube-context-mode: pin doesn't apply on the practice host ${fm.practice}: there the Kubernetes context is only checked`,
    });
  }
  const declared = new Set((fm?.params ?? []).map((p) => p.name));
  const captured = new Set<string>();

  for (const loc of locs) {
    const cell = doc.cells[loc.cellIndex]!;
    if (isCodeMeta(cell.meta) && isCallLanguage(loc.language)) {
      problems.push(...lintCall(loc, declared, captured, options));
      for (const c of parseCellOptions(loc.info).checks?.captures ?? []) captured.add(c.name);
      continue;
    }
    if (!isCodeMeta(cell.meta) || !shellKindForLanguage(loc.language)) continue;
    const at = (severity: LintSeverity, message: string, sourceLine?: number, fix?: LintProblem['fix']): void =>
      void problems.push({
        severity,
        message,
        line: sourceLine === undefined ? loc.line : loc.line + 1 + sourceLine,
        cell: { index: loc.cellIndex, ...(sourceLine !== undefined ? { sourceLine } : {}) },
        ...(fix ? { fix } : {}),
      });

    const opts = parseCellOptions(loc.info);
    for (const e of opts.errors) at('error', `invalid cell option ${e}`);
    const rest = loc.info.replace(LANG_RE, '');
    for (const t of tokenizeInfo(rest)) {
      const key = t.key.toLowerCase();
      if (KNOWN_OPTIONS.has(key) || (key.startsWith('env.') && key.length > 4)) continue;
      const meant = suggestOption(key);
      if (meant) at('warning', `unknown cell option "${t.key}" (ignored): did you mean "${meant}"?`, undefined, { option: t.key, to: meant });
      else at('warning', `unknown cell option "${t.key}" (ignored)`);
    }
    if (/(^|\s)every=/i.test(rest) && !opts.retry) at('warning', 'every= has no effect without retry=');
    if (opts.host && fm?.env) {
      at('warning', `front matter env: doesn't apply on the host ${opts.host}: there the cell gets only its own env.NAME= variables`);
    }
    const kubeContext = opts.kubeContext ?? fm?.kubeContext;
    if (pin && opts.host && kubeContext) {
      at('warning', `kube-context-mode: pin doesn't apply on the host ${opts.host}: there kubectl's current context must already be ${kubeContext} (only checked)`);
    }

    let refs: ReturnType<typeof findRefs> = [];
    try {
      // The checks' too (expect="${out:NAME}"): those are reported on the fence line.
      refs = cellRefs(loc.source, loc.info, fm);
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
    if (signed.missingCalls.length > 0) {
      problems.push({
        severity: 'warning',
        line: Math.max(0, signatureLine(text)),
        message: `signed runbook call${signed.missingCalls.length === 1 ? '' : 's'} ${signed.missingCalls.join(', ')} of ${signed.manifest.calls.length} not in the file as signed (deleted or changed since signing)`,
      });
    }
    // Signed blocks not in the file unchanged: deleted, or changed (then also reported above).
    if (signed.missing.length > 0) {
      problems.push({
        severity: 'warning',
        line: Math.max(0, signatureLine(text)),
        message: `signed block${signed.missing.length === 1 ? '' : 's'} ${signed.missing.join(', ')} of ${signed.manifest.cells.length} not in the file as signed (deleted or changed since signing)`,
      });
    }
  } else {
    const at = signatureLine(text);
    if (at >= 0) problems.push({ severity: 'error', line: at, message: 'the signature block is damaged (sign the runbook again)' });
  }
  return problems.sort((a, b) => a.line - b.line);
}

/** A runbook call: its options and body, its placeholders, and what it passes against what it calls. */
function lintCall(loc: CodeCellLocation, declared: ReadonlySet<string>, captured: ReadonlySet<string>, options: LintOptions): LintProblem[] {
  const problems: LintProblem[] = [];
  const at = (severity: LintSeverity, message: string, sourceLine?: number, fix?: LintProblem['fix']): void =>
    void problems.push({
      severity,
      message,
      line: sourceLine === undefined ? loc.line : loc.line + 1 + sourceLine,
      cell: { index: loc.cellIndex, ...(sourceLine !== undefined ? { sourceLine } : {}) },
      ...(fix ? { fix } : {}),
    });
  const opts = parseCellOptions(loc.info);
  for (const e of opts.errors) at('error', `invalid cell option ${e}`);
  for (const t of tokenizeInfo(loc.info.replace(LANG_RE, ''))) {
    const key = t.key.toLowerCase();
    if (NOT_ON_A_CALL.has(key) || key.startsWith('env.')) {
      at('warning', `${t.key}= has no effect on a runbook call (ignored): it runs no shell of its own; put it on the blocks of the runbook called`);
      continue;
    }
    if (KNOWN_OPTIONS.has(key) || CALL_OPTIONS.has(key)) continue;
    const meant = suggestOption(key) ?? (['source', 'file', 'path', 'srcs'].includes(key) ? 'src' : ['sections', 'part'].includes(key) ? 'section' : undefined);
    if (meant) at('warning', `unknown cell option "${t.key}" (ignored): did you mean "${meant}"?`, undefined, { option: t.key, to: meant });
    else at('warning', `unknown cell option "${t.key}" (ignored)`);
  }
  const call = parseCall(loc.info, loc.source);
  for (const p of call.problems) at('error', p.message, p.line);
  let refs: ReturnType<typeof callRefs> = [];
  try {
    refs = callRefs(call);
  } catch (e) {
    at('error', e instanceof Error ? e.message : String(e));
  }
  const lineOf = (needle: string): number | undefined => call.args.find((a) => a.value.includes(needle))?.line;
  for (const ref of refs) {
    const token = '${' + ref.kind + ':' + ref.name;
    if (ref.kind === 'out' && !captured.has(ref.name)) {
      at('error', `\${out:${ref.name}} is not captured by an earlier block (add capture=${ref.name} to the block that prints it)`, lineOf(token));
    }
    if (ref.kind === 'param' && !declared.has(ref.name)) {
      at('warning', `\${param:${ref.name}} is not declared in the front matter params: (it has no default, and the command line needs --param ${ref.name}=…)`, lineOf(token));
    }
  }
  if (call.src === undefined) return problems;
  if (isDynamicSrc(call.src)) {
    const glob = srcGlob(call.src);
    const matches = options.matchRunbooks?.(glob);
    if (matches && matches.length === 0) at('warning', `src="${call.src}": no runbook matches ${glob} yet`);
    return problems;
  }
  if (!options.readRunbook) return problems;
  const child = options.readRunbook(call.src);
  if (child === undefined) {
    at('error', `src="${call.src}": no such runbook (relative to this file)`);
    return problems;
  }
  const check = checkCall(call, child);
  for (const a of check.unknown) at('error', `${a.name}: the runbook called (${call.src}) has no parameter ${a.name}`, a.line);
  for (const name of check.notPassed) at('warning', `${call.src} needs \${param:${name}}, which this call doesn't pass and which has no default: it will be asked (on the command line: an error)`);
  for (const m of check.sections) at('error', m);
  for (const t of check.manualOnly) {
    at('warning', `section="${t}" holds manual steps only (task-list items): the command line runs none of it, and a runbook that keeps evidence fails until they are ticked`);
  }
  return problems;
}

/**
 * The line of the signature block: the last one outside code, as readSignature reads it (a
 * block-shaped line inside code is an example). -1 when there is none.
 */
function signatureLine(text: string): number {
  let open: FenceOpen | null = null;
  let at = -1;
  text.split(/\r?\n/).forEach((l, i) => {
    if (open) {
      if (isFenceClose(l, open)) open = null;
    } else {
      open = matchFenceOpen(l);
      if (open === null && l.startsWith('<!-- md-runbook:signature')) at = i;
    }
  });
  return at;
}

/** `file:line: error: message`, the format editors and CI systems link to. */
export function formatProblem(file: string, p: LintProblem): string {
  return `${file}:${p.line + 1}: ${p.severity}: ${p.message}`;
}

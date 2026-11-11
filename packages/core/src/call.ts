/**
 * Runbook calls: a ```runbook block runs another runbook file as one step of this one.
 *
 *   ```runbook name="Apply the release" src="releases/${param:TO}.runbook.md" section="Part B"
 *   ENV=${param:ENV}
 *   BACKUP_DIR=${out:BACKUP_DIR}
 *   ```
 *
 * `src=` is the child's path, relative to the calling file; it may use `${param:}` and `${out:}`.
 * The body passes the child's parameters, one `NAME=value` per line (blank lines and `#` comments
 * are allowed); values may use `${param:}`, `${out:}`, `${input:}` and `${secret:}`. `section=`
 * runs only the steps under headings starting with it (repeatable), as `md-runbook run --section`.
 *
 * The child runs as a copy (`<child>.<yyyyMMdd-HHmmss>.md`), in a session of its own, with only the
 * parameters passed. This module is the platform-neutral part: parsing, the checks before a run,
 * and the call's output; running is in the CLI and the extension.
 */

import { tokenizeInfo } from './cellOptions';
import { RefKind, VAR_NAME_RE, VarRef, findRefs, parseFrontMatter, replaceRefs } from './secrets';
import { inSections, missingSections, sectionHeadings, sectionOnTitle } from './sections';
import { locateCodeCells } from './locate';
import { parse } from './parser';
import { taskItems } from './progress';

/** The fence language of a runbook call. */
export const CALL_LANGUAGE = 'runbook';

/** How deep calls may nest: a runbook that calls one that calls one (3 files below the first). */
export const MAX_CALL_DEPTH = 3;

/** Cell options of a call, besides those shared with other blocks (name, confirm, timeout, …). */
export const CALL_OPTIONS: ReadonlySet<string> = new Set(['src', 'section']);

/** Options that mean nothing on a call: it runs no shell of its own. */
export const NOT_ON_A_CALL: ReadonlySet<string> = new Set([
  'cwd',
  'expect',
  'expect-not',
  'expect-exit',
  'capture',
  'capture-secret',
  'retry',
  'every',
  'terminal',
  'host',
  'lines',
  'os',
]);

export function isCallLanguage(lang: string): boolean {
  return lang === CALL_LANGUAGE;
}

export interface CallArg {
  name: string;
  /** As written, without surrounding quotes. */
  value: string;
  /** 0-based line in the block. */
  line: number;
}

export interface CallProblem {
  message: string;
  /** 0-based line in the block; undefined: the fence line. */
  line?: number;
}

export interface RunbookCall {
  /** src= as written. */
  src?: string;
  /** section= values, in order. */
  sections: string[];
  args: CallArg[];
  /** Body lines that aren't NAME=value, names given twice, placeholders src= can't use. */
  problems: CallProblem[];
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

/** A call's options and parameters, from its fence info string and its body. */
export function parseCall(info: string, source: string): RunbookCall {
  const call: RunbookCall = { sections: [], args: [], problems: [] };
  for (const t of tokenizeInfo(info.replace(/^\s*[^\s{]*/, ''))) {
    const k = t.key.toLowerCase();
    if (k === 'src') {
      if (t.value === undefined || t.value.trim() === '') call.problems.push({ message: 'src= is empty: give the runbook to run, relative to this file' });
      else call.src = t.value.trim();
    } else if (k === 'section') {
      if (t.value === undefined || t.value.trim() === '') call.problems.push({ message: 'section= is empty: give the start of a heading of the runbook called' });
      else call.sections.push(t.value.trim());
    }
  }
  if (call.src === undefined && !call.problems.some((p) => p.message.startsWith('src='))) {
    call.problems.push({ message: 'a runbook call needs src=, the runbook to run (relative to this file)' });
  }
  if (call.src !== undefined) {
    try {
      for (const ref of findRefs(call.src)) {
        if (ref.kind === 'input' || ref.kind === 'secret') {
          call.problems.push({ message: `src= can't use \${${ref.kind}:${ref.name}}: use \${param:NAME} or \${out:NAME}` });
        }
      }
    } catch (e) {
      call.problems.push({ message: `src=: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  source.split(/\r?\n/).forEach((raw, line) => {
    const l = raw.trim();
    if (l === '' || l.startsWith('#')) return;
    const eq = l.indexOf('=');
    const name = eq < 0 ? l : l.slice(0, eq).trim();
    if (eq < 0 || !VAR_NAME_RE.test(name)) {
      call.problems.push({ line, message: `"${l}": expected NAME=value, a parameter of the runbook called (NAME letters, digits and _)` });
      return;
    }
    if (call.args.some((a) => a.name === name)) {
      call.problems.push({ line, message: `${name} is passed twice: the first one counts` });
      return;
    }
    call.args.push({ name, value: unquote(l.slice(eq + 1).trim()), line });
  });
  return call;
}

/** The placeholders a call uses (src= and the values), in order; throws on a name used as two kinds. */
export function callRefs(call: RunbookCall): VarRef[] {
  return findRefs([call.src ?? '', ...call.args.map((a) => a.value)].join('\n'));
}

/** `text` with each placeholder replaced by its value; undefined names the first one without a value. */
export function fillRefs(text: string, value: (kind: RefKind, name: string) => string | undefined): { text: string } | { missing: { kind: RefKind; name: string } } {
  let missing: { kind: RefKind; name: string } | undefined;
  const out = replaceRefs(text, (kind, name) => {
    const v = value(kind, name);
    if (v === undefined) missing ??= { kind, name };
    return v ?? '';
  });
  return missing ? { missing } : { text: out };
}

/** Whether src= depends on values known only at run time. */
export function isDynamicSrc(src: string): boolean {
  return /\$\{(param|out|input|secret):/.test(src);
}

/** src= as a glob: each placeholder becomes `*` (releases/${param:TO}.md → releases/*.md). */
export function srcGlob(src: string): string {
  return replaceRefs(src, () => '*');
}

/** Whether a resolved src= path stays inside its folder tree: relative, without `..` above it. */
export function staysBelow(src: string): boolean {
  if (/^([A-Za-z]:)?[\\/]/.test(src) || /^[A-Za-z]:/.test(src)) return false;
  let depth = 0;
  for (const part of src.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    depth += part === '..' ? -1 : 1;
    if (depth < 0) return false;
  }
  return true;
}

/** The parameters of a runbook: declared in its front matter, or used by its blocks. */
export function runbookParams(text: string): { declared: { name: string; default?: string }[]; used: Set<string> } {
  const declared = parseFrontMatter(text)?.params ?? [];
  const used = new Set<string>();
  for (const m of text.matchAll(/\$\{param:([A-Za-z_][A-Za-z0-9_]*)\}/g)) used.add(m[1]!);
  return { declared, used };
}

export interface CallCheck {
  /** Names passed that the runbook called has no parameter for. */
  unknown: CallArg[];
  /** Its parameters without a default that the call doesn't pass (asked, or an error on the command line). */
  notPassed: string[];
  /** section= values no heading starts with, or one that matches the title (every step). */
  sections: string[];
  /** section= values whose part holds manual steps (task-list items) and no block. */
  manualOnly: string[];
}

/** What a call passes against what the runbook called takes. */
export function checkCall(call: RunbookCall, child: string): CallCheck {
  const { declared, used } = runbookParams(child);
  const known = new Set([...declared.map((p) => p.name), ...used]);
  const passed = new Set(call.args.map((a) => a.name));
  const withDefault = new Set(declared.filter((p) => p.default !== undefined).map((p) => p.name));
  const headings = sectionHeadings(child);
  const missing = missingSections(headings, call.sections);
  const onTitle = sectionOnTitle(headings, call.sections);
  const blockLines = locateCodeCells(parse(child)).map((l) => l.line);
  const items = taskItems(child);
  const manualOnly = call.sections.filter((t) => {
    if (missing.includes(t)) return false;
    const inPart = inSections(headings, [t]);
    return !blockLines.some(inPart) && items.some((i) => inPart(i.line));
  });
  return {
    manualOnly,
    unknown: call.args.filter((a) => !known.has(a.name)),
    notPassed: [...known].filter((n) => !passed.has(n) && !withDefault.has(n)),
    sections: [
      ...missing.map((s) => `section="${s}": no heading of the runbook called starts with it`),
      ...(onTitle ? [`section="${onTitle.section}" matches the title "${onTitle.title}", which holds every step${onTitle.other ? `; for "${onTitle.other}", give more of it` : ''}`] : []),
    ],
  };
}

export interface CallResult {
  /** The runbook called, as resolved (relative to the calling file, `/` separators). */
  runbook: string;
  /** Its run copy, relative to the calling file. */
  copy: string;
  /** SHA-256 of the copy as written after the run (hex). */
  sha256: string;
  done: number;
  skipped: number;
  failed: number;
  /** Steps not run (after a failure, or cancelled). */
  notRun: number;
  /** Manual steps (task-list items) of the part run that are not ticked. */
  manual?: number;
}

/** "5 done, 1 skipped, 1 failed, 2 not run" */
export function formatCallSteps(r: Pick<CallResult, 'done' | 'skipped' | 'failed' | 'notRun' | 'manual'>): string {
  const parts = [`${r.done} done`];
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.notRun) parts.push(`${r.notRun} not run`);
  if (r.manual) parts.push(`${r.manual} manual not ticked`);
  return parts.join(', ');
}

/** The output block attributes of a call (with exit, ran, … from the run). */
export function callAttrs(r: CallResult): Record<string, string> {
  return { runbook: r.runbook, copy: r.copy, sha256: r.sha256, steps: formatCallSteps(r) };
}

/** The call's output text: what ran, where its record is, and how it went. */
export function callOutputText(r: CallResult, sections: readonly string[]): string {
  const part = sections.length ? ` (section${sections.length === 1 ? '' : 's'} ${sections.map((s) => `"${s}"`).join(', ')})` : '';
  return `[md-runbook] ran ${r.runbook}${part} as ${r.copy}\n[md-runbook] ${formatCallSteps(r)} · sha256 ${r.sha256}\n`;
}

/** A call's earlier result, from its output block's attributes (undefined: none, or not a call's). */
export function callFromAttrs(attrs: Readonly<Record<string, string>> | undefined): { runbook: string; copy: string; sha256?: string; exit?: string } | undefined {
  if (!attrs?.copy || !attrs.runbook) return undefined;
  return { runbook: attrs.runbook, copy: attrs.copy, ...(attrs.sha256 ? { sha256: attrs.sha256 } : {}), ...(attrs.exit ? { exit: attrs.exit } : {}) };
}

/** A cycle in a chain of calls (absolute paths, the first the runbook run), or the chain is too deep. */
export function callChainProblem(chain: readonly string[], next: string, same: (a: string, b: string) => boolean = (a, b) => a === b): string | undefined {
  const at = chain.findIndex((p) => same(p, next));
  if (at >= 0) return `a runbook call cycle: ${[...chain.slice(at), next].join(' → ')}`;
  if (chain.length > MAX_CALL_DEPTH) return `runbook calls nest more than ${MAX_CALL_DEPTH} deep: ${[...chain, next].join(' → ')}`;
  return undefined;
}

/**
 * The prose ratchet of `md-runbook lint` (core/prose.ts measured, per file): no Markdown file gets
 * harder to read than a baseline records, and a new one meets the rules. The baseline has the
 * shape of prose_ratchet.py's (a sister project's), so one file works with both:
 *
 *   { "docs/app.md": { "average": 16.2, "sentences": 3, "units": 1 } }
 *
 * plus `phrases` and `repeats` for the rules only md-runbook has (absent: 0). Only files with a
 * finding are recorded; any other file is held to 0, 0 and an average of 15.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { PROSE_LIMITS, ProseFinding, ProseOptions, ProseRule, measureProse, roundAverage } from '@md-runbook/core/prose';

/** A file's numbers, as recorded. */
export interface ProseNumbers {
  sentences: number;
  units: number;
  average: number;
  phrases?: number;
  repeats?: number;
}

type Key = 'sentences' | 'units' | 'phrases' | 'repeats';
const KEY_OF: Record<ProseRule, Key | undefined> = {
  'prose-sentence': 'sentences',
  'prose-paragraph': 'units',
  'prose-average': undefined,
  'prose-opener': 'phrases',
  'prose-announcing': 'phrases',
  'prose-padding': 'phrases',
  'prose-heading': 'phrases',
  'prose-repeat': 'repeats',
};
const KEYS: readonly Key[] = ['sentences', 'units', 'phrases', 'repeats'];

/** The config file at the repository root: {"exclude": ["CLAUDE.md", "tests/fixtures/**"]}. */
export const PROSE_CONFIG = '.md-runbook-prose.json';

/** A glob as fnmatch reads it (prose_ratchet.py): `*` and `**` match anything, `/` too; `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        const body = glob.slice(i + 1, end);
        re += `[${body.startsWith('!') ? '^' + body.slice(1) : body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface ProseConfig {
  /** Files left out: --exclude GLOB and the config file's "exclude". */
  exclude: string[];
  /** The config file's "skipLines" and "labels" (regexes): how this repository writes what isn't prose. */
  options: ProseOptions;
}

/**
 * The config: the flags and .md-runbook-prose.json in `cwd` (a bad config file is an error, not ignored):
 * {"exclude": [globs], "skipLines": [regexes], "labels": [regexes]}.
 */
export function proseConfig(excludeFlags: readonly string[], cwd = process.cwd()): ProseConfig {
  const file = path.join(cwd, PROSE_CONFIG);
  if (!fs.existsSync(file)) return { exclude: [...excludeFlags], options: {} };
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  const list = (key: string): string[] | undefined => {
    const v = data?.[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((e) => typeof e !== 'string'))) throw new Error(`${PROSE_CONFIG}: "${key}" must be a list of strings`);
    return v as string[] | undefined;
  };
  const regexes = (key: string): RegExp[] | undefined =>
    list(key)?.map((r) => {
      try {
        return new RegExp(r, 'u');
      } catch (e) {
        throw new Error(`${PROSE_CONFIG}: "${key}": ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  const skipLines = regexes('skipLines');
  const labels = regexes('labels');
  return { exclude: [...excludeFlags, ...(list('exclude') ?? [])], options: { ...(skipLines ? { skipLines } : {}), ...(labels ? { labels } : {}) } };
}

/** The Markdown files git tracks here (`git ls-files '*.md'`), but the excluded ones. */
export function trackedMarkdown(excludes: readonly string[], cwd = process.cwd()): string[] {
  const names = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
  const out = excludes.map(globToRegExp);
  return names.filter((n) => !out.some((r) => r.test(n))).sort();
}

/** A file's findings and numbers; none for `prose: off`. */
export function measureFile(text: string, options: ProseOptions = {}): { findings: ProseFinding[]; numbers: ProseNumbers; count: number } {
  if (parseFrontMatter(text)?.prose === 'off') return { findings: [], numbers: { sentences: 0, units: 0, average: 0 }, count: 0 };
  const m = measureProse(text, options);
  const numbers: ProseNumbers = { sentences: 0, units: 0, average: roundAverage(m.average) };
  for (const f of m.findings) {
    const key = KEY_OF[f.rule];
    if (key) numbers[key] = (numbers[key] ?? 0) + 1;
  }
  return { findings: m.findings, numbers, count: m.count };
}

const isRecorded = (n: ProseNumbers): boolean => KEYS.some((k) => (n[k] ?? 0) > 0) || n.average > PROSE_LIMITS.averageWords;
const NEW_FILE: ProseNumbers = { sentences: 0, units: 0, average: PROSE_LIMITS.averageWords };

/** What got worse in a file against its baseline (undefined: a new file, held to the rules). */
export function proseWorse(now: ProseNumbers, before: ProseNumbers | undefined): string[] {
  const limits = before ?? NEW_FILE;
  const was = (k: Key): number => limits[k] ?? 0;
  const problems: string[] = [];
  if (now.sentences > was('sentences')) problems.push(`${now.sentences} sentences over ${PROSE_LIMITS.sentenceWords} words (was ${was('sentences')})`);
  if (now.units > was('units')) {
    problems.push(`${now.units} paragraphs over ${PROSE_LIMITS.unitSentences} sentences or ${PROSE_LIMITS.unitWords} words (was ${was('units')})`);
  }
  if (now.average > Math.max(limits.average, PROSE_LIMITS.averageWords)) problems.push(`${now.average.toFixed(1)} words a sentence on average (was ${limits.average.toFixed(1)})`);
  if ((now.phrases ?? 0) > was('phrases')) problems.push(`${now.phrases} phrases to cut (was ${was('phrases')})`);
  if ((now.repeats ?? 0) > was('repeats')) problems.push(`${now.repeats} sentences said twice (was ${was('repeats')})`);
  return problems;
}

/** Which findings a problem of proseWorse is about (to list them). */
function worseRules(now: ProseNumbers, before: ProseNumbers | undefined): Set<Key | 'average'> {
  const limits = before ?? NEW_FILE;
  const keys = new Set<Key | 'average'>(KEYS.filter((k) => (now[k] ?? 0) > (limits[k] ?? 0)));
  if (now.average > Math.max(limits.average, PROSE_LIMITS.averageWords)) keys.add('average');
  return keys;
}

/** The numbers recorded: never higher than before (a new file isn't recorded: it's held to the rules). */
function lowered(now: ProseNumbers, before: ProseNumbers | undefined): ProseNumbers {
  const limits = before ?? NEW_FILE;
  const n: ProseNumbers = {
    sentences: Math.min(now.sentences, limits.sentences),
    units: Math.min(now.units, limits.units),
    average: Math.min(now.average, Math.max(limits.average, PROSE_LIMITS.averageWords)),
  };
  for (const k of ['phrases', 'repeats'] as const) {
    const v = Math.min(now[k] ?? 0, limits[k] ?? 0);
    if (v > 0) n[k] = v;
  }
  return n;
}

/** JSON as Python's json.dumps(indent=1, sort_keys=True) writes it, so both tools write the same bytes. */
export function formatBaseline(baseline: Record<string, ProseNumbers>): string {
  const names = Object.keys(baseline).sort();
  if (names.length === 0) return '{}\n';
  const num = (k: string, v: number): string => (k === 'average' && Number.isInteger(v) ? v.toFixed(1) : String(v));
  const entry = (n: ProseNumbers): string => {
    const keys = Object.keys(n).sort() as Array<keyof ProseNumbers>;
    return `{\n${keys.map((k) => `  ${JSON.stringify(k)}: ${num(k, n[k]!)}`).join(',\n')}\n }`;
  };
  return `{\n${names.map((name) => ` ${JSON.stringify(name)}: ${entry(baseline[name]!)}`).join(',\n')}\n}\n`;
}

function readBaseline(file: string): Record<string, ProseNumbers> {
  const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('expected {"path": {"sentences": n, "units": n, "average": x}}');
  for (const [name, n] of Object.entries(data as Record<string, unknown>)) {
    const ok = typeof n === 'object' && n !== null && ['sentences', 'units', 'average'].every((k) => typeof (n as Record<string, unknown>)[k] === 'number');
    if (!ok) throw new Error(`${name}: expected {"sentences": n, "units": n, "average": x}`);
  }
  return data as Record<string, ProseNumbers>;
}

const relative = (file: string): string => path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export interface RatchetOptions {
  baseline: string;
  update: boolean;
  /** The files given; none: the tracked Markdown files. */
  files: readonly string[];
  config: ProseConfig;
  out(line: string): void;
  /** Where the Markdown summary is appended ($GITHUB_STEP_SUMMARY). */
  summary?: string;
}

/** `md-runbook lint --prose-baseline FILE`: 1 when a file got harder to read, 2 for a bad baseline. */
export function proseRatchet(o: RatchetOptions): number {
  let before: Record<string, ProseNumbers> | undefined;
  if (fs.existsSync(o.baseline)) {
    try {
      before = readBaseline(o.baseline);
    } catch (e) {
      o.out(`${o.baseline}: error: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  } else if (!o.update) {
    o.out(`${o.baseline}: error: no such file (record one with --update-baseline)`);
    return 2;
  }
  const out = o.config.exclude.map(globToRegExp);
  const names = (o.files.length > 0 ? o.files.map(relative) : trackedMarkdown([])).filter((n) => !out.some((r) => r.test(n)));
  const current = new Map<string, ReturnType<typeof measureFile>>();
  let missing = false;
  for (const name of names) {
    if (!fs.existsSync(name)) {
      o.out(`${name}: error: no such file`);
      missing = true;
      continue;
    }
    current.set(name, measureFile(fs.readFileSync(name, 'utf8'), o.config.options));
  }
  let limits: Record<string, ProseNumbers> = before ?? {};
  if (o.update) {
    const next: Record<string, ProseNumbers> = {};
    for (const [name, m] of current) {
      const n = before === undefined ? m.numbers : lowered(m.numbers, before[name]);
      if (isRecorded(n)) next[name] = n;
    }
    // Files not checked this time keep their numbers while they exist.
    for (const [name, n] of Object.entries(before ?? {})) if (!current.has(name) && fs.existsSync(name)) next[name] = n;
    fs.writeFileSync(o.baseline, formatBaseline(next));
    o.out(`recorded ${plural(Object.keys(next).length, 'file')} in ${o.baseline}`);
    limits = next;
  }
  const failed: Array<[string, string[]]> = [];
  for (const [name, m] of current) {
    const problems = proseWorse(m.numbers, limits[name]);
    if (problems.length === 0) continue;
    failed.push([name, problems]);
    const rules = worseRules(m.numbers, limits[name]);
    for (const f of m.findings) {
      const key = KEY_OF[f.rule] ?? 'average';
      if (rules.has(key)) o.out(`${name}:${f.line + 1}: ${f.message}`);
    }
  }
  const recorded = [...current].filter(([, m]) => isRecorded(m.numbers));
  const better = o.update
    ? []
    : Object.keys(before ?? {}).filter((name) => {
        const m = current.get(name);
        if (!m) return !fs.existsSync(name); // deleted: its entry can go
        const b = before![name]!;
        return KEYS.some((k) => (m.numbers[k] ?? 0) < (b[k] ?? 0)) || m.numbers.average < b.average || !isRecorded(m.numbers);
      });
  const lines: string[] = [];
  if (failed.length > 0) {
    lines.push(`❌ prose: ${plural(failed.length, 'file')} harder to read than before`);
    for (const [name, problems] of failed) lines.push(`- ${name}: ${problems.join('; ')}`);
    lines.push('', `See each finding: md-runbook lint --prose-show '${failed[0]![0]}'`);
  } else {
    const left = recorded.reduce((a, [, m]) => a + m.numbers.sentences, 0);
    lines.push(`✅ prose: no file harder to read; ${left} long sentences left in ${plural(recorded.length, 'file')}`);
    if (better.length > 0) lines.push(`${plural(better.length, 'file')} got better: record them with --update-baseline`);
  }
  for (const l of lines) o.out(l);
  if (o.summary) fs.appendFileSync(o.summary, `## ${lines[0]}\n${lines.slice(1).join('\n')}\n`);
  return failed.length > 0 || missing ? 1 : 0;
}

/** `md-runbook lint --prose-show GLOB`: every prose finding of the tracked Markdown files matching GLOB. */
export function proseShow(glob: string, config: ProseConfig, out: (line: string) => void): number {
  const match = globToRegExp(glob);
  const names = trackedMarkdown(config.exclude).filter((n) => match.test(n));
  if (names.length === 0) {
    out(`no tracked Markdown file matches ${glob}`);
    return 1;
  }
  for (const name of names) {
    const m = measureFile(fs.readFileSync(name, 'utf8'), config.options);
    out(`${name}: ${plural(m.count, 'sentence')}, ${roundAverage(m.numbers.average).toFixed(1)} words on average`);
    for (const f of m.findings) {
      const at = `  ${name}:${f.line + 1}:`;
      if (f.rule === 'prose-sentence') out(`${at} ${f.words} words: ${(f.sentence ?? '').slice(0, 160)}`);
      else if (f.rule === 'prose-paragraph') out(`${at} a paragraph of ${f.sentences} sentences, ${f.words} words`);
      else out(`${at} ${f.message}`);
    }
  }
  return 0;
}

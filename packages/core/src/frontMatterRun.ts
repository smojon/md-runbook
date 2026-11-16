/**
 * Front matter next to a version 1 signature. Such a signature covers the bash blocks only, not
 * the front matter. So a runbook signed that way counts as signed (the command line's signed runs,
 * VS Code and app links) only while its front matter changes nothing about how it runs.
 *
 * An allow-list: only the keys of V1_HARMLESS_KEYS may be there. Any other key, known now or added
 * later (`env:`, `practice:`, `report-runs:`, `manual-steps:`, `git-bash-path-conversion:`, …), or
 * a line that is no key, means the runbook is not signed as it would run. Before, a list of seven
 * keys to refuse missed some (security review, round 4).
 */
import { frontMatterLines, parseFrontMatter } from './secrets';

/**
 * Keys that only label the runbook or its record and never change what runs, where, with which
 * values, or where results go: a title, description, tags, author or owner; the incident and its
 * severity; `evidence:` (more is recorded); a drill and its `rto:` (the report says so); `prose:`
 * (lint only). `params:` is allowed too, while no parameter has a default or choices.
 */
export const V1_HARMLESS_KEYS: readonly string[] = ['title', 'description', 'tags', 'author', 'owner', 'incident', 'severity', 'evidence', 'drill', 'rto', 'prose'];

/**
 * What the front matter has that a version 1 signature doesn't cover, as `env:`, `practice:`, …
 * in the order written; [] when nothing (or no front matter).
 */
export function v1FrontMatterProblems(text: string): string[] {
  const lines = frontMatterLines(text);
  if (!lines) return [];
  const out: string[] = [];
  const add = (s: string): void => void (out.includes(s) || out.push(s));
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    // Indented lines and `- item` lines belong to the key above them.
    if (/^\s/.test(line) || line.startsWith('-')) continue;
    const key = /^([A-Za-z0-9_-]+)[ \t]*:/.exec(line)?.[1]?.toLowerCase();
    if (key === undefined) add('a line that is no key');
    else if (key === 'params') {
      // A default fills a signed block's value in, choices limit what is asked: neither is signed.
      if ((parseFrontMatter(text)?.params ?? []).some((p) => p.default !== undefined || p.choices !== undefined)) add('params: (defaults or choices)');
    } else if (!V1_HARMLESS_KEYS.includes(key)) add(`${key}:`);
  }
  return out;
}

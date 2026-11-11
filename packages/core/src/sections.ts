/**
 * Sections of a runbook by heading, as `md-runbook run --section TEXT` and a runbook call's
 * `section=` select them: a block is in a section while a heading starting with TEXT is open
 * (until the next heading of its level or higher).
 */

import { isFenceClose, matchFenceOpen } from './fence';
import { splitLines } from './lines';

export interface SectionHeading {
  /** 0-based line. */
  line: number;
  level: number;
  /** After the `#`s and spaces, without a closing `#` sequence. */
  text: string;
}

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

/** The ATX headings of a runbook, outside the front matter and fenced blocks (code, outputs). */
export function sectionHeadings(text: string): SectionHeading[] {
  const lines = splitLines(text.replace(/^﻿/, '')).map((l) => l.text);
  const out: SectionHeading[] = [];
  let i = 0;
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const open = matchFenceOpen(lines[i]!);
    if (open) {
      while (i + 1 < lines.length && !isFenceClose(lines[i + 1]!, open)) i++;
      i++;
      continue;
    }
    const m = ATX_RE.exec(lines[i]!);
    if (!m) continue;
    const content = (m[2] ?? '').replace(/(^|[ \t]+)#+$/, '').trim();
    out.push({ line: i, level: m[1]!.length, text: content });
  }
  return out;
}

/** The sections no heading starts with (case-sensitive). */
export function missingSections(headings: readonly SectionHeading[], sections: readonly string[]): string[] {
  return sections.filter((t) => !headings.some((h) => h.text.startsWith(t)));
}

/**
 * A section that matches the runbook's title (its one top-level heading), which holds every step,
 * with a hint naming the heading probably meant; undefined when none does.
 */
export function sectionOnTitle(headings: readonly SectionHeading[], sections: readonly string[]): { section: string; title: string; other?: string } | undefined {
  if (headings.length < 2) return undefined;
  const top = Math.min(...headings.map((h) => h.level));
  const tops = headings.filter((h) => h.level === top);
  if (tops.length !== 1) return undefined;
  const title = tops[0]!;
  const t = sections.find((s) => title.text.startsWith(s));
  if (t === undefined) return undefined;
  const other = headings.find((h) => h !== title && h.text.startsWith(t))?.text;
  return { section: t, title: title.text, ...(other !== undefined ? { other } : {}) };
}

/** Whether a 0-based line is in one of the sections. */
export function inSections(headings: readonly SectionHeading[], sections: readonly string[]): (line: number) => boolean {
  return (line) => {
    const open: SectionHeading[] = [];
    for (const h of headings) {
      if (h.line >= line) break;
      while (open.length > 0 && open[open.length - 1]!.level >= h.level) open.pop();
      open.push(h);
    }
    return open.some((h) => sections.some((t) => h.text.startsWith(t)));
  };
}

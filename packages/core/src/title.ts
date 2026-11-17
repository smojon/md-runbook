/**
 * A runbook's title and its headings, read as a Markdown view shows them: not a `#` comment in the
 * YAML front matter, not a `#` line in a fenced code block.
 */
import { LINE_RE } from './lines';
import { isBlank } from './lineText';

/**
 * The runbook's text without its YAML front matter (`---` … `---` or `...` at the very top), as
 * VS Code's Markdown preview and the report leave it out.
 */
export function withoutFrontMatter(value: string): string {
  const m = /^﻿?---[ \t]*(?:\r\n?|\n)(?:[\s\S]*?(?:\r\n?|\n))?(?:---|\.\.\.)[ \t]*(?:\r\n?|\n|$)/.exec(value);
  return m ? value.slice(m[0].length) : value;
}

export interface Heading {
  /** 1 for `#`, 2 for `##`, … */
  level: number;
  text: string;
  /** 0-based line in the text given. */
  line: number;
}

export interface AtxHeading {
  /** 1 for `#`, 2 for `##`, … */
  level: number;
  /**
   * The text after the `#`s and the blanks that follow them, without trailing blanks and (with
   * `closing`) without a closing `#` sequence after a blank. '' for `#` alone or `#   `.
   */
  text: string;
  /** A blank follows the `#`s (`# Title`); false for a lone `#` … `######`. */
  blank: boolean;
}

/**
 * An ATX heading line (`## Step`, `## Step ##`): up to 3 spaces, 1 to 6 `#`, then a blank or the
 * line end. Read by hand in one pass, so a long line can't make it slow (a regular expression with
 * a lazy text and optional trailing groups took cubic time on a line of blanks ending in U+2028).
 * Anything else on the line, U+2028 and U+2029 included, is text.
 */
export function atxHeading(line: string, closing = true): AtxHeading | undefined {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let h = i;
  while (line[h] === '#') h++;
  const level = h - i;
  if (level < 1 || level > 6) return undefined;
  if (h < line.length && !isBlank(line[h])) return undefined;
  const blank = h < line.length;
  let start = h;
  while (isBlank(line[start])) start++;
  let end = line.length;
  while (end > start && isBlank(line[end - 1])) end--;
  const text = line.slice(start, end);
  return { level, text: closing ? withoutClosingHashes(text) : text, blank };
}

/**
 * Heading text without its closing sequence: the last run of `#` and the blanks before it, when
 * a blank comes before it and some text before that (`Step ##` → `Step`; `C#` and `##` stay).
 */
export function withoutClosingHashes(text: string): string {
  let q = text.length;
  while (q > 0 && text[q - 1] === '#') q--;
  if (q === text.length || q === 0 || !isBlank(text[q - 1])) return text;
  while (q > 0 && isBlank(text[q - 1])) q--;
  return text.slice(0, q);
}

/** ATX headings (`# Title`, `## Step #`) outside fenced code blocks, in order. */
export function headingsOf(markdown: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | undefined;
  markdown.split(LINE_RE).forEach((line, n) => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (open && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) fence = undefined;
      return;
    }
    if (open) {
      fence = open;
      return;
    }
    const h = atxHeading(line);
    const text = h?.blank ? h.text.trim() : '';
    if (h && text) out.push({ level: h.level, text, line: n });
  });
  return out;
}

/** The first `# heading` of the runbook (front matter and code blocks skipped), or undefined. */
export function runbookTitle(text: string): string | undefined {
  return headingsOf(withoutFrontMatter(text)).find((h) => h.level === 1)?.text;
}

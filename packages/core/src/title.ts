/**
 * A runbook's title and its headings, read as a Markdown view shows them: not a `#` comment in the
 * YAML front matter, not a `#` line in a fenced code block.
 */

/**
 * The runbook's text without its YAML front matter (`---` … `---` or `...` at the very top), as
 * VS Code's Markdown preview and the report leave it out.
 */
export function withoutFrontMatter(value: string): string {
  const m = /^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(value);
  return m ? value.slice(m[0].length) : value;
}

export interface Heading {
  /** 1 for `#`, 2 for `##`, … */
  level: number;
  text: string;
  /** 0-based line in the text given. */
  line: number;
}

/** ATX headings (`# Title`, `## Step #`) outside fenced code blocks, in order. */
export function headingsOf(markdown: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | undefined;
  markdown.split(/\r?\n/).forEach((line, n) => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (open && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) fence = undefined;
      return;
    }
    if (open) {
      fence = open;
      return;
    }
    const m = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    const text = m?.[2]?.trim();
    if (m && text) out.push({ level: m[1]!.length, text, line: n });
  });
  return out;
}

/** The first `# heading` of the runbook (front matter and code blocks skipped), or undefined. */
export function runbookTitle(text: string): string | undefined {
  return headingsOf(withoutFrontMatter(text)).find((h) => h.level === 1)?.text;
}

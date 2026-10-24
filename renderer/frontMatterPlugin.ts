/**
 * markdown-it plugin for Markdown cells: a runbook's YAML front matter (`---` … `---` at the top)
 * isn't drawn, as VS Code's Markdown preview and the app don't draw it either; its values act
 * where they are used (Values, Session). Editing the cell still shows it. Kept free of DOM and
 * VS Code APIs so it can be unit tested.
 */

/** The parts of markdown-it this plugin uses. */
interface Token {
  level: number;
  nesting: number;
  map: [number, number] | null;
}
interface StateCore {
  src: string;
  tokens: Token[];
}
export interface MarkdownIt {
  core: { ruler: { after(after: string, name: string, rule: (state: StateCore) => void): void } };
}

/**
 * A YAML line as front matter has them: `key: value`, a list item, an indented line, a comment.
 * A cell can't know whether it is the runbook's first one, so only such a block counts (a cell
 * that merely starts with a `---` rule and a paragraph is drawn as usual).
 */
const YAML_LINE = /^(?:\s*(?:#.*)?|[A-Za-z_][\w.-]*\s*:.*|\s*-(?:\s.*)?|\s+\S.*)$/;

/** Lines of the front matter (its closing `---` included), or 0 when the text has none. */
export function frontMatterLines(src: string): number {
  const lines = src.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i]!)) return i + 1;
    if (!YAML_LINE.test(lines[i]!)) return 0;
  }
  return 0; // never closed: not front matter
}

/**
 * Drops the tokens markdown-it made of the front matter (a rule, paragraphs or lists, a setext
 * heading of its last line), leaving the source as it is: a checkbox click sends the cell's
 * source, and line numbers stay right.
 */
export function frontMatterPlugin(md: MarkdownIt): void {
  md.core.ruler.after('block', 'mdrb_front_matter', (state) => {
    const end = frontMatterLines(state.src);
    if (end === 0) return;
    // The first top-level block that starts after the front matter; everything before it is the front matter.
    const keep = state.tokens.findIndex((t) => t.level === 0 && t.nesting !== -1 && t.map !== null && t.map[0] >= end);
    state.tokens.splice(0, keep < 0 ? state.tokens.length : keep);
  });
}

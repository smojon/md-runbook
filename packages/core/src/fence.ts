/** Fenced code block recognition (CommonMark-style, relaxed to allow any indentation for list items). */

export type FenceChar = '`' | '~';

export interface FenceOpen {
  indent: string;
  char: FenceChar;
  len: number;
  /** Everything after the fence characters, verbatim (may start with whitespace). */
  info: string;
}

const OPEN_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

export function matchFenceOpen(text: string): FenceOpen | null {
  const m = OPEN_RE.exec(text);
  if (!m) return null;
  const indent = m[1] ?? '';
  const fence = m[2] ?? '';
  const info = m[3] ?? '';
  const char = fence[0] as FenceChar;
  // A backtick fence's info string may not contain backticks (it would be inline code).
  if (char === '`' && info.includes('`')) return null;
  return { indent, char, len: fence.length, info };
}

export function isFenceClose(text: string, open: { char: FenceChar; len: number }): boolean {
  const m = CLOSE_RE.exec(text);
  if (!m) return false;
  const run = m[1] ?? '';
  return run[0] === open.char && run.length >= open.len;
}

const LANG_RE = /^(\s*)([^\s{]+)/;

/** The language of a fence: the first word of its info string, lower-cased ('' if none). */
export function langOf(info: string): string {
  const m = LANG_RE.exec(info);
  return m ? (m[2] ?? '').toLowerCase() : '';
}

/** Replace the language word in an info string, keeping any annotations after it. */
export function replaceLang(info: string, lang: string): string {
  const m = LANG_RE.exec(info);
  if (!m) return lang + info;
  return (m[1] ?? '') + lang + info.slice(m[0].length);
}

/**
 * Longest run of `char` among lines that, on their own, would close a fence of that char.
 * A fence must be longer than this to safely contain `lines`.
 */
export function longestClosingRun(lines: readonly string[], char: FenceChar): number {
  let max = 0;
  for (const line of lines) {
    const m = CLOSE_RE.exec(line);
    const run = m?.[1];
    if (run && run[0] === char) max = Math.max(max, run.length);
  }
  return max;
}

/** Remove up to `indent.length` leading whitespace characters (the fence's own indentation). */
export function stripIndent(text: string, indent: string): string {
  if (indent === '') return text;
  if (text.startsWith(indent)) return text.slice(indent.length);
  let k = 0;
  while (k < indent.length && k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
  return text.slice(k);
}

/** Prefix non-empty lines with `indent`. */
export function addIndent(line: string, indent: string): string {
  return line === '' ? line : indent + line;
}

/** Line splitting that keeps every line's exact terminator, so text can be rebuilt byte for byte. */

export type Eol = '\r\n' | '\n' | '\r' | '';
export type DocEol = '\r\n' | '\n';

export interface Line {
  text: string;
  /** The terminator that followed this line; '' only for a final line without a newline. */
  eol: Eol;
}

/**
 * A line ending as CommonMark reads it: CRLF, a lone CR or LF. Every reader of runbook text
 * splits lines with it (or splitLines), so all of md-runbook sees the lines the parser and GitHub
 * see. Before, some readers split on CRLF and LF only, and a lone CR hid the front matter from
 * them (security review, round 4).
 */
export const LINE_RE = /\r\n?|\n/;

export function splitLines(s: string): Line[] {
  const out: Line[] = [];
  const re = /\r\n|\n|\r/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({ text: s.slice(last, m.index), eol: m[0] as Eol });
    last = re.lastIndex;
  }
  if (last < s.length) {
    out.push({ text: s.slice(last), eol: '' });
  }
  return out;
}

export function joinRaw(lines: readonly Line[]): string {
  let s = '';
  for (const l of lines) {
    s += l.text + l.eol;
  }
  return s;
}

/** The most common of CRLF / LF in `lines`, or `fallback` when there are none. Ties go to LF. */
export function dominantEol(lines: readonly Line[], fallback: DocEol): DocEol {
  let crlf = 0;
  let lf = 0;
  for (const l of lines) {
    if (l.eol === '\r\n') crlf++;
    else if (l.eol === '\n') lf++;
  }
  if (crlf === 0 && lf === 0) return fallback;
  return crlf > lf ? '\r\n' : '\n';
}

/** The terminator at the end of a raw string ('' if none). */
export function trailingEol(raw: string): Eol {
  if (raw.endsWith('\r\n')) return '\r\n';
  if (raw.endsWith('\n')) return '\n';
  if (raw.endsWith('\r')) return '\r';
  return '';
}

export function endsWithNewline(s: string): boolean {
  return trailingEol(s) !== '';
}

/** Normalize any CRLF / lone CR to LF. */
export function toLf(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

export const BLANK_RE = /^[ \t]*$/;

/**
 * The index of the line that closes the front matter (`---` on the first line, up to the next
 * `---` or `...`), as parseFrontMatter reads it; -1 without one. `lines` without a BOM. GitHub
 * shows the front matter as a table, so nothing in it is code that runs (review, 2026-11-28).
 */
export function frontMatterCloseLine(lines: readonly string[]): number {
  if (lines[0]?.trimEnd() !== '---') return -1;
  for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) return i;
  return -1;
}

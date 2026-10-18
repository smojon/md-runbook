/** Line splitting that keeps every line's exact terminator, so text can be rebuilt byte for byte. */

export type Eol = '\r\n' | '\n' | '\r' | '';
export type DocEol = '\r\n' | '\n';

export interface Line {
  text: string;
  /** The terminator that followed this line; '' only for a final line without a newline. */
  eol: Eol;
}

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

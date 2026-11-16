/**
 * Notes for the record (Add Note, core formatNote), edited or deleted in the app. A note is its
 * marker (`<!-- md-runbook:note at=… by=… milestone=… -->`) and the quote under it, as VS Code
 * writes them. Edit keeps the marker and the quote's bold head (`**14:32 · mitigated · ana:**`)
 * and replaces the words; Delete takes the whole note out. A note is found by its marker, which
 * holds its time to the second, so a note is never mistaken for another one.
 *
 * Only notes outside code count: a note-shaped line in a code block (or any fenced block) is code
 * or an example, never edited. Edit and Delete look only in the Markdown cell the ⋯ came from.
 */
import { parse } from '@md-runbook/core';
import { type FenceOpen, isFenceClose, matchFenceOpen } from '@md-runbook/core/fence';

/** A note, as found in a text: where it is, its marker line, its head and its words. */
export interface NoteBlock {
  /** Offsets of the whole note (marker and quote) in the text. */
  start: number;
  end: number;
  /** The marker line, as written (what Edit and Delete find the note by). */
  marker: string;
  /** The quote's head, `**14:32 · mitigated · ana:**`, when it has one. */
  head?: string;
  /** The words, without the quote marks and the head. */
  text: string;
}

const NOTE_RE = /^([ \t]*<!--[ \t]*md-runbook:note\b.*?-->)[ \t]*(\r?\n)((?:[ \t]*>.*(?:\r?\n|$))*)/gm;
const HEAD_RE = /^(\*\*[^*]*:\*\*)\s*/;

/** The line breaks the core parser splits on, and Unicode's, which words may hold too. */
const LINE_BREAK_RE = /\r\n|\r|\n|\u2028|\u2029/;

/** Offsets of the lines of `text` in a fenced block, fence lines too (lines split as the core parser does). */
function fencedLineStarts(text: string): Set<number> {
  const fenced = new Set<number>();
  let open: FenceOpen | null = null;
  const re = /\r\n|\n|\r/g;
  let at = 0;
  for (;;) {
    const m = re.exec(text);
    const line = text.slice(at, m ? m.index : text.length);
    if (open) {
      fenced.add(at);
      if (isFenceClose(line, open)) open = null;
    } else {
      open = matchFenceOpen(line);
      if (open) fenced.add(at);
    }
    if (!m) return fenced;
    at = re.lastIndex;
  }
}

/** The notes of `text` outside fenced blocks, in order. */
export function findNotes(text: string): NoteBlock[] {
  const out: NoteBlock[] = [];
  const fenced = fencedLineStarts(text);
  for (const m of text.matchAll(NOTE_RE)) {
    if (fenced.has(m.index)) continue;
    const quote = (m[3] ?? '')
      .split(/\r?\n/)
      .filter((l, i, all) => i < all.length - 1 || l !== '')
      .map((l) => l.replace(/^[ \t]*>[ \t]?/, ''))
      .join('\n');
    const head = HEAD_RE.exec(quote)?.[1];
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      marker: m[1]!.trim(),
      ...(head ? { head } : {}),
      text: (head ? quote.replace(HEAD_RE, '') : quote).trim(),
    });
  }
  return out;
}

const eolOf = (text: string): string => (/\r\n/.test(text) ? '\r\n' : '\n');

/** Where Markdown cell `cellIndex`'s own text is in `text` (a code cell, or none: undefined). */
function markdownCellSpan(text: string, cellIndex: number): { start: number; end: number } | undefined {
  const doc = parse(text);
  let at = doc.meta.bom ? 1 : 0;
  for (const [i, { meta: m }] of doc.cells.entries()) {
    if (i === cellIndex) return m.kind === 'markup' ? { start: at + m.lead.length, end: at + m.lead.length + m.content.length } : undefined;
    at +=
      m.kind === 'code'
        ? (m.lead + m.open + m.body + m.close + (m.output?.raw ?? '') + (m.history?.raw ?? '') + m.trail).length
        : (m.lead + m.content + m.trail).length;
  }
  return undefined;
}

/** The note with `marker` in Markdown cell `cellIndex`, outside code, or undefined. */
function noteIn(text: string, cellIndex: number, marker: string): NoteBlock | undefined {
  const span = markdownCellSpan(text, cellIndex);
  if (!span) return undefined;
  // A note's end includes its line break, which may be the cell's trail.
  return findNotes(text).find((n) => n.marker === marker && n.start >= span.start && n.start < span.end);
}

/**
 * The text with the note whose marker is `marker`, in Markdown cell `cellIndex`, saying `words`
 * instead: its marker and head kept. Undefined when the note isn't there (any more) or `words` is
 * empty. Each line break in `words` starts a quote line: no word ends up outside the note.
 */
export function withNoteText(text: string, cellIndex: number, marker: string, words: string): string | undefined {
  const note = noteIn(text, cellIndex, marker);
  if (!note || words.trim() === '') return undefined;
  const lines = words.trim().split(LINE_BREAK_RE);
  const eol = eolOf(text);
  // As formatNote writes it: the head and the first line, then `> ` before each other line.
  const first = note.head ? `> ${note.head} ${lines[0]}` : `> ${lines[0]}`;
  const quote = [first, ...lines.slice(1).map((l) => `> ${l}`)].join(eol);
  // The note's own last line break stays (none when it ended the file).
  const ending = /\r?\n$/.test(text.slice(note.start, note.end)) ? eol : '';
  return text.slice(0, note.start) + note.marker + eol + quote + ending + text.slice(note.end);
}

/**
 * The text without the note whose marker is `marker`, in Markdown cell `cellIndex`, one blank line
 * where it was. Undefined when it isn't there.
 */
export function withoutNote(text: string, cellIndex: number, marker: string): string | undefined {
  const note = noteIn(text, cellIndex, marker);
  if (!note) return undefined;
  const eol = eolOf(text);
  const before = text.slice(0, note.start).replace(/(\r?\n)+$/, '');
  const after = text.slice(note.end).replace(/^(\r?\n)+/, '');
  if (before === '') return after;
  if (after === '') return before + eol;
  return before + eol + eol + after;
}

/** A Markdown cell in parts: its own Markdown, and the notes in it (drawn with a ⋯ each). */
export type NotePart = { kind: 'markdown'; markdown: string } | { kind: 'note'; markdown: string; note: NoteBlock };

export function noteParts(markdown: string): NotePart[] {
  const parts: NotePart[] = [];
  let at = 0;
  for (const note of findNotes(markdown)) {
    const before = markdown.slice(at, note.start);
    if (before.trim() !== '') parts.push({ kind: 'markdown', markdown: before });
    parts.push({ kind: 'note', markdown: markdown.slice(note.start, note.end), note });
    at = note.end;
  }
  const rest = markdown.slice(at);
  if (rest.trim() !== '' || parts.length === 0) parts.push({ kind: 'markdown', markdown: rest });
  return parts;
}

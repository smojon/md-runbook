/**
 * Notes for the record (Add Note, core formatNote), edited or deleted in the app. A note is its
 * marker (`<!-- md-runbook:note at=… by=… milestone=… -->`) and the quote under it, as VS Code
 * writes them. Edit keeps the marker and the quote's bold head (`**14:32 · mitigated · ana:**`)
 * and replaces the words; Delete takes the whole note out. A note is found by its marker, which
 * holds its time to the second, so a note is never mistaken for another one.
 */

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

/** The notes of `text`, in order. */
export function findNotes(text: string): NoteBlock[] {
  const out: NoteBlock[] = [];
  for (const m of text.matchAll(NOTE_RE)) {
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

/**
 * The text with the note whose marker is `marker` saying `words` instead: its marker and head
 * kept. Undefined when the note isn't there (any more) or `words` is empty.
 */
export function withNoteText(text: string, marker: string, words: string): string | undefined {
  const note = findNotes(text).find((n) => n.marker === marker);
  if (!note || words.trim() === '') return undefined;
  const lines = words.trim().split(/\r?\n/);
  const eol = eolOf(text);
  // As formatNote writes it: the head and the first line, then `> ` before each other line.
  const first = note.head ? `> ${note.head} ${lines[0]}` : `> ${lines[0]}`;
  const quote = [first, ...lines.slice(1).map((l) => `> ${l}`)].join(eol);
  // The note's own last line break stays (none when it ended the file).
  const ending = /\r?\n$/.test(text.slice(note.start, note.end)) ? eol : '';
  return text.slice(0, note.start) + note.marker + eol + quote + ending + text.slice(note.end);
}

/** The text without the note whose marker is `marker`, one blank line where it was. Undefined when it isn't there. */
export function withoutNote(text: string, marker: string): string | undefined {
  const note = findNotes(text).find((n) => n.marker === marker);
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

/**
 * Prose checks: keep a runbook's text short and simple. The rules and the way words are counted
 * follow the "Short and simple" style guide of a sister project (its prose_ratchet.py), so both
 * count the same: a sentence has at most 20 words, a paragraph or list item at most 3 sentences
 * and 60 words, a file averages at most 15 words a sentence. On top of that: openers and
 * announcements that say nothing, padding words, a first sentence that says its heading again,
 * and a sentence said twice.
 *
 * Prose is the text outside front matter, code blocks, HTML comments (md-runbook's own blocks:
 * output, signature, notes), tables, headings, images and raw HTML lines. A paragraph, a list
 * item and a quoted line are units; nested items are units of their own. A code span, a link or
 * a URL counts as one word. Whether a sentence is useful is not checked.
 *
 * Unlike prose_ratchet.py, fences are read as CommonMark reads them (a ```` fence holds ```
 * blocks; a ```` code span at a line start opens none), inline HTML comments are dropped, and
 * the quoted lines of an incident note are not prose.
 */

import { FenceOpen, isFenceClose, matchFenceOpen } from './fence';
import { isCodeMeta, type ParsedDocument } from './model';

export const PROSE_LIMITS = {
  sentenceWords: 20,
  averageWords: 15,
  unitSentences: 3,
  unitWords: 60,
  /** A shorter sentence may come back (a step such as "Check the logs."). */
  repeatWords: 6,
  /** The first sentence under a heading says it again: it has this share of the heading's content words… */
  headingShare: 0.7,
  /** …and adds at most this many content words of its own… */
  headingExtraWords: 4,
  /** …and the heading has at least this many content words. */
  headingMinWords: 2,
} as const;

/**
 * The phrases, in one place. Kept small: each one almost never carries information. Matched
 * case-insensitively; openers and announcements only at the start of a sentence.
 */
export const PROSE_PHRASES = {
  /** Delete the opener, keep the rest of the sentence. Longest first. */
  openers: [
    'it is important to note that',
    'it should be noted that',
    'please note that',
    'it is important to',
    'as mentioned earlier',
    'as mentioned before',
    'as mentioned above',
    'as noted above',
    'note that',
  ],
  /** The sentence only announces what comes next: delete it. */
  announcing: [
    /^this section (?:describes|explains|shows|covers|lists)\b/,
    /^the following (?:steps|sections?) (?:show|describe|explain|cover|list)\b/,
    /^in this section\b/,
  ],
  /** Words that add nothing: delete them. */
  padding: ['basically', 'simply', 'just', 'actually', 'really', 'very'],
  /** Not content words, when a sentence is compared with its heading. */
  stopWords: new Set(
    'the a an of to in on for and or is are this that with by it its your you how what'.split(' '),
  ),
  /** Wordy phrases and the short word to use instead. */
  wordy: [['in order to', 'to']] as ReadonlyArray<readonly [string, string]>,
};

/** On a line, or alone on the line before: the paragraph or list item isn't checked. */
export const PROSE_IGNORE = '<!-- md-runbook:prose-ignore -->';
const IGNORE_RE = /<!--\s*md-runbook:prose-ignore\s*-->/;

export type ProseRule =
  | 'prose-sentence'
  | 'prose-average'
  | 'prose-paragraph'
  | 'prose-opener'
  | 'prose-announcing'
  | 'prose-padding'
  | 'prose-heading'
  | 'prose-repeat';

export interface ProseFinding {
  rule: ProseRule;
  /** 0-based line in the file. */
  line: number;
  message: string;
  /** The sentence concerned, as it is read. */
  sentence?: string;
  /** Its words (a long sentence), or the unit's (a long paragraph). */
  words?: number;
  /** A long paragraph's sentences. */
  sentences?: number;
}

/** A paragraph, a list item or a quoted paragraph: its first line (0-based) and its text, one line per line. */
export interface ProseUnit {
  line: number;
  text: string;
  item: boolean;
  /** The heading right above, when this is the first unit under it. */
  heading?: string;
}

const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const QUOTE_RE = /^\s*>\s?/;
const NOTE_RE = /^[ \t]*<!--[ \t]*md-runbook:note\b/;
const RULE_RE = /^[-*_ ]{3,}$/;
/** A GitHub alert's marker line (`> [!NOTE]`): not prose; the quote's text after it is. */
const ALERT_RE = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i;

/**
 * A callout label at the start of a unit, dropped before counting: an optional emoji, a bold
 * label, then " · " (`🔑 **Key point** · `, `💡 **Did you know?** · `). The default of `labels`.
 */
export const DEFAULT_LABELS: readonly RegExp[] = [/^(?:(?:[⌀-➿⬀-⯿]|[\uD83C-\uD83E][\uDC00-\uDFFF])️?\s*)?\*\*[^*\n]+\*\*\s+·\s+/];

/** How a repository writes things that aren't prose (its .md-runbook-prose.json). */
export interface ProseOptions {
  /** A line matching one of these (after a quote mark, trimmed) is not prose: generated lines, e.g. /^\*⏱/. */
  skipLines?: readonly RegExp[];
  /** Dropped at the start of a unit before counting (callout labels). Default: DEFAULT_LABELS; [] none. */
  labels?: readonly RegExp[];
}

/** The prose of a runbook, as units. Lines inside a unit are joined with \n (a unit's lines are consecutive). */
export function proseUnits(text: string, options: ProseOptions = {}): ProseUnit[] {
  const skipLines = options.skipLines ?? [];
  const labels = options.labels ?? DEFAULT_LABELS;
  const unlabelled = (s: string): string => labels.reduce((t, r) => t.replace(r, ''), s);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let first = 0;
  if (lines[0]?.trimEnd() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) first = end + 1;
  }
  const found: ProseUnit[] = [];
  let current: (ProseUnit & { ignored: boolean }) | undefined;
  let fence: FenceOpen | null = null;
  let comment = false;
  /** In the quoted lines of an incident note (written during an incident, not the runbook's prose). */
  let note = false;
  let ignoreAt = -1;
  let heading: string | undefined;
  const close = (): void => {
    if (current && !current.ignored && current.text.trim()) {
      found.push({ line: current.line, text: current.text, item: current.item, ...(current.heading !== undefined ? { heading: current.heading } : {}) });
    }
    current = undefined;
  };
  for (let n = first; n < lines.length; n++) {
    const raw = lines[n]!;
    if (comment) {
      if (raw.includes('-->')) comment = false;
      continue;
    }
    if (fence) {
      if (isFenceClose(raw, fence)) fence = null;
      continue;
    }
    const open = matchFenceOpen(raw);
    if (open) {
      close();
      fence = open;
      note = false;
      continue;
    }
    if (raw.trimStart().startsWith('<!--')) {
      close();
      comment = !raw.includes('-->');
      note = NOTE_RE.test(raw);
      if (IGNORE_RE.test(raw)) ignoreAt = n + 1;
      continue;
    }
    if (note && QUOTE_RE.test(raw)) continue;
    note = false;
    const line = raw.replace(QUOTE_RE, '');
    const stripped = line.trim();
    const h = /^#{1,6}\s+(.*?)(?:\s+#+)?$/.exec(stripped);
    if (h) {
      close();
      heading = h[1];
      continue;
    }
    if (!stripped || /^(\||#|!\[|<)/.test(stripped) || RULE_RE.test(stripped) || ALERT_RE.test(stripped) || skipLines.some((r) => r.test(stripped))) {
      close();
      continue;
    }
    const ignored = IGNORE_RE.test(line) || ignoreAt === n;
    const body = line.replace(/<!--.*?-->/g, ' ');
    const item = ITEM_RE.exec(body);
    if (item) {
      close();
      current = { line: n, text: unlabelled(body.slice(item[0].length).trim()), item: true, ignored, heading };
      heading = undefined;
    } else if (!current) {
      current = { line: n, text: unlabelled(body.trim()), item: false, ignored, heading };
      heading = undefined;
    } else {
      current.text += '\n' + body.trim();
      if (ignored) current.ignored = true;
    }
  }
  close();
  return found;
}

/** Text as it is read: a code span, a link or a URL one placeholder word (kept in `spans`), bold marks dropped. */
interface Plain {
  text: string;
  spans: string[];
}

const SPAN_RE = /([CLU])\uE000(\d+)\uE001/g;

function plain(text: string): Plain {
  const spans: string[] = [];
  // The newlines a span swallows stay in front of it, so lines can still be counted.
  const keep = (letter: string) => (m: string) => {
    spans.push(m);
    return '\n'.repeat(m.match(/\n/g)?.length ?? 0) + `${letter}\uE000${spans.length - 1}\uE001`;
  };
  const t = text
    .replace(/`[^`]*`/g, keep('C'))
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, keep('L'))
    .replace(/https?:\/\/\S+/g, keep('U'));
  return { text: t.replace(/\*\*|__/g, ''), spans };
}

/** The text with its placeholders put back. */
function restore(text: string, spans: readonly string[]): string {
  let t = text;
  // A link can hold a code span: put back until none is left.
  for (let i = 0; i < 5 && /[CLU]\d+/.test(t); i++) t = t.replace(SPAN_RE, (_m, _l: string, n: string) => spans[Number(n)] ?? '');
  return t;
}

// Letters and digits, Latin to CJK (no \p{L}: Hermes, the app's engine, may lack it).
const LETTERS = 'A-Za-z0-9_\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u1FFF\u2C00-\uD7FF';
const WORD_RE = new RegExp(`[${LETTERS}]`);

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => WORD_RE.test(w)).length;
}

const ABBREVIATION_RE = /\b(?:e\.g|i\.e|etc|vs|cf)\.$/i;
// A sentence ends at . ! ? before a space and a letter or digit: names may start lowercase
// (kubectl), so a capital is not required; the abbreviations above don't end one.
const SENTENCE_END_RE = /(?<=[.!?])["')\]*_]*\s+(?=["'(\[*_`]*[A-Za-z0-9])/g;

interface Sentence {
  text: string;
  /** Offset in the plain text of the unit. */
  start: number;
}

function splitSentences(t: string): Sentence[] {
  const parts: Sentence[] = [];
  const at = (offset: number, s: string): void => void parts.push({ text: s.trim(), start: offset + (s.length - s.trimStart().length) });
  const pieces: Array<[number, number]> = [];
  let pieceStart = 0;
  for (const m of t.matchAll(/\s·\s/g)) {
    pieces.push([pieceStart, m.index]);
    pieceStart = m.index + m[0].length;
  }
  pieces.push([pieceStart, t.length]);
  for (const [a, b] of pieces) {
    const piece = t.slice(a, b);
    let start = 0;
    for (const end of piece.matchAll(SENTENCE_END_RE)) {
      if (ABBREVIATION_RE.test(piece.slice(start, end.index).trim())) continue;
      at(a + start, piece.slice(start, end.index));
      start = end.index + end[0].length;
    }
    at(a + start, piece.slice(start));
  }
  return parts.filter((p) => countWords(p.text) > 0);
}

/** The sentences of a text as they are read (code spans, links and URLs put back). */
export function proseSentences(text: string): string[] {
  const p = plain(text);
  return splitSentences(p.text).map((s) => restore(s.text, p.spans).replace(/\s+/g, ' '));
}

/** Words in a text as they are read: a code span, a link or a URL is one word. */
export function proseWords(text: string): number {
  return countWords(plain(text).text);
}

const newlines = (s: string): number => s.match(/\n/g)?.length ?? 0;
const quote = (s: string): string => `"${s.replace(/\s+/g, ' ')}"`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
const wholeWord = (phrase: string): RegExp => new RegExp(`(?<![${LETTERS}-])${escapeRe(phrase)}(?![${LETTERS}-])`, 'i');
/** Padding words (delete them) and wordy phrases (with the short word to use). */
const WORD_RULES: ReadonlyArray<readonly [RegExp, string | undefined]> = [
  ...PROSE_PHRASES.padding.map((w) => [wholeWord(w), undefined] as const),
  ...PROSE_PHRASES.wordy.map(([phrase, short]) => [wholeWord(phrase), short] as const),
];

/** What the prose checks measured in a text: its findings, its sentences and their average length. */
export interface ProseMeasure {
  findings: ProseFinding[];
  /** Sentences read. */
  count: number;
  /** Words a sentence on average (0 without sentences). */
  average: number;
}

/** Content words, roughly stemmed (restarts, restarted, restarting: restart). */
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(new RegExp(`[^${LETTERS}]+`))
    .filter((w) => w !== '' && w !== '_' && !PROSE_PHRASES.stopWords.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(?:ing|ed|es|s)$/, '') : w.length > 3 ? w.replace(/s$/, '') : w));
}

/** The first sentence under a heading only says the heading again (PROSE_LIMITS.heading*). */
function saysHeading(heading: string, sentence: string): boolean {
  // A heading's numbers are its place ("## 3. Exit codes"), not what it says.
  const said = new Set(contentWords(heading).filter((w) => !/^\d+$/.test(w)));
  if (said.size < PROSE_LIMITS.headingMinWords) return false;
  const words = new Set(contentWords(sentence));
  const shared = [...said].filter((w) => words.has(w)).length;
  const extra = [...words].filter((w) => !said.has(w)).length;
  return shared / said.size >= PROSE_LIMITS.headingShare && extra <= PROSE_LIMITS.headingExtraWords;
}

/** The first 160 characters of a sentence, as it is read (code spans and links put back). */
const excerpt = (s: string): string => (s.length > 160 ? s.slice(0, 159) + '…' : s);

/** The prose findings of a text, in file order, with what was counted. */
export function measureProse(text: string, options: ProseOptions = {}): ProseMeasure {
  const found: ProseFinding[] = [];
  const said = new Map<string, number>();
  let total = 0;
  let count = 0;
  const units = proseUnits(text, options);
  for (const unit of units) {
    const p = plain(unit.text);
    const sentences = splitSentences(p.text);
    let size = 0;
    for (const s of sentences) {
      const line = unit.line + newlines(p.text.slice(0, s.start));
      const lineAt = (i: number): number => line + newlines(s.text.slice(0, i));
      const words = countWords(s.text);
      const sentence = restore(s.text, p.spans).replace(/\s+/g, ' ');
      size += words;
      total += words;
      count++;
      if (words > PROSE_LIMITS.sentenceWords) {
        found.push({ rule: 'prose-sentence', line, words, sentence, message: `${words} words, at most ${PROSE_LIMITS.sentenceWords}: ${quote(excerpt(sentence))}` });
      }
      const head = s.text.replace(/^["'(*_]+/, '').toLowerCase().replace(/\s+/g, ' ');
      const opener = PROSE_PHRASES.openers.find((o) => head.startsWith(o) && !WORD_RE.test(head[o.length] ?? ''));
      if (opener) found.push({ rule: 'prose-opener', line, sentence, message: `Delete the opener ${quote(opener[0]!.toUpperCase() + opener.slice(1))}` });
      else if (PROSE_PHRASES.announcing.some((r) => r.test(head))) {
        found.push({ rule: 'prose-announcing', line, sentence, message: `Delete this sentence, it only announces: ${quote(excerpt(sentence))}` });
      }
      for (const [re, short] of WORD_RULES) {
        const m = re.exec(s.text);
        if (!m) continue;
        const message = short === undefined ? `Delete ${quote(m[0])}` : `Use ${quote(short)}, not ${quote(m[0])}`;
        found.push({ rule: 'prose-padding', line: lineAt(m.index), sentence, message });
      }
      if (s === sentences[0] && unit.heading !== undefined && saysHeading(unit.heading, sentence)) {
        found.push({ rule: 'prose-heading', line, sentence, message: "Says the heading again: cut it, or add what's new" });
      }
      if (words >= PROSE_LIMITS.repeatWords) {
        const key = sentence
          .toLowerCase()
          .replace(/[*_]/g, '')
          .replace(/[\s.!?:;,]+$/, '');
        const before = said.get(key);
        if (before === undefined) said.set(key, line);
        else found.push({ rule: 'prose-repeat', line, sentence, message: `Already said on line ${before + 1}: ${quote(excerpt(sentence))}` });
      }
    }
    if (size > PROSE_LIMITS.unitWords || sentences.length > PROSE_LIMITS.unitSentences) {
      const what = `${sentences.length} sentence${sentences.length === 1 ? '' : 's'}, ${size} words`;
      found.push({
        rule: 'prose-paragraph',
        line: unit.line,
        words: size,
        sentences: sentences.length,
        message: `Several ideas (${what}): ${unit.item ? 'split this item' : 'make it a list'}`,
      });
    }
  }
  const average = count > 0 ? total / count : 0;
  if (average > PROSE_LIMITS.averageWords) {
    found.push({
      rule: 'prose-average',
      line: units[0]!.line,
      message: `${roundAverage(average).toFixed(1)} words a sentence on average, at most ${PROSE_LIMITS.averageWords}`,
    });
  }
  return { findings: found.sort((a, b) => a.line - b.line), count, average };
}

/** The prose findings of a text, in file order. */
export function checkProse(text: string): ProseFinding[] {
  return measureProse(text).findings;
}

/**
 * An average rounded to 0.1 as Python's round(x, 1) does (prose_ratchet.py's baseline): from the
 * exact value of the double, an exact tie to the even digit (16.25 -> 16.2).
 */
export function roundAverage(x: number): number {
  const t = x * 10;
  if (Number.isInteger(x * 4) && Math.abs(t - Math.trunc(t)) === 0.5) {
    const f = Math.floor(t);
    return (f % 2 === 0 ? f : f + 1) / 10;
  }
  return Number(x.toFixed(1));
}

/** For a finding in the runbook view: its markup cell and the line in that cell. */
export function markupCellAt(doc: ParsedDocument, line: number): { index: number; sourceLine: number } | undefined {
  let at = 0;
  for (let index = 0; index < doc.cells.length; index++) {
    const m = doc.cells[index]!.meta;
    if (isCodeMeta(m)) {
      at += newlines((m.lead + m.open + m.body + m.close + (m.output?.raw ?? '') + (m.history?.raw ?? '') + m.trail).replace(/\r\n?/g, '\n'));
      continue;
    }
    const start = at + newlines(m.lead.replace(/\r\n?/g, '\n'));
    const size = m.value.split('\n').length;
    if (line >= start && line < start + size) return { index, sourceLine: line - start };
    at += newlines((m.lead + m.content + m.trail).replace(/\r\n?/g, '\n'));
  }
  return undefined;
}

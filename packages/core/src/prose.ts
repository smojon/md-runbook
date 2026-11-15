/**
 * Prose checks: keep a runbook's text short and simple. The rules and the way words are counted
 * follow the "Short and simple" style guide of a sister project (its prose_ratchet.py), so both
 * count the same: a sentence has at most 20 words, a paragraph or list item at most 3 sentences
 * and 60 words (a box's labelled paragraph 5 and 100). The file average (15) is only recorded by
 * the ratchet. On top of that: openers, padding words, sentences that only announce, a first
 * sentence that says its heading again, an empty lead-in before a code block, a total duration
 * the estimates already show, choppy sentences, a box split in paragraphs and a sentence said
 * twice. Over many files (the command line only): the same text in 3 or more files.
 *
 * The sentence rules skip a sentence with a digit, a code span, a link or a word such as
 * "because", "never", "only", "unless": it states a fact, a reason, a condition or a warning
 * (the guard; a duration keeps its digit). The word rules (openers, padding) cut words, not the
 * sentence: they aren't guarded.
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

import { parseCellOptions } from './cellOptions';
import { FenceOpen, isFenceClose, matchFenceOpen } from './fence';
import { isCodeMeta, type ParsedDocument } from './model';

export const PROSE_LIMITS = {
  sentenceWords: 20,
  /** With `prose: strict`: a sentence over this is a warning; one over sentenceWords only stays info. */
  strictSentenceWords: 25,
  averageWords: 15,
  unitSentences: 3,
  unitWords: 60,
  /** A box's labelled paragraph (a story box is read through, not scanned): at most these. */
  boxSentences: 5,
  boxWords: 100,
  /** A box repeats a sentence above it: it has this share of the box's first sentence's content words… */
  boxRepeatShare: 0.6,
  /** …or a run of this many of them; the box's sentence has at least boxRepeatMinWords. */
  boxRepeatRun: 4,
  boxRepeatMinWords: 3,
  /** A direct quotation of this many words or more, this share of a sentence: its length is the quote's. */
  quotationWords: 6,
  quotationShare: 0.6,
  /** An empty lead-in before a code block has at most this many words. */
  leadInWords: 6,
  /** Choppy: this many sentences in a row, each under choppyWords words. */
  choppySentences: 3,
  choppyWords: 8,
  /** The same text in this many files (or more) is said once too often… */
  duplicateFiles: 3,
  /** …when it has at least this many words (normalised)… */
  duplicateWords: 8,
  /** …or its paragraphs share this share of their 5-word runs (Jaccard; 0.6 to 0.8 found the same on nevis-rest-api). */
  duplicateShingle: 5,
  /** A sentence (or a paragraph) of at most this many words with a link is a pointer, never a duplicate. */
  pointerWords: 20,
  duplicateJaccard: 0.6,
  /** A shorter sentence may come back (a step such as "Check the logs."). */
  repeatWords: 6,
  /** The first sentence under a heading says it again: it has this share of the heading's content words… */
  headingShare: 0.7,
  /** …and adds at most this many content words of its own… */
  headingExtraWords: 4,
  /** …and the heading has at least this many content words. */
  headingMinWords: 2,
} as const;

/** The limits a repository may set (.md-runbook-prose.json "limits"): positive whole numbers. */
export const PROSE_LIMIT_KEYS = ['sentenceWords', 'strictSentenceWords', 'averageWords', 'unitSentences', 'unitWords'] as const;
export type ProseLimits = Record<(typeof PROSE_LIMIT_KEYS)[number], number>;

/** The limits in force: the defaults, with the repository's own on top. */
export function proseLimits(options: ProseOptions = {}): ProseLimits {
  const l = options.limits ?? {};
  const pick = (k: (typeof PROSE_LIMIT_KEYS)[number]): number => l[k] ?? PROSE_LIMITS[k];
  return {
    sentenceWords: pick('sentenceWords'),
    strictSentenceWords: pick('strictSentenceWords'),
    averageWords: pick('averageWords'),
    unitSentences: pick('unitSentences'),
    unitWords: pick('unitWords'),
  };
}

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
  padding: ['basically', 'simply', 'of course', 'obviously'],
  /** Not content words, when a sentence is compared with its heading. */
  stopWords: new Set(
    'the a an of to in on for and or is are this that with by it its your you how what'.split(' '),
  ),
  /** Wordy phrases and the short word to use instead. */
  wordy: [['in order to', 'to']] as ReadonlyArray<readonly [string, string]>,
  /** A sentence with one of these states a reason, a condition or a warning: the sentence rules leave it alone. */
  guard: ['because', 'so that', 'never', 'must', 'only', 'not', 'unless', 'until', 'except'],
  /** How a bullet starts that leans on the one before ("It refuses…"): case-sensitive, a whole word. */
  leaning: /^(?:It|Its|This|That|These|Those|They|There|Then|So|But|And)(?![A-Za-z0-9_-])/,
  /** How an empty lead-in before a code block starts ("Now run:", "On the lab:"). */
  leadIn: /^(?:now|then|next|first|again|back to|here|on the lab)\b/,
  /** A lead-in with one of these says something of the block ("On the lab, the image (shortened):"): not empty. */
  leadInSays: ['shortened', 'abridged', 'excerpt', 'the last lines', 'the first lines', 'trimmed'],
  /** A duration in minutes or hours ("about 40 minutes", "five minutes", "an hour"). */
  duration:
    /(?<![\w-])(?:(?:about|around|roughly|some|~)\s*)?(?:\d+(?:[.,]\d+)?|a few|a couple of|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety)(?:\s*(?:-|–|to)\s*\d+)?\s*(?:minutes?|mins?|hours?)\b|\b(?:half an|an) hour\b/i,
  /** A duration next to one of these is the whole thing's: the estimates show it ("This guide takes about 40 minutes"). */
  durationTotal: /\b(?:(?:this|the|each|every|whole) (?:guide|runbook|step|section)s? takes?|in all|in total|altogether|the whole (?:guide|runbook|thing))\b/i,
  /** In an opening paragraph, a duration of something that takes time ("Allow about an hour", "It takes 40 minutes"). */
  durationTakes: /\b(?:takes?|took|lasts|allow|plan for)\b/i,
  /** A sentence of only a duration ("About 40 minutes."): the whole thing's too. */
  durationAlone: /^(?:about|around|roughly|~)?\s*\S+(?:\s*(?:-|–|to)\s*\d+)?\s*(?:minutes?|mins?|hours?)[.*_)]*$/i,
  /** Labels whose "?" doesn't end a sentence in running text ("a Did you know? is one paragraph"), with the file's own. */
  labelTexts: ['Did you know?'],
};

/** On a line, or alone on the line before: the paragraph or list item isn't checked. */
export const PROSE_IGNORE = '<!-- md-runbook:prose-ignore -->';
const IGNORE_RE = /<!--\s*md-runbook:prose-ignore\s*-->/;

export type ProseRule =
  | 'prose-sentence'
  | 'prose-paragraph'
  | 'prose-opener'
  | 'prose-announcing'
  | 'prose-padding'
  | 'prose-heading'
  | 'prose-lead-in'
  | 'prose-duration'
  | 'prose-box'
  | 'prose-box-repeat'
  | 'prose-choppy'
  | 'prose-list-lean'
  | 'prose-repeat'
  | 'prose-duplicate';

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
  /** A code block comes next (blank lines between at most). */
  beforeFence?: boolean;
  /** In a quote: its number in the file (the units of one quote share it). */
  quote?: number;
  /** A box's labelled paragraph: the first paragraph of a quote, with a label or after an alert's marker line. */
  box?: boolean;
  /** A paragraph right after another paragraph of its quote, only a blank `>` line between. */
  joined?: boolean;
  /** A bullet (not a numbered item) right after a sibling item: same list, same indent. */
  sibling?: boolean;
}

const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const QUOTE_RE = /^\s*>\s?/;
const NOTE_RE = /^[ \t]*<!--[ \t]*md-runbook:note\b/;
const RULE_RE = /^[-*_ ]{3,}$/;
/** A GitHub alert's marker line (`> [!NOTE]`): not prose; the quote's text after it is. */
const ALERT_RE = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i;

/**
 * A callout label at the start of a unit, dropped before counting: an optional emoji, a bold
 * label, then " · ", " — ", " – " or ":" (`🔑 **Key point** · `, `💡 **Did you know?** — `,
 * `🔑 **Key point:** `). The default of `labels`.
 */
export const DEFAULT_LABELS: readonly RegExp[] = [/^(?:(?:[⌀-➿⬀-⯿]|[\uD83C-\uD83E][\uDC00-\uDFFF])️?\s*)?\*\*(?:[^*\n]+\*\*(?:\s+[·—–]\s+|:\s+)|[^*\n]+:\*\*\s+)/];

/** How a repository writes things that aren't prose (its .md-runbook-prose.json). */
export interface ProseOptions {
  /** A line matching one of these (after a quote mark, trimmed) is not prose: generated lines, e.g. /^\*⏱/. */
  skipLines?: readonly RegExp[];
  /** Dropped at the start of a unit before counting (callout labels). Default: DEFAULT_LABELS; [] none. */
  labels?: readonly RegExp[];
  /** The repository's limits; any left out keep their default (PROSE_LIMITS). */
  limits?: Partial<ProseLimits>;
  /** A box's labelled paragraph: its own limits (default 5 sentences, 100 words); false: no boxes. */
  boxes?: false | { sentences?: number; words?: number };
}

/** The prose of a runbook, as units. Lines inside a unit are joined with \n (a unit's lines are consecutive). */
export function proseUnits(text: string, options: ProseOptions = {}): ProseUnit[] {
  return readProse(text, options).units;
}

/** The units, and whether a code block has estimate= (the runbook shows its time). */
function readProse(text: string, options: ProseOptions): { units: ProseUnit[]; estimates: boolean; labelTexts: string[] } {
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
  let estimates = false;
  const labelTexts = [...DEFAULT_LABEL_TEXTS];
  /** The unit closed last and its last line; the last line that isn't blank (a unit right before a code block). */
  let last: ProseUnit | undefined;
  let lastEnd = -1;
  let end = -1;
  let nonBlank = -1;
  // Quotes: which one, its units so far, an alert's marker line seen, what came since its last unit.
  const boxes = options.boxes !== false;
  let quoted = false;
  let quoteId = 0;
  let quoteUnits = 0;
  let alert = false;
  let quoteBlank = false;
  let quoteOther = false;
  let quoteItem = false;
  /** The open list: for each indent, whether its items are numbered. */
  const list = new Map<number, boolean>();
  const close = (): void => {
    if (current && !current.ignored && current.text.trim()) {
      const { ignored: _ignored, heading: h, ...rest } = current;
      last = { ...rest, ...(h !== undefined ? { heading: h } : {}) };
      lastEnd = end;
      found.push(last);
    }
    current = undefined;
  };
  for (let n = first; n < lines.length; n++) {
    const raw = lines[n]!;
    const before = nonBlank;
    if (raw.trim() !== '') nonBlank = n;
    const inQuote = !comment && !fence && QUOTE_RE.test(raw);
    if (inQuote && !quoted) {
      // A new quote (a quote's lazy lines without ">" stay in it).
      close();
      quoteId++;
      quoteUnits = 0;
      alert = quoteBlank = quoteOther = quoteItem = false;
    }
    quoted = inQuote;
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
      if (last && lastEnd === before) last.beforeFence = true;
      if (!estimates && /estimate=/i.test(open.info)) estimates = parseCellOptions(open.info).estimateSeconds !== undefined;
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
      quoteOther = true;
      list.clear();
      continue;
    }
    if (!stripped || /^(\||#|!\[|<)/.test(stripped) || RULE_RE.test(stripped) || ALERT_RE.test(stripped) || skipLines.some((r) => r.test(stripped))) {
      close();
      if (quoted && !stripped) quoteBlank = true;
      else if (quoted && ALERT_RE.test(stripped)) alert = quoteUnits === 0;
      else quoteOther = true;
      if (stripped) list.clear();
      continue;
    }
    const ignored = IGNORE_RE.test(line) || ignoreAt === n;
    const body = line.replace(/<!--.*?-->/g, ' ');
    const item = ITEM_RE.exec(body);
    if (item || !current) {
      close();
      const text = item ? body.slice(item[0].length).trim() : body.trim();
      current = { line: n, text: unlabelled(text), item: item !== null, ignored, heading };
      heading = undefined;
      if (item) {
        const indent = item[1]!.length;
        const numbered = /^\d/.test(body.slice(indent).trimStart());
        if (!numbered && list.get(indent) === false) current.sibling = true;
        for (const i of [...list.keys()]) if (i > indent) list.delete(i);
        list.set(indent, numbered);
      } else list.clear();
      if (current.text !== text) {
        // A label such as **Did you know?**: its question mark ends no sentence elsewhere in the file.
        const label = /\*\*([^*]+\?)\*\*/.exec(text.slice(0, text.length - current.text.length))?.[1]?.trim().toLowerCase();
        if (label && !labelTexts.includes(label)) labelTexts.push(label);
      }
      if (quoted) {
        current.quote = quoteId;
        if (boxes && quoteUnits === 0 && !item && (alert || current.text !== text)) current.box = true;
        if (!item && quoteUnits > 0 && quoteBlank && !quoteOther && !quoteItem) current.joined = true;
        quoteUnits++;
        quoteItem = item !== null;
        alert = false;
      }
    } else {
      current.text += '\n' + body.trim();
      if (ignored) current.ignored = true;
    }
    quoteBlank = quoteOther = false;
    end = n;
  }
  close();
  return { units: found, estimates, labelTexts };
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
    .replace(/https?:\/\/\S+/g, keep('U'))
    // In an emphasis span, a ? or ! before lowercase text ends no sentence ("*Can they read it?*
    // turns red"), nor a . inside it ("*see fig. one*"); before a capital, or a . at its end, they do.
    .replace(EMPHASIS_RE, (m: string, at: number, all: string) => {
      const after = (i: number): string => (m.slice(i + 1) + all.slice(at + m.length)).replace(/^[*_"')\]\s]+/, '');
      return m
        .replace(/[.?!]/g, (c, i: number) => {
          const inside = /[^*_\s]/.test(m.slice(i + 1).replace(/[*_]+$/, ''));
          return /^[a-z]/.test(after(i)) && (c !== '.' || inside) ? MASK[c]! : c;
        })
        // A " · " inside emphasis joins the parts of one label ("**1 secret · 1 value**").
        .replace(/·/g, '');
    });
  return { text: t.replace(/\*\*|__/g, ''), spans };
}

/** Emphasis spans: **…**, __…__, *…*, _…_ (code spans are placeholders by then). */
const EMPHASIS_RE = /\*\*[^*]+?\*\*|__[^_]+?__|(?<![*A-Za-z0-9_])\*(?![\s*])[^*]+?(?<![\s*])\*(?![*A-Za-z0-9])|(?<![A-Za-z0-9_])_(?![\s_])[^_]+?(?<![\s_])_(?![A-Za-z0-9_])/g;
const MASK: Record<string, string> = { '.': '\uE004', '?': '\uE002', '!': '\uE003' };
/** The text with an emphasis span's marks as they were. */
const unmask = (t: string): string =>
  t.replace(/[\uE002-\uE005]/g, (c) => ({ '\uE004': '.', '\uE002': '?', '\uE003': '!', '\uE005': '\u00B7' })[c]!);

/** The text with its placeholders put back. */
function restore(text: string, spans: readonly string[]): string {
  let t = text;
  // A link can hold a code span: put back until none is left.
  for (let i = 0; i < 5 && /[CLU]\uE000\d+\uE001/.test(t); i++) t = t.replace(SPAN_RE, (_m, _l: string, n: string) => spans[Number(n)] ?? '');
  return unmask(t);
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
// A link or code span that wrapped keeps its newlines in front of its placeholder, so a "(" may be
// followed by newlines before the link: "next. (\n[NBC News…](…))".
const SENTENCE_END_RE = /(?<=[.!?])["')\]*_]*\s+(?=["'(\[*_`]*\n*[A-Za-z0-9])/g;

interface Sentence {
  text: string;
  /** Offset in the plain text of the unit. */
  start: number;
}

/** `labels`: label texts ending in "?" (lower case) that don't end a sentence in running text. */
function splitSentences(t: string, labels: readonly string[] = DEFAULT_LABEL_TEXTS): Sentence[] {
  const parts: Sentence[] = [];
  const isLabel = (s: string): boolean => {
    const l = s.toLowerCase();
    return labels.some((x) => l.endsWith(x) && !WORD_RE.test(l[l.length - x.length - 1] ?? ''));
  };
  const at = (offset: number, s: string): void => {
    // A citation left at the front (the sentence before it ended inside the same line) is no part of it.
    const lead = s.length - s.trimStart().length;
    const cited = CITATION_PREFIX_RE.exec(s.slice(lead))?.[0].length ?? 0;
    parts.push({ text: s.slice(lead + cited).trim(), start: offset + lead + cited });
  };
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
      const so = piece.slice(start, end.index).trim();
      const next = piece.slice(end.index + end[0].length).replace(/^["'(\[*_`]+/, '');
      if (ABBREVIATION_RE.test(so) || (so.endsWith('?') && isLabel(so))) continue;
      // Initials ("L. Peter Deutsch", "J. R. R. Tolkien") and "no. 6" end no sentence.
      if (isInitial(so, next) || (NUMBER_RE.test(so) && /^\d/.test(next))) continue;
      at(a + start, piece.slice(start, end.index));
      start = end.index + end[0].length;
    }
    at(a + start, piece.slice(start));
  }
  return parts.filter((p) => countWords(p.text) > 0 && !CITATION_RE.test(p.text));
}

/** A capital alone after a space or an opening mark (not Ctrl+C.). */
const INITIAL_RE = /(?:^|[\s("'\[])[A-Z]\.$/;
const NUMBER_RE = /\bno\.$/i;
const CAPITALISED = /^["'(\[]*[A-Z]/;
const AN_INITIAL = /^["'(\[]*[A-Z]\.$/;

/**
 * Whether `so` (the text up to a sentence end) ends in an initial, so the text goes on: "L. Peter
 * Deutsch", "J. R. R. Tolkien". The capital must follow a capitalised word, another initial or
 * nothing; or the next two words must both be capitalised (a name: "by L. Peter Deutsch"). After a
 * lowercase word it is a name ending a sentence: "design B. The renewal…", "corpus A. In 15…".
 */
function isInitial(so: string, next: string): boolean {
  if (!INITIAL_RE.test(so) || !/^[A-Z]/.test(next)) return false;
  const before = so.slice(0, -2).trimEnd().split(/\s+/).filter(Boolean);
  const prev = before[before.length - 1];
  if (prev === undefined || CAPITALISED.test(prev) || AN_INITIAL.test(prev)) return true;
  const [, second] = next.split(/\s+/);
  return second !== undefined && (CAPITALISED.test(second) || AN_INITIAL.test(second));
}

const DEFAULT_LABEL_TEXTS: readonly string[] = PROSE_PHRASES.labelTexts.map((l) => l.toLowerCase());

/** Only links in parentheses, a citation (`([source](…), [paper](…))`): not a sentence. */
const CITATION_RE = /^\(\s*[LU]\uE000\d+\uE001(?:\s*(?:[,;]|and)\s*[LU]\uE000\d+\uE001)*\s*\)[.,;:]*$/;
/** The same at the front of a sentence, followed by more text. */
const CITATION_PREFIX_RE = /^\(\s*[LU]\uE000\d+\uE001(?:\s*(?:[,;]|and)\s*[LU]\uE000\d+\uE001)*\s*\)[.,;:]*\s+(?=\S)/;

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

/** A long sentence's message: `27 words, at most 20: "…"`. */
export const sentenceMessage = (words: number, limit: number, sentence: string): string => `${words} words, at most ${limit}: ${quote(excerpt(sentence))}`;

const PLACEHOLDER_RE = /[CLU]\uE000\d+\uE001/;
const GUARD_RES = PROSE_PHRASES.guard.map(wholeWord);

/**
 * Why the sentence rules leave a sentence alone (plain text): it has a code span or a link, a
 * word that gives a reason, a condition or a warning, or a digit. undefined: they check it.
 */
function guarded(plainText: string): 'span' | 'word' | 'digit' | undefined {
  if (PLACEHOLDER_RE.test(plainText)) return 'span';
  const bare = plainText.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), ' ');
  if (GUARD_RES.some((r) => r.test(bare))) return 'word';
  return /\d/.test(bare) ? 'digit' : undefined;
}

/** A sentence of a unit, as it is read: its plain text, its line, its words and its text with spans put back. */
interface ReadSentence {
  text: string;
  line: number;
  words: number;
  sentence: string;
}

function readSentences(unit: ProseUnit, p: Plain, labels?: readonly string[]): ReadSentence[] {
  return splitSentences(p.text, labels).map((s) => ({
    text: s.text,
    line: unit.line + newlines(p.text.slice(0, s.start)),
    words: countWords(s.text),
    sentence: restore(s.text, p.spans).replace(/\s+/g, ' '),
  }));
}

/**
 * The prose findings of a text, in file order, with what was counted. The word rules (openers,
 * padding) cut words, so they check every sentence; the sentence rules (announcing, the
 * heading, a repeat, a lead-in, a duration, choppy sentences) skip a guarded one.
 */
export function measureProse(text: string, options: ProseOptions = {}): ProseMeasure {
  const limits = proseLimits(options);
  const boxed = options.boxes === false ? {} : (options.boxes ?? {});
  const box = { sentences: boxed.sentences ?? PROSE_LIMITS.boxSentences, words: boxed.words ?? PROSE_LIMITS.boxWords };
  const found: ProseFinding[] = [];
  const said = new Map<string, number>();
  let total = 0;
  let count = 0;
  const { units, estimates, labelTexts } = readProse(text, options);
  units.forEach((unit, index) => {
    const p = plain(unit.text);
    const sentences = readSentences(unit, p, labelTexts);
    // The runbook's first paragraph, or a section's: what it says of time is the whole thing's.
    const opening = index === 0 || unit.heading !== undefined;
    let size = 0;
    let choppy: ReadSentence[] = [];
    const endChoppy = (): void => {
      if (choppy.length >= PROSE_LIMITS.choppySentences) {
        found.push({ rule: 'prose-choppy', line: choppy[0]!.line, sentence: choppy.map((c) => c.sentence).join(' '), message: 'Choppy: join these sentences with their link word' });
      }
      choppy = [];
    };
    for (const s of sentences) {
      const { line, words, sentence } = s;
      const lineAt = (i: number): number => line + newlines(s.text.slice(0, i));
      size += words;
      total += words;
      count++;
      if (words > limits.sentenceWords && !isQuotation(s.text, words)) {
        found.push({ rule: 'prose-sentence', line, words, sentence, message: sentenceMessage(words, limits.sentenceWords, sentence) });
      }
      const head = unmask(s.text).replace(/^["'(*_]+/, '').toLowerCase().replace(/\s+/g, ' ');
      const guard = guarded(s.text);
      // Word rules: never guarded.
      const opener = PROSE_PHRASES.openers.find((o) => head.startsWith(o) && !WORD_RE.test(head[o.length] ?? ''));
      if (opener) found.push({ rule: 'prose-opener', line, sentence, message: `Delete the opener ${quote(opener[0]!.toUpperCase() + opener.slice(1))}` });
      for (const [re, short] of WORD_RULES) {
        const m = re.exec(s.text);
        if (!m) continue;
        const message = short === undefined ? `Delete ${quote(m[0])}` : `Use ${quote(short)}, not ${quote(m[0])}`;
        found.push({ rule: 'prose-padding', line: lineAt(m.index), sentence, message });
      }
      // Sentence rules: guarded; a duration keeps its digit.
      if (estimates && (guard === undefined || guard === 'digit') && isTotalDuration(head, opening && !unit.beforeFence)) {
        found.push({ rule: 'prose-duration', line, sentence, message: 'Duration in prose: it goes stale; the estimates show it' });
      }
      if (guard === undefined) {
        if (!opener && PROSE_PHRASES.announcing.some((r) => r.test(head))) {
          found.push({ rule: 'prose-announcing', line, sentence, message: `Delete this sentence, it only announces: ${quote(excerpt(sentence))}` });
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
      if (!unit.item && guard === undefined && words < PROSE_LIMITS.choppyWords) choppy.push(s);
      else endChoppy();
    }
    endChoppy();
    if (unit.sibling && PROSE_PHRASES.leaning.test(p.text.replace(/^["'(*_]+/, ''))) {
      found.push({ rule: 'prose-list-lean', line: unit.line, sentence: sentences[0]?.sentence ?? unit.text, message: 'Leans on the item before: join them into a sentence, or make it stand alone' });
    }
    if (isLeadIn(unit, p.text, size)) {
      found.push({ rule: 'prose-lead-in', line: unit.line, sentence: sentences[0]?.sentence ?? unit.text, message: 'Empty lead-in: start with what the block does, or cut it' });
    }
    const unitWords = unit.box ? box.words : limits.unitWords;
    const unitSentences = unit.box ? box.sentences : limits.unitSentences;
    if (size > unitWords || sentences.length > unitSentences) {
      const what = `${sentences.length} sentence${sentences.length === 1 ? '' : 's'}, ${size} words`;
      found.push({
        rule: 'prose-paragraph',
        line: unit.line,
        words: size,
        sentences: sentences.length,
        message: `Several ideas (${what}): ${unit.item ? 'split this item' : 'make it a list'}`,
      });
    }
  });
  // A box split by a blank ">" line between two paragraphs (not around a list): one paragraph reads better.
  for (const unit of units) {
    if (!unit.box) continue;
    const inBox = units.filter((u) => u.quote === unit.quote && !u.item);
    if (inBox.some((u) => u.joined)) {
      found.push({ rule: 'prose-box', line: unit.line, sentence: unit.text, message: `Box in ${inBox.length} paragraphs: make it one` });
    }
  }
  // A box that says again a sentence of the paragraph right above it: cut that sentence, keep the box.
  units.forEach((unit, index) => {
    const above = units[index - 1];
    if (!unit.box || !above || above.quote !== undefined || above.beforeFence || unit.heading !== undefined) return;
    const first = readSentences(unit, plain(unit.text), labelTexts)[0];
    if (!first) return;
    for (const s of readSentences(above, plain(above.text), labelTexts)) {
      if (guarded(s.text) === undefined && repeats(first.sentence, s.sentence)) {
        found.push({ rule: 'prose-box-repeat', line: s.line, sentence: s.sentence, message: 'Box repeats this sentence: cut it here, keep the box' });
      }
    }
  });
  // A box that says what the box before it in the same section says: one of them can go.
  let previous: ProseUnit | undefined;
  for (const unit of units) {
    if (unit.heading !== undefined) previous = undefined;
    if (!unit.box) continue;
    const first = readSentences(unit, plain(unit.text), labelTexts)[0];
    if (previous && first && guarded(first.text) === undefined) {
      const before = readSentences(previous, plain(previous.text), labelTexts);
      if (before.some((s) => guarded(s.text) === undefined && repeats(first.sentence, s.sentence))) {
        found.push({ rule: 'prose-box-repeat', line: first.line, sentence: first.sentence, message: 'Says what the box above says: cut one' });
      }
    }
    previous = unit;
  }
  // The average is no finding (it pushes towards choppy text); the ratchet still records it.
  const average = count > 0 ? total / count : 0;
  return { findings: found.sort((a, b) => a.line - b.line), count, average };
}

/**
 * A duration of the whole guide or step (the estimates show it): next to "this guide takes",
 * "in all" or "in total", alone as a sentence, or with "takes" or "allow" in an opening paragraph
 * (the runbook's or a section's, not one right before a block: that is the block's own wait).
 * Never a certificate's life or a window ("for 24 hours", "the last 15 minutes").
 */
function isTotalDuration(head: string, opening: boolean): boolean {
  const m = PROSE_PHRASES.duration.exec(head);
  if (!m) return false;
  if ((opening && PROSE_PHRASES.durationTakes.test(head)) || PROSE_PHRASES.durationAlone.test(head)) return true;
  // "Next to": within a few words of the duration, before or after it.
  const near = head.slice(Math.max(0, m.index - 40), m.index + m[0].length + 25);
  return PROSE_PHRASES.durationTotal.test(near);
}

/**
 * Mostly a direct quotation ("…", “…”, «…» of 6 words or more, at least 60 % of the sentence's
 * words): a verbatim quote can't be shortened without changing it. A quote that runs on into the
 * next sentence counts in both, to the sentence's end and from its start.
 */
function isQuotation(plainText: string, words: number): boolean {
  let quoted = 0;
  // The end of a quote that began in the sentence before.
  const tail = /^([^“"«]*)[”»]/.exec(plainText);
  if (tail && countWords(tail[1]!) >= PROSE_LIMITS.quotationWords) quoted += countWords(tail[1]!);
  for (const m of plainText.slice(tail ? tail[0].length : 0).matchAll(/[“"«]([^”"»]*)(?:[”"»]|$)/g)) {
    const n = countWords(m[1]!);
    if (n >= PROSE_LIMITS.quotationWords) quoted += n;
  }
  return quoted >= PROSE_LIMITS.quotationShare * words;
}

/** A box's sentence says this sentence again: most of its content words are in it, or a run of them. */
function repeats(boxSentence: string, sentence: string): boolean {
  const said = contentWords(boxSentence);
  const saidSet = new Set(said);
  if (saidSet.size < PROSE_LIMITS.boxRepeatMinWords) return false;
  const words = contentWords(sentence);
  const set = new Set(words);
  if ([...saidSet].filter((w) => set.has(w)).length / saidSet.size >= PROSE_LIMITS.boxRepeatShare) return true;
  const n = PROSE_LIMITS.boxRepeatRun;
  const runs = new Set<string>();
  for (let i = 0; i + n <= said.length; i++) runs.add(said.slice(i, i + n).join(' '));
  for (let i = 0; i + n <= words.length; i++) if (runs.has(words.slice(i, i + n).join(' '))) return true;
  return false;
}

const LEAD_IN_SAYS = PROSE_PHRASES.leadInSays.map(wholeWord);

/** "Now run:" right before a code block: a short paragraph, ending in a colon, that says nothing of the block. */
function isLeadIn(unit: ProseUnit, plainText: string, words: number): boolean {
  if (!unit.beforeFence || unit.item || words === 0 || words > PROSE_LIMITS.leadInWords) return false;
  const t = unmask(plainText).replace(/\s+/g, ' ').trim().replace(/[*_]+$/, '');
  if (!t.endsWith(':') || guarded(t) !== undefined || LEAD_IN_SAYS.some((re) => re.test(t))) return false;
  return PROSE_PHRASES.leadIn.test(t.replace(/^["'(*_]+/, '').toLowerCase());
}

/** The prose findings of a text, in file order. */
export function checkProse(text: string, options: ProseOptions = {}): ProseFinding[] {
  return measureProse(text, options).findings;
}

/** A file for proseDuplicates: its name (as reported) and its text. */
export interface ProseFile {
  name: string;
  text: string;
}

/** Lower case, links, URLs and digits dropped, only the words left: how passages are compared across files. */
function normalised(text: string): string[] {
  return text
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase()
    .split(new RegExp(`[^${LETTERS.replace('0-9_', '')}]+`))
    .filter((w) => w !== '');
}

/**
 * Text said in several files (PROSE_LIMITS.duplicate*): a sentence or a paragraph of at least 8
 * words, normalised, in 3 files or more; or paragraphs of 3 files or more that share 60 % of
 * their 5-word runs. A paragraph said as a whole is one finding, not one a sentence. A finding at each place, by file name. Over many files only: the command
 * line's ratchet, never one file in the editor.
 */
export function proseDuplicates(files: readonly ProseFile[], options: ProseOptions = {}, jaccard: number = PROSE_LIMITS.duplicateJaccard): Map<string, ProseFinding[]> {
  interface Place {
    file: number;
    line: number;
    sentence: string;
    /** Its paragraph or item (file:line); whole: the place is that whole unit. */
    unit: string;
    whole: boolean;
  }
  const exact = new Map<string, Place[]>();
  const paragraphs: Array<Place & { shingles: Set<string> }> = [];
  files.forEach((f, file) => {
    const read = readProse(f.text, options);
    for (const unit of read.units) {
      const p = plain(unit.text);
      const sentences = readSentences(unit, p, read.labelTexts);
      const add = (words: string[], place: Place): void => {
        if (words.length < PROSE_LIMITS.duplicateWords) return;
        const key = words.join(' ');
        const list = exact.get(key);
        if (list) list.push(place);
        else exact.set(key, [place]);
      };
      const id = `${file}:${unit.line}`;
      // A short sentence with a link points to where it is said: the fix for a duplicate, not one.
      const pointer = (text: string, words: number): boolean => words <= PROSE_LIMITS.pointerWords && /[LU]\uE000/.test(text);
      for (const s of sentences) {
        if (!pointer(s.text, s.words)) add(normalised(s.sentence), { file, line: s.line, sentence: s.sentence, unit: id, whole: sentences.length === 1 });
      }
      const whole = sentences.map((s) => s.sentence).join(' ');
      const words = normalised(whole);
      const place = { file, line: unit.line, sentence: whole, unit: id, whole: true };
      if (pointer(p.text, countWords(p.text))) continue;
      if (sentences.length > 1) add(words, place);
      if (words.length >= PROSE_LIMITS.duplicateWords) {
        const n = PROSE_LIMITS.duplicateShingle;
        const shingles = new Set<string>();
        for (let i = 0; i + n <= words.length; i++) shingles.add(words.slice(i, i + n).join(' '));
        paragraphs.push({ ...place, shingles });
      }
    }
  });
  const hits: Array<[Place, number]> = [];
  const report = (place: Place, inFiles: number): void => void hits.push([place, inFiles]);
  for (const places of exact.values()) {
    const inFiles = new Set(places.map((p) => p.file)).size;
    if (inFiles >= PROSE_LIMITS.duplicateFiles) for (const p of places) report(p, inFiles);
  }
  // Near copies: paragraphs sharing 5-word runs, found through the runs they have.
  const index = new Map<string, number[]>();
  paragraphs.forEach((p, i) => {
    for (const s of p.shingles) {
      const list = index.get(s);
      if (list) list.push(i);
      else index.set(s, [i]);
    }
  });
  for (const p of paragraphs) {
    const shared = new Map<number, number>();
    for (const s of p.shingles) for (const j of index.get(s)!) if (paragraphs[j]!.file !== p.file) shared.set(j, (shared.get(j) ?? 0) + 1);
    const inFiles = new Set([p.file]);
    for (const [j, n] of shared) {
      const similar = n / (p.shingles.size + paragraphs[j]!.shingles.size - n);
      if (similar >= jaccard) inFiles.add(paragraphs[j]!.file);
    }
    if (inFiles.size >= PROSE_LIMITS.duplicateFiles) report(p, inFiles.size);
  }
  // One finding a place: a paragraph said elsewhere as a whole is one, not one a sentence.
  const covered = new Set(hits.filter(([p]) => p.whole).map(([p]) => p.unit));
  const found = new Map<string, ProseFinding[]>();
  const seen = new Set<string>();
  for (const [place, inFiles] of hits.sort(([a], [b]) => Number(b.whole) - Number(a.whole))) {
    const at = `${place.file}:${place.line}`;
    if (seen.has(at) || (!place.whole && covered.has(place.unit))) continue;
    seen.add(at);
    const name = files[place.file]!.name;
    const finding: ProseFinding = { rule: 'prose-duplicate', line: place.line, sentence: place.sentence, message: `Said in ${inFiles} files: say it once and link it` };
    found.set(name, [...(found.get(name) ?? []), finding]);
  }
  for (const list of found.values()) list.sort((a, b) => a.line - b.line);
  return found;
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

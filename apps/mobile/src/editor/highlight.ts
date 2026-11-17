/**
 * Highlighting for a runbook's Markdown, as spans over the text: plain TypeScript, no React, no
 * DOM, so the web editor (ui/RunbookTextInput.web.tsx) and, later, a native one can share it.
 *
 * - Line by line, with a small state (in a fence, an output block, a comment, a note), so it is
 *   linear in the text and could restart from a changed line.
 * - No span crosses a line end; spans nest (a bold span inside a heading) and come sorted by
 *   start, a parent before its children. `lineRuns` flattens them into coloured runs per line.
 * - Fences, cell options and md-runbook's markers are read with core's own functions and patterns
 *   (fence.ts, cellOptions.ts, outputBlock.ts), so the editor agrees with what runs.
 * - Its own searches go forward with indexOf, and a search is not repeated over the same stretch
 *   (see `Finder`). Core's patterns it runs (fence lines, output and history markers) must stay
 *   linear on any one line, U+2028 and U+2029 included: core's tests time them on hostile lines.
 */
import { INFO_LANG_RE, tokenizeInfo } from '@md-runbook/core/cellOptions';
import { isFenceClose, matchFenceOpen, type FenceOpen } from '@md-runbook/core/fence';
import { HISTORY_CLOSE_RE, HISTORY_OPEN_RE, OUTPUT_END_RE, OUTPUT_START_RE } from '@md-runbook/core/outputBlock';

export const HIGHLIGHT_KINDS = [
  /** The YAML front matter, `---` lines included. */
  'frontMatter',
  /** An ATX heading line (`## Step`). */
  'heading',
  'bold',
  'italic',
  /** `[text]` of a link or image. */
  'linkText',
  /** `(url)` of a link, or an autolink `<https://…>`. */
  'linkUrl',
  'inlineCode',
  /** `-`, `*`, `+`, `1.` and a task box `[ ]` / `[x]`. */
  'listMarker',
  /** A `>` line. */
  'quote',
  /** The ``` or ~~~ of a fence line. */
  'fence',
  /** The language word of a fence's info string. */
  'fenceLang',
  /** A cell option's name (`timeout`, `kube-context`, a flag such as `skip`). */
  'option',
  /** A cell option's value, quotes included. */
  'optionValue',
  /** A line inside a fenced code block. */
  'code',
  /** An HTML comment that isn't md-runbook's. */
  'comment',
  /** md-runbook's markers: output start and end, note, run history, other `<!-- md-runbook:… -->`. */
  'marker',
  /** The lines an output block wraps. */
  'output',
  /** The `>` lines of a note, after its marker. */
  'note',
  /** A signature or run record signature block (`<!-- md-runbook:signature …` to `-->`). */
  'signature',
] as const;

export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];

export interface Span {
  start: number;
  end: number;
  kind: HighlightKind;
}

/** A piece of one line with the same kinds; `kinds` is outermost first (empty: plain text). */
export interface Run {
  start: number;
  end: number;
  kinds: readonly HighlightKind[];
}

export interface HighlightedLine {
  /** The line's text, without its line end. */
  start: number;
  end: number;
  runs: Run[];
}

const SPACE = 32;
const TAB = 9;
const isBlank = (c: number): boolean => c === SPACE || c === TAB;

/** Line starts and ends (ends exclude the line break: CRLF, lone CR or LF, as core's LINE_RE). */
export function lineBounds(text: string): { starts: number[]; ends: number[] } {
  const starts: number[] = [0];
  const ends: number[] = [];
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) {
      ends.push(i);
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  ends.push(n);
  return { starts, ends };
}

/**
 * Forward searches in one line that never scan the same stretch twice: a search remembers where
 * it looked from and what it found, and a later search from inside that stretch reuses it.
 */
class Finder {
  private readonly memo = new Map<string, { from: number; at: number }>();
  constructor(private readonly s: string) {}
  next(needle: string, from: number): number {
    const m = this.memo.get(needle);
    if (m && from >= m.from && (m.at < 0 || from <= m.at)) return m.at;
    const at = this.s.indexOf(needle, from);
    this.memo.set(needle, { from, at });
    return at;
  }
}

/** Code spans in one line: where each starts → where it ends (after its closing backticks). */
function codeSpans(s: string): Map<number, number> {
  const spans = new Map<number, number>();
  if (s.indexOf('`') < 0) return spans;
  // Backtick runs, in order; then each opener closes at the next run of the same length.
  const runs: { at: number; len: number }[] = [];
  for (let i = 0; i < s.length; ) {
    if (s.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    const at = i;
    while (s.charCodeAt(i) === 96) i++;
    runs.push({ at, len: i - at });
  }
  const byLen = new Map<number, number[]>();
  runs.forEach((r, k) => {
    const list = byLen.get(r.len);
    if (list) list.push(k);
    else byLen.set(r.len, [k]);
  });
  const cursor = new Map<number, number>();
  for (let k = 0; k < runs.length; ) {
    const r = runs[k]!;
    const list = byLen.get(r.len)!;
    let p = cursor.get(r.len) ?? 0;
    while (p < list.length && list[p]! <= k) p++;
    cursor.set(r.len, p);
    const close = list[p];
    if (close === undefined) {
      k++;
      continue;
    }
    const c = runs[close]!;
    spans.set(r.at, c.at + c.len);
    k = close + 1;
  }
  return spans;
}

const isWordChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127;

/** Inline Markdown in s[from, to) of one line at `base`: code, bold, italic, links, comments. */
function inline(
  s: string,
  base: number,
  from: number,
  to: number,
  depth: number,
  code: Map<number, number>,
  find: Finder,
  out: Span[],
): void {
  const push = (a: number, b: number, kind: HighlightKind): void => void out.push({ start: base + a, end: base + b, kind });
  let i = from;
  while (i < to) {
    const c = s.charCodeAt(i);
    if (c === 96) {
      // `code`
      const end = code.get(i);
      if (end !== undefined && end <= to) {
        push(i, end, 'inlineCode');
        i = end;
      } else {
        while (i < to && s.charCodeAt(i) === 96) i++;
      }
      continue;
    }
    if (c === 42 || c === 95) {
      // *italic*, **bold**, _italic_, __bold__
      let k = i;
      while (k < to && s.charCodeAt(k) === c) k++;
      const len = k - i;
      const ch = s[i]!;
      const opens = k < to && !isBlank(s.charCodeAt(k)) && (c === 42 || i === 0 || !isWordChar(s.charCodeAt(i - 1)));
      if (opens && (len === 1 || len === 2)) {
        const delim = len === 2 ? ch + ch : ch;
        const q = find.next(delim, k);
        if (q >= 0 && q + len <= to && q > k && !isBlank(s.charCodeAt(q - 1))) {
          push(i, q + len, len === 2 ? 'bold' : 'italic');
          if (depth < 4) inline(s, base, k, q, depth + 1, code, find, out);
          i = q + len;
          continue;
        }
      }
      i = k;
      continue;
    }
    if (c === 91 || (c === 33 && s.charCodeAt(i + 1) === 91)) {
      // [text](url), ![alt](src)
      const open = c === 33 ? i + 1 : i;
      const r = find.next(']', open + 1);
      if (r >= 0 && r + 1 < to && s.charCodeAt(r + 1) === 40) {
        const p = find.next(')', r + 2);
        if (p >= 0 && p < to) {
          push(i, r + 1, 'linkText');
          if (depth < 4) inline(s, base, open + 1, r, depth + 1, code, find, out);
          push(r + 1, p + 1, 'linkUrl');
          i = p + 1;
          continue;
        }
      }
      i = open + 1;
      continue;
    }
    if (c === 60) {
      // <!-- comment -->, <https://…>
      if (s.startsWith('<!--', i)) {
        const e = find.next('-->', i + 4);
        const end = e >= 0 && e + 3 <= to ? e + 3 : to;
        push(i, end, 'comment');
        i = end;
        continue;
      }
      if (s.startsWith('<http://', i) || s.startsWith('<https://', i) || s.startsWith('<mailto:', i)) {
        // Up to the `>`, stopping at a space or the next `<` (so each `<` is looked past once).
        let k = i + 1;
        while (k < to) {
          const d = s.charCodeAt(k);
          if (d === 62 || d === 60 || isBlank(d)) break;
          k++;
        }
        if (k < to && s.charCodeAt(k) === 62) {
          push(i, k + 1, 'linkUrl');
          i = k + 1;
          continue;
        }
        i = k;
        continue;
      }
    }
    i++;
  }
}

/** Where the first non-blank character of s is (s.length when none). */
function indentOf(s: string): number {
  let t = 0;
  while (t < s.length && isBlank(s.charCodeAt(t))) t++;
  return t;
}

/** `#`…`######` then a blank or the line end, after at most 3 spaces. */
function isHeading(s: string, t: number): boolean {
  if (t > 3 || s.charCodeAt(t) !== 35) return false;
  let k = t;
  while (k < s.length && s.charCodeAt(k) === 35) k++;
  return k - t <= 6 && (k === s.length || isBlank(s.charCodeAt(k)));
}

/** The end of a list marker (and its task box) at t, or -1. */
function listMarkerEnd(s: string, t: number): number {
  const c = s.charCodeAt(t);
  let k: number;
  if (c === 45 || c === 42 || c === 43) k = t + 1;
  else {
    k = t;
    while (k < s.length && k - t < 9 && s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) k++;
    if (k === t || (s.charCodeAt(k) !== 46 && s.charCodeAt(k) !== 41)) return -1;
    k++;
  }
  if (k < s.length && !isBlank(s.charCodeAt(k))) return -1;
  // A task box: "- [ ] ", "- [x] "
  const box = /^[ \t]+\[[ xX]\](?=[ \t]|$)/.exec(s.slice(k, k + 8));
  return box ? k + box[0].length : k;
}

/** Spans of a fence opening line: the fence, the language, the options and their values. */
function fenceLine(base: number, open: FenceOpen, out: Span[]): void {
  const fenceAt = open.indent.length;
  const infoAt = fenceAt + open.len;
  out.push({ start: base + fenceAt, end: base + infoAt, kind: 'fence' });
  const info = open.info;
  // As core reads it: the language as langOf finds it (fence.ts), the options after the first
  // word as INFO_LANG_RE ends it (ASCII blanks only, so `bash x=1` has no options).
  const off = INFO_LANG_RE.exec(info)?.[0].length ?? 0;
  const lang = /^(\s*)([^\s{]+)/.exec(info);
  if (lang) {
    const w = lang[1]!.length;
    const we = Math.min(w + lang[2]!.length, off);
    if (we > w) out.push({ start: base + infoAt + w, end: base + infoAt + we, kind: 'fenceLang' });
  }
  const restAt = infoAt + off;
  for (const tok of tokenizeInfo(info.slice(off))) {
    const keyEnd = tok.start + tok.key.length;
    out.push({ start: base + restAt + tok.start, end: base + restAt + keyEnd, kind: 'option' });
    // The value: after the `=`, with its quotes.
    if (tok.value !== undefined && tok.end > keyEnd + 1)
      out.push({ start: base + restAt + keyEnd + 1, end: base + restAt + tok.end, kind: 'optionValue' });
  }
}

/** The text after `<!--` and blanks, when a line (from t) is an HTML comment's start. */
const commentBody = (s: string, t: number): number => {
  let k = t + 4;
  while (k < s.length && isBlank(s.charCodeAt(k))) k++;
  return k;
};

/** Front matter: `---` on the first line, closed by `---` or `...` (as core's frontMatterLines). */
function frontMatterEnd(text: string, starts: number[], ends: number[]): number {
  const first = text.slice(starts[0]!, ends[0]).replace(/^﻿/, '');
  if (first.trimEnd() !== '---') return -1;
  for (let i = 1; i < starts.length; i++) {
    const l = text.slice(starts[i]!, ends[i]);
    if ((l.startsWith('---') || l.startsWith('...')) && l.slice(3).trim() === '') return i;
  }
  return -1;
}

type State =
  | { in: 'text' }
  | { in: 'fence'; open: FenceOpen }
  | { in: 'output'; until: number }
  | { in: 'comment'; kind: HighlightKind }
  | { in: 'note' };

/** The spans of a runbook's text: sorted by start, nested, none across a line end. */
export function highlight(text: string): Span[] {
  const out: Span[] = [];
  const { starts, ends } = lineBounds(text);
  const count = starts.length;
  const line = (i: number): string => text.slice(starts[i]!, ends[i]);
  const whole = (i: number, kind: HighlightKind): void => {
    if (ends[i]! > starts[i]!) out.push({ start: starts[i]!, end: ends[i]!, kind });
  };
  let first = 0;
  const fm = frontMatterEnd(text, starts, ends);
  if (fm > 0) {
    for (let i = 0; i <= fm; i++) whole(i, 'frontMatter');
    first = fm + 1;
  }
  // For each line, the next output end marker at or after it (-1: none), so an output start
  // without an end is a marker only.
  const nextEnd = new Int32Array(count);
  let seen = -1;
  for (let i = count - 1; i >= first; i--) {
    const s = line(i);
    const t = indentOf(s);
    if (s.startsWith('<!--', t) && OUTPUT_END_RE.test(s)) seen = i;
    nextEnd[i] = seen;
  }
  let state: State = { in: 'text' };
  for (let i = first; i < count; i++) {
    const s = line(i);
    const base = starts[i]!;
    if (state.in === 'fence') {
      if (isFenceClose(s, state.open)) {
        whole(i, 'fence');
        state = { in: 'text' };
      } else whole(i, 'code');
      continue;
    }
    if (state.in === 'output') {
      if (i === state.until) {
        whole(i, 'marker');
        state = { in: 'text' };
      } else whole(i, 'output');
      continue;
    }
    if (state.in === 'comment') {
      whole(i, state.kind);
      if (s.indexOf('-->') >= 0) state = { in: 'text' };
      continue;
    }
    const t = indentOf(s);
    if (state.in === 'note') {
      if (s.charCodeAt(t) === 62) {
        whole(i, 'note');
        continue;
      }
      state = { in: 'text' };
    }
    if (s.startsWith('<!--', t)) {
      const body = commentBody(s, t);
      const closes = s.indexOf('-->', t + 4) >= 0;
      if (s.startsWith('md-runbook:', body)) {
        if (OUTPUT_START_RE.test(s)) {
          whole(i, 'marker');
          const until = i + 1 < count ? nextEnd[i + 1]! : -1;
          if (until > i) state = { in: 'output', until };
          continue;
        }
        if (closes) {
          whole(i, 'marker');
          if (s.startsWith('md-runbook:note', body)) state = { in: 'note' };
          continue;
        }
        const name = s.slice(body, body + 40);
        const kind: HighlightKind = /^md-runbook:(record-)?signature\b/.test(name) ? 'signature' : 'marker';
        whole(i, kind);
        state = { in: 'comment', kind };
        continue;
      }
      if (!closes) {
        // An HTML comment over several lines: up to the line with `-->`, or the end (CommonMark).
        whole(i, 'comment');
        state = { in: 'comment', kind: 'comment' };
        continue;
      }
    }
    if (s.charCodeAt(t) === 60 && (HISTORY_OPEN_RE.test(s) || HISTORY_CLOSE_RE.test(s))) {
      whole(i, 'marker');
      continue;
    }
    const open = s.charCodeAt(t) === 96 || s.charCodeAt(t) === 126 ? matchFenceOpen(s) : null;
    if (open) {
      fenceLine(base, open, out);
      state = { in: 'fence', open };
      continue;
    }
    if (t === s.length) continue;
    const code = codeSpans(s);
    const find = new Finder(s);
    if (isHeading(s, t)) {
      whole(i, 'heading');
      inline(s, base, t, s.length, 1, code, find, out);
      continue;
    }
    if (s.charCodeAt(t) === 62) {
      whole(i, 'quote');
      inline(s, base, t + 1, s.length, 1, code, find, out);
      continue;
    }
    const marker = listMarkerEnd(s, t);
    if (marker > 0) {
      out.push({ start: base + t, end: base + marker, kind: 'listMarker' });
      inline(s, base, marker, s.length, 0, code, find, out);
      continue;
    }
    inline(s, base, t, s.length, 0, code, find, out);
  }
  return out;
}

/**
 * The text's lines, each cut into runs of the same kinds (plain text included), for a renderer:
 * a run's colour is that of its innermost kind.
 */
export function lineRuns(text: string, spans: readonly Span[]): HighlightedLine[] {
  const { starts, ends } = lineBounds(text);
  const lines: HighlightedLine[] = [];
  let k = 0;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = ends[i]!;
    const runs: Run[] = [];
    // Open spans, outermost first, as a stack of their ends.
    const stack: Span[] = [];
    let at = start;
    const emit = (to: number): void => {
      if (to > at) runs.push({ start: at, end: to, kinds: stack.map((sp) => sp.kind) });
      at = Math.max(at, to);
    };
    while (k < spans.length && spans[k]!.start < end) {
      const sp = spans[k]!;
      if (sp.start < start) {
        k++;
        continue;
      }
      // Close the spans that end before this one starts.
      while (stack.length && stack[stack.length - 1]!.end <= sp.start) {
        emit(stack[stack.length - 1]!.end);
        stack.pop();
      }
      emit(sp.start);
      stack.push(sp);
      k++;
    }
    while (stack.length) {
      emit(Math.min(stack[stack.length - 1]!.end, end));
      stack.pop();
    }
    emit(end);
    lines.push({ start, end, runs });
  }
  return lines;
}

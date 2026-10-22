/**
 * Colours for cell output: log levels by their words, as log viewers show them (Grafana's levels
 * and colours, VS Code's log highlighting rules, syslog, Nevis, klog), success words in green,
 * and stderr lines in red. Lines that bring their own ANSI colours keep them. Both clients use
 * this: VS Code as ANSI codes in the output, the app as coloured spans. The saved file stays plain
 * text; which lines came from stderr is kept in the output block's `stderr=` attribute.
 */

import { stripAnsi } from './ansi';

export type OutputLevel = 'critical' | 'error' | 'warning' | 'info' | 'debug' | 'trace' | 'success';

export interface OutputSpan {
  text: string;
  level?: OutputLevel;
}

interface LevelWords {
  level: OutputLevel;
  /** Matched in capitals, and Capitalized where `capitalized` is true. */
  words: string[];
  capitalized?: boolean;
  /** Matched in lower case only before a colon (`error:`). */
  colon?: string[];
  /** Matched in brackets, any case (`[warn]`). */
  brackets?: string[];
  /** klog's line prefix letter (`E1022 12:00:00.000000 …`). */
  klog?: string;
  /** Other patterns (no capture groups). */
  extra?: string[];
}

export const LEVEL_WORDS: readonly LevelWords[] = [
  {
    level: 'critical',
    words: ['EMERGENCY', 'EMERG', 'ALERT', 'CRITICAL', 'CRIT', 'FATAL', 'PANIC'],
    capitalized: true,
    colon: ['fatal', 'panic', 'critical'],
    brackets: ['fatal', 'fatl', 'ftl', 'crit', 'critical', 'emerg', 'alert'],
    klog: 'F',
  },
  {
    level: 'error',
    words: ['ERROR', 'ERR', 'EROR', 'FAIL', 'FAILED', 'FAILURE', 'EE'],
    capitalized: true,
    colon: ['error', 'err'],
    brackets: ['error', 'eror', 'err', 'er', 'e', 'fail', 'failed'],
    klog: 'E',
    extra: ['\\b[A-Za-z.]*Exception\\b', '[✗✘]'],
  },
  {
    level: 'warning',
    words: ['WARNING', 'WARN', 'WRN', 'WW'],
    capitalized: true,
    colon: ['warning', 'warn'],
    brackets: ['warning', 'warn', 'wrn', 'wn', 'w'],
    klog: 'W',
  },
  {
    level: 'info',
    words: ['INFORMATIONAL', 'INFORMATION', 'INFO', 'NOTICE', 'HINT', 'II'],
    capitalized: true,
    colon: ['info', 'notice', 'hint'],
    brackets: ['information', 'info', 'inf', 'in', 'i', 'notice'],
    klog: 'I',
  },
  {
    level: 'debug',
    words: ['DEBUG_LOW', 'DEBUG_MED', 'DEBUG_HIGH', 'DEBUG_MAX', 'DBG_LOW', 'DBG_MED', 'DBG_HIGH', 'DBG_MAX', 'DEBUG', 'DBUG', 'DBG'],
    capitalized: true,
    colon: ['debug'],
    brackets: ['debug', 'dbug', 'dbg', 'de', 'd'],
  },
  {
    level: 'trace',
    words: ['TRACE', 'VERBOSE', 'VRB'],
    capitalized: true,
    colon: ['trace', 'verbose'],
    brackets: ['trace', 'verbose', 'verb', 'vrb', 'vb', 'v'],
  },
  {
    level: 'success',
    words: ['SUCCESSFUL', 'SUCCEEDED', 'SUCCESS', 'COMPLETED', 'PASSED', 'PASS', 'DONE', 'OK'],
    capitalized: true,
    colon: ['success', 'ok', 'done'],
    brackets: ['success', 'ok', 'pass', 'passed', 'done'],
    extra: ['[✓✔]'],
  },
];

/** Capitalized forms that are too common in prose to colour (`Notice that …`, `Pass the …`, `Ok, …`). */
const NOT_CAPITALIZED = new Set(['ALERT', 'NOTICE', 'HINT', 'PASS', 'DONE', 'OK', 'EE', 'WW', 'II', 'ERR', 'EROR', 'CRIT', 'EMERG', 'WRN', 'DBUG', 'DBG', 'VRB']);

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cap = (w: string): string => w[0] + w.slice(1).toLowerCase();

/**
 * One capture group per level, in table order (the first level that matches wins). Whole words
 * by `\b`, so `ERROR_CODE` and `errors` stay plain while `5-NOTICE` (Nevis) matches. No named
 * groups or lookbehind: the app's JavaScript engine (Hermes) is not sure to have them.
 */
const MATCHER = new RegExp(
  LEVEL_WORDS.map((l) => {
    const alts: string[] = [];
    const words = [...l.words, ...(l.capitalized ? l.words.filter((w) => !NOT_CAPITALIZED.has(w) && !w.includes('_')).map(cap) : [])];
    alts.push(`\\b(?:${words.map(esc).join('|')})\\b`);
    if (l.colon?.length) alts.push(`\\b(?:${l.colon.map(esc).join('|')})(?=:)`);
    if (l.brackets?.length) alts.push(`\\[(?:${l.brackets.map((b) => b.split('').map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join('')).join('|')})\\]`);
    if (l.klog) alts.push(`^${l.klog}\\d{4} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?`);
    if (l.extra) alts.push(...l.extra);
    return `(${alts.join('|')})`;
  }).join('|'),
  'gu',
);

const ANSI_IN_LINE = /\u001b\[[0-9;]*m/;

/** The words of a line with their level; a line with ANSI colours of its own is one plain span. */
export function levelSpans(line: string): OutputSpan[] {
  if (ANSI_IN_LINE.test(line)) return [{ text: line }];
  const spans: OutputSpan[] = [];
  let at = 0;
  MATCHER.lastIndex = 0;
  for (let m = MATCHER.exec(line); m; m = MATCHER.exec(line)) {
    const k = m.findIndex((g, i) => i > 0 && g !== undefined);
    const level = k > 0 ? LEVEL_WORDS[k - 1]?.level : undefined;
    if (m[0] === '') {
      MATCHER.lastIndex++;
      continue;
    }
    if (!level) continue;
    if (m.index! > at) spans.push({ text: line.slice(at, m.index) });
    spans.push({ text: m[0], level });
    at = m.index! + m[0].length;
  }
  if (at < line.length || spans.length === 0) spans.push({ text: line.slice(at) });
  return spans;
}

// ---- ANSI, for VS Code's output (it shows the theme's terminal colours) ----

/** SGR codes per level: Grafana's colours in the terminal palette (purple, red, yellow, blue, grey, light blue, green). */
export const LEVEL_SGR: Record<OutputLevel, string> = {
  critical: '1;35',
  error: '31',
  warning: '33',
  info: '34',
  debug: '90',
  trace: '94',
  success: '32',
};
const RED = '31';

export interface ColorOptions {
  /** Colour the level and success words. */
  levels: boolean;
  /** Show the whole text in red (it came from stderr). */
  stderr: boolean;
}

/** `text` (whole lines, or the end of a stream) with ANSI colours added. */
export function colorizeAnsi(text: string, opts: ColorOptions): string {
  if (!opts.levels && !opts.stderr) return text;
  return text
    .split('\n')
    .map((line) => {
      if (line === '' || ANSI_IN_LINE.test(line)) return line;
      const base = opts.stderr ? `\u001b[${RED}m` : '';
      const reset = opts.stderr ? `\u001b[0;${RED}m` : '\u001b[0m';
      const body = opts.levels
        ? levelSpans(line)
            .map((s) => (s.level ? `\u001b[${LEVEL_SGR[s.level]}m${s.text}${reset}` : s.text))
            .join('')
        : line;
      return opts.stderr ? `${base}${body}\u001b[0m` : body;
    })
    .join('\n');
}

// ---- which lines of a saved output came from stderr ----

/** Marks stderr lines in a transcript until the output is processed (a private-use character). */
export const STDERR_MARK = '';

/** `text` from stderr, each line (and each `\r` rewrite of it) marked. */
export function markStderr(text: string): string {
  return text.replace(/(^|\n|\r(?!\n))(?=[^\n\r])/g, `$1${STDERR_MARK}`);
}

/** The text without stderr marks, and the 0-based indexes of the lines that had one. */
export function splitStderrMarks(text: string): { text: string; stderr: number[] } {
  if (!text.includes(STDERR_MARK)) return { text, stderr: [] };
  const stderr: number[] = [];
  const lines = text.split('\n').map((line, i) => {
    if (!line.includes(STDERR_MARK)) return line;
    stderr.push(i);
    return line.split(STDERR_MARK).join('');
  });
  return { text: lines.join('\n'), stderr };
}

/** `2,4-6` for lines 1, 3, 4, 5 (0-based in, 1-based out): the `stderr=` attribute. */
export function formatLineSet(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(i === j ? `${sorted[i]! + 1}` : `${sorted[i]! + 1}-${sorted[j]! + 1}`);
    i = j + 1;
  }
  return parts.join(',');
}

/** The 0-based lines of a `stderr=` attribute; nothing for a malformed one. */
export function parseLineSet(attr: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!attr || !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(attr)) return out;
  for (const part of attr.split(',')) {
    const [a, b = a] = part.split('-').map(Number) as [number, number?];
    for (let n = a; n <= b && n - a < 100_000; n++) out.add(n - 1);
  }
  return out;
}

/** A saved output with its colours back: stderr lines in red, level words coloured. */
export function colorizeSaved(text: string, stderrAttr: string | undefined, levels: boolean, stderrRed: boolean): string {
  const stderr = stderrRed ? parseLineSet(stderrAttr) : new Set<number>();
  return text
    .split('\n')
    .map((line, i) => colorizeAnsi(line, { levels, stderr: stderr.has(i) }))
    .join('\n');
}

/** Plain text of a line (ANSI removed), for places that can't show colours. */
export const plainLine = (line: string): string => stripAnsi(line);

// ---- styled spans, for clients that draw colours themselves (the app) ----

/** The terminal's colour names (the theme decides the actual colours). */
export type TermColor = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'grey' | 'brightBlue' | 'white' | 'black';

export interface StyledSpan {
  text: string;
  color?: TermColor;
  bold?: boolean;
}

const LEVEL_STYLE: Record<OutputLevel, { color: TermColor; bold?: boolean }> = {
  critical: { color: 'magenta', bold: true },
  error: { color: 'red' },
  warning: { color: 'yellow' },
  info: { color: 'blue' },
  debug: { color: 'grey' },
  trace: { color: 'brightBlue' },
  success: { color: 'green' },
};

const SGR_COLORS: Record<number, TermColor> = {
  30: 'black',
  31: 'red',
  32: 'green',
  33: 'yellow',
  34: 'blue',
  35: 'magenta',
  36: 'cyan',
  37: 'white',
  90: 'grey',
  91: 'red',
  92: 'green',
  93: 'yellow',
  94: 'brightBlue',
  95: 'magenta',
  96: 'cyan',
  97: 'white',
};

/** A line's own ANSI colours (SGR: the 16 colours, bold, resets); other escape codes are dropped. */
export function ansiSpans(line: string): StyledSpan[] {
  const spans: StyledSpan[] = [];
  let color: TermColor | undefined;
  let bold = false;
  const push = (text: string): void => {
    const t = stripAnsi(text);
    if (t !== '') spans.push({ text: t, ...(color ? { color } : {}), ...(bold ? { bold } : {}) });
  };
  let at = 0;
  for (const m of line.matchAll(/\u001b\[([0-9;]*)m/g)) {
    push(line.slice(at, m.index));
    at = m.index! + m[0].length;
    const codes = m[1] === '' ? [0] : m[1]!.split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) [color, bold] = [undefined, false];
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) color = undefined;
      else if (SGR_COLORS[c]) color = SGR_COLORS[c];
      else if (c === 38 && codes[i + 1] === 5) {
        const n = codes[i + 2] ?? -1;
        color = n >= 0 && n < 8 ? SGR_COLORS[30 + n] : n >= 8 && n < 16 ? SGR_COLORS[82 + n] : color;
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2) i += 4;
    }
  }
  push(line.slice(at));
  return spans;
}

/**
 * How to draw one line: its own ANSI colours if it has any, else stderr in red and level words
 * in their colours (as colorizeAnsi does for VS Code).
 */
export function styledSpans(line: string, opts: ColorOptions): StyledSpan[] {
  if (ANSI_IN_LINE.test(line)) return ansiSpans(line);
  const base: Pick<StyledSpan, 'color'> = opts.stderr ? { color: 'red' } : {};
  if (!opts.levels) return [{ text: line, ...base }];
  return levelSpans(line).map((s) => (s.level ? { text: s.text, ...LEVEL_STYLE[s.level] } : { text: s.text, ...base }));
}

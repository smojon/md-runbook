/**
 * The persisted output block that follows a code block:
 *
 *   <!-- md-runbook:output start exit=0 ran=2026-10-18T14:20:00+02:00 -->
 *   ```text
 *   ...output...
 *   ```
 *   <!-- md-runbook:output end -->
 */

import { stripAnsi } from './ansi';
import { STDERR_MARK, formatLineSet, redactMarked, splitStderrMarks } from './outputColors';
import { applyTerminalControls } from './terminalText';
import { addIndent } from './fence';
import { toLf } from './lines';

export const OUTPUT_START_RE = /^[ \t]*<!--[ \t]*md-runbook:output start\b(.*?)-->[ \t]*$/;
export const OUTPUT_END_RE = /^[ \t]*<!--[ \t]*md-runbook:output end[ \t]*-->[ \t]*$/;

/** History of earlier runs, directly after the latest output block (see ./history). */
export const HISTORY_OPEN_RE = /^[ \t]*<details>[ \t]*<summary>[ \t]*md-runbook:[^<]*<\/summary>[ \t]*$/;
export const HISTORY_CLOSE_RE = /^[ \t]*<\/details>[ \t]*$/;

const ATTR_RE = /([\w-]+)=(?:"([^"]*)"|(\S+))/g;

export function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const key = m[1];
    if (key) attrs[key] = decodeAttr(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/** A value as formatAttrs wrote it, its %XX escapes decoded (an escape that isn't UTF-8 stays as it is). */
function decodeAttr(v: string): string {
  if (!v.includes('%')) return v;
  return v.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** The longest attribute value written (a host's name, a context, a person: none is longer). */
export const MAX_ATTR_LENGTH = 200;

/** Attributes whose value is a path (a call's runbook and copy): never cut. */
const PATH_ATTRS = new Set(['copy', 'runbook']);

/**
 * A marker's attributes, each value one piece of the comment: `"`, `<`, `>`, `%`, a dash before a
 * dash, line breaks of any kind (CR, LF, U+0085, U+2028, U+2029) and other control characters are
 * written as %XX escapes (UTF-8), which parseAttrs decodes. A value is at most MAX_ATTR_LENGTH
 * characters, but for line numbers such as `stderr=1-3,5` and paths (`copy=`, `runbook=`).
 * Round 4 dropped these characters and collapsed `--`, so a call's copy `db--restore.md` was
 * continued as a file that doesn't exist (security review, round 5).
 */
export function formatAttrs(attrs: Record<string, string>): string {
  let s = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (!/^[\w-]+$/.test(k)) continue;
    const capped = /^[0-9,-]*$/.test(v) || PATH_ATTRS.has(k) ? v : v.slice(0, MAX_ATTR_LENGTH);
    const clean = capped.replace(/["<>%\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]|-(?=-)/gu, (c) => (c === '-' ? '%2D' : encodeURIComponent(c)));
    s += ' ' + k + '=' + (clean === '' || /\s/.test(clean) ? `"${clean}"` : clean);
  }
  return s;
}

/** Normalize newlines and collapse carriage-return progress updates to their final state. */
export function normalizeNewlines(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const parts = line.split('\r');
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i] !== '') return parts[i];
      }
      return '';
    })
    .join('\n');
}

export function truncationNote(omitted: number): string {
  return `… [md-runbook: ${omitted} line${omitted === 1 ? '' : 's'} truncated] …`;
}

/** Keep the first and last lines up to `max` in total, with a note where lines were dropped. */
export function truncateLines(text: string, max: number): string {
  if (max <= 0) return text;
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const omitted = lines.length - max;
  return [...lines.slice(0, head), truncationNote(omitted), ...lines.slice(lines.length - tail)].join('\n');
}

export interface OutputTextOptions {
  stripAnsi: boolean;
  maxOutputLines: number;
  redact?: (text: string) => string;
}

/** Turn raw process output into the text that is written to disk. */
export function processOutputText(text: string, opts: OutputTextOptions): string {
  return processOutput(text, opts).text;
}

/**
 * The same, and which of the written lines came from stderr (`stderr=`, as `2,4-6`; '' for none):
 * stderr lines are marked in `text` (outputColors.markStderr) and the marks are removed here.
 */
export function processOutput(text: string, opts: OutputTextOptions): { text: string; stderr: string } {
  // As a terminal shows it (cursor movements applied), then without colours: the movements are
  // escape sequences too, so they are applied before stripAnsi takes the rest away.
  let t = applyTerminalControls(text.replace(/\r\n/g, '\n'), STDERR_MARK);
  if (opts.stripAnsi) t = stripAnsi(t);
  // Redacted without the stderr marks: a mark inside a secret kept a pattern from matching it.
  if (opts.redact) t = redactMarked(t, opts.redact);
  t = t.replace(/\n+$/, '');
  const marked = splitStderrMarks(truncateLines(t, opts.maxOutputLines));
  return { text: marked.text, stderr: formatLineSet(marked.stderr) };
}

/** Render an output block from already-processed text. Ends with `eol`. */
export function formatOutputBlock(text: string, attrs: Record<string, string>, indent: string, eol: string): string {
  const body = text === '' ? [] : toLf(text).split('\n');
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
  const lines = [`<!-- md-runbook:output start${formatAttrs(attrs)} -->`, fence + 'text', ...body, fence, '<!-- md-runbook:output end -->'];
  return lines.map((l) => addIndent(l, indent)).join(eol) + eol;
}

/** Longest backtick run at the start of any line; the output fence must be longer. */
function longestBacktickRun(lines: readonly string[]): number {
  let max = 0;
  for (const line of lines) {
    const m = /^[ \t]*(`+)/.exec(line);
    if (m?.[1]) max = Math.max(max, m[1].length);
  }
  return max;
}

/** Duration attribute in seconds with millisecond precision, e.g. 1.234s. */
export function formatDurationAttr(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(3)}s`;
}

/** ISO 8601 timestamp in local time with UTC offset, e.g. 2026-10-18T14:20:00+02:00. */
export function formatLocalIso(d: Date): string {
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

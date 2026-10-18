/**
 * Where code cells sit in the Markdown text, and edits to one cell's output block. Used to run
 * cells from the plain text editor (CodeLens) without going through the notebook.
 */

import { OutputInput, ParsedDocument, WriteOptions, isCodeMeta } from './model';
import { parse } from './parser';
import { serialize, toCellInputs } from './writer';

export interface CodeCellLocation {
  /** Index into `ParsedDocument.cells` (the same index the cell has in the notebook). */
  cellIndex: number;
  /** 0-based line of the opening fence. */
  line: number;
  /** 0-based line of the closing fence. */
  closeLine: number;
  language: string;
  /** The fence info string (language word plus options), e.g. for proposal state. */
  info: string;
  source: string;
  /** Attributes of the cell's output block, if it has one. */
  outputAttrs?: Record<string, string>;
}

function countLines(s: string): number {
  return s.match(/\r\n|\n|\r/g)?.length ?? 0;
}

/** Line positions of every code cell, computed from the parsed cells' original bytes. */
export function locateCodeCells(doc: ParsedDocument): CodeCellLocation[] {
  const out: CodeCellLocation[] = [];
  let line = 0;
  doc.cells.forEach((cell, cellIndex) => {
    const m = cell.meta;
    if (isCodeMeta(m)) {
      const open = line + countLines(m.lead);
      out.push({
        cellIndex,
        line: open,
        closeLine: open + 1 + countLines(m.body),
        language: m.lang,
        info: m.info,
        source: cell.value,
        outputAttrs: cell.output?.attrs,
      });
      line += countLines(m.lead + m.open + m.body + m.close + (m.output?.raw ?? '') + (m.history?.raw ?? '') + m.trail);
    } else {
      line += countLines(m.lead + m.content + m.trail);
    }
  });
  return out;
}

/**
 * `text` with the output of cell `cellIndex` replaced; every other byte is kept. Returns
 * undefined if that cell is not a code cell.
 */
export function setCellOutput(text: string, cellIndex: number, output: OutputInput, opts: WriteOptions): string | undefined {
  const doc = parse(text);
  if (doc.cells[cellIndex]?.kind !== 'code') return undefined;
  const cells = toCellInputs(doc);
  cells[cellIndex]!.output = output;
  return serialize(doc.meta, cells, opts);
}

export interface TextChange {
  start: number;
  /** End offset in the old text. */
  end: number;
  text: string;
}

/** The smallest single replacement turning `a` into `b` (never splitting CRLF or a surrogate pair). */
export function minimalChange(a: string, b: string): TextChange {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  const splits = (s: string, i: number): boolean =>
    i > 0 && i < s.length && ((s[i - 1] === '\r' && s[i] === '\n') || /[\ud800-\udbff]/.test(s[i - 1]!));
  while (p > 0 && (splits(a, p) || splits(b, p))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  while (s > 0 && (splits(a, a.length - s) || splits(b, b.length - s))) s--;
  return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
}

/** Short CodeLens summary of an output block, e.g. "✓ exit 0 · 1.2s · 5m ago". */
export function outputSummary(attrs: Record<string, string>, now: Date = new Date()): string {
  const exit = attrs.exit ?? '?';
  const parts = [`${exit === '0' ? '✓' : exit === 'skipped' ? '–' : '✗'} ${/^-?\d+$/.test(exit) ? `exit ${exit}` : exit}`];
  const secs = attrs.duration ? parseFloat(attrs.duration) : NaN;
  if (!isNaN(secs)) parts.push(secs < 60 ? `${secs.toFixed(1)}s` : `${Math.floor(secs / 60)}m${Math.round(secs % 60)}s`);
  const when = Date.parse(attrs.ended ?? attrs.ran ?? '');
  if (!isNaN(when)) parts.push(relativeTime(now.getTime() - when));
  return parts.join(' · ');
}

function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

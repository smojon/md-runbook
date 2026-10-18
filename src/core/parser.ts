/**
 * Markdown text -> notebook cells. Every byte of the input ends up in exactly one cell's
 * metadata, so `serialize(parse(text))` reproduces `text` exactly.
 */

import { isFenceClose, langOf, matchFenceOpen, stripIndent } from './fence';
import { isRunnableFenceLang, languageIdForFence } from './languages';
import { BLANK_RE, Line, dominantEol, joinRaw, splitLines } from './lines';
import type { CodeMeta, MarkupMeta, OutputMeta, ParsedCell, ParsedDocument, ParsedOutput } from './model';
import { OUTPUT_END_RE, OUTPUT_START_RE, parseAttrs } from './outputBlock';

export function parse(input: string): ParsedDocument {
  let text = input;
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) {
    bom = true;
    text = text.slice(1);
  }
  const lines = splitLines(text);
  const docEol = dominantEol(lines, '\n');
  const cells: ParsedCell[] = [];
  // Whitespace seen before the first cell; it becomes that cell's lead.
  let pendingLead = '';

  const pushMarkdown = (seg: Line[]): void => {
    if (seg.length === 0) return;
    let a = 0;
    let b = seg.length;
    while (a < b && BLANK_RE.test(seg[a]!.text)) a++;
    while (b > a && BLANK_RE.test(seg[b - 1]!.text)) b--;
    if (a === b) {
      // Only blank lines: attach them to the neighbouring cell instead of making an empty cell.
      const raw = joinRaw(seg);
      const prev = cells[cells.length - 1];
      if (prev) prev.meta.trail += raw;
      else pendingLead += raw;
      return;
    }
    const content = seg.slice(a, b);
    const value = content.map((l) => l.text).join('\n');
    const meta: MarkupMeta = {
      kind: 'markup',
      lead: pendingLead + joinRaw(seg.slice(0, a)),
      content: joinRaw(content),
      trail: joinRaw(seg.slice(b)),
      eol: dominantEol(content, docEol),
      finalEol: content[content.length - 1]!.eol,
      value,
    };
    pendingLead = '';
    cells.push({ kind: 'markup', value, languageId: 'markdown', meta });
  };

  let mdStart = 0;
  let i = 0;
  while (i < lines.length) {
    const open = matchFenceOpen(lines[i]!.text);
    if (!open) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !isFenceClose(lines[j]!.text, open)) j++;
    if (j >= lines.length) {
      // Unclosed fence: per CommonMark it swallows the rest of the document. Leave it all as markdown.
      break;
    }
    const lang = langOf(open.info);
    if (!isRunnableFenceLang(lang)) {
      // Skip over non-runnable fences so fences nested inside them are not picked up.
      i = j + 1;
      continue;
    }

    pushMarkdown(lines.slice(mdStart, i));

    const openLine = lines[i]!;
    const contentLines = lines.slice(i + 1, j);
    const value = contentLines.map((l) => stripIndent(l.text, open.indent)).join('\n');
    const meta: CodeMeta = {
      kind: 'code',
      lead: pendingLead,
      open: openLine.text + openLine.eol,
      body: joinRaw(contentLines),
      close: lines[j]!.text + lines[j]!.eol,
      trail: '',
      indent: open.indent,
      fenceChar: open.char,
      fenceLen: open.len,
      info: open.info,
      lang,
      eol: dominantEol([openLine, ...contentLines], docEol),
      value,
    };
    pendingLead = '';
    const cell: ParsedCell = { kind: 'code', value, languageId: languageIdForFence(lang), meta };

    let next = j + 1;
    const out = parseOutputBlock(lines, next);
    if (out) {
      meta.output = out.meta;
      cell.output = out.output;
      next = out.end;
    }
    cells.push(cell);
    i = next;
    mdStart = next;
  }
  pushMarkdown(lines.slice(mdStart));

  if (pendingLead !== '') {
    // Whitespace-only document.
    cells.push({
      kind: 'markup',
      value: '',
      languageId: 'markdown',
      meta: { kind: 'markup', lead: pendingLead, content: '', trail: '', eol: docEol, finalEol: '', value: '' },
    });
  }

  return { meta: { bom, eol: docEol }, cells };
}

/**
 * Recognize an output block starting at line `k` (optionally after blank lines). Anything that
 * does not match the exact structure is not an output block and stays markdown.
 */
function parseOutputBlock(
  lines: readonly Line[],
  k: number,
): { meta: OutputMeta; output: ParsedOutput; end: number } | null {
  let g = k;
  while (g < lines.length && BLANK_RE.test(lines[g]!.text)) g++;
  const start = lines[g] ? OUTPUT_START_RE.exec(lines[g]!.text) : null;
  if (!start) return null;
  const f = g + 1;
  const fence = lines[f] ? matchFenceOpen(lines[f]!.text) : null;
  if (!fence) return null;
  let c = f + 1;
  while (c < lines.length && !isFenceClose(lines[c]!.text, fence)) c++;
  const e = c + 1;
  if (e >= lines.length || !OUTPUT_END_RE.test(lines[e]!.text)) return null;

  const text = lines
    .slice(f + 1, c)
    .map((l) => stripIndent(l.text, fence.indent))
    .join('\n');
  return {
    meta: { raw: joinRaw(lines.slice(k, e + 1)), gap: joinRaw(lines.slice(k, g)) },
    output: { text, attrs: parseAttrs(start[1] ?? '') },
    end: e + 1,
  };
}

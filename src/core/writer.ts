/**
 * Notebook cells -> Markdown text. Cells whose value (and language) are unchanged since `parse`
 * are written from their original bytes; edited and new cells are rebuilt.
 */

import { addIndent, longestClosingRun, replaceLang } from './fence';
import { fenceForLanguageId, languageIdForFence } from './languages';
import { DocEol, endsWithNewline, toLf, trailingEol } from './lines';
import {
  CellInput,
  CodeMeta,
  DEFAULT_WRITE_OPTIONS,
  DocMeta,
  MarkupMeta,
  OutputInput,
  ParsedDocument,
  WriteOptions,
  isCodeMeta,
  isDocMeta,
  isMarkupMeta,
} from './model';
import { formatHistoryBlock } from './history';
import { formatOutputBlock, processOutputText } from './outputBlock';
import { parse } from './parser';

export function serialize(doc: DocMeta | undefined, cells: readonly CellInput[], opts: WriteOptions): string {
  const docMeta: DocMeta = isDocMeta(doc) ? doc : { bom: false, eol: '\n' };
  const eol = docMeta.eol;
  let out = '';
  let prevWasNew = false;
  // In an untouched file only one side of a cell boundary carries blank lines (the previous
  // cell's trail or the next cell's lead). If both do, cells were deleted or moved: drop the lead.
  let prevHadTrail = false;

  for (const cell of cells) {
    const value = toLf(cell.value);
    const meta =
      cell.kind === 'markup'
        ? isMarkupMeta(cell.meta)
          ? cell.meta
          : undefined
        : isCodeMeta(cell.meta)
          ? cell.meta
          : undefined;
    const isNew = meta === undefined;

    if (out !== '') {
      if (!endsWithNewline(out)) out += eol;
      // Keep new cells visually and structurally separate from their neighbours.
      if ((isNew || prevWasNew) && !endsWithBlankLine(out)) out += eol;
    }

    const skipLead = prevHadTrail && out !== '';
    if (cell.kind === 'markup') {
      out += renderMarkup(value, meta as MarkupMeta | undefined, eol, skipLead);
    } else {
      out += renderCode(value, cell.languageId, meta as CodeMeta | undefined, cell.output, eol, opts, skipLead);
    }
    prevWasNew = isNew;
    prevHadTrail = meta !== undefined && meta.trail !== '';
  }

  return (docMeta.bom ? '\uFEFF' : '') + out;
}

function endsWithBlankLine(s: string): boolean {
  return /(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)$/.test(s) || /^[ \t]*(?:\r\n|\n|\r)$/.test(s);
}

function joinLines(value: string, eol: string, indent = ''): string {
  if (value === '') return '';
  return value
    .split('\n')
    .map((l) => addIndent(l, indent))
    .join(eol);
}

function renderMarkup(value: string, meta: MarkupMeta | undefined, eol: DocEol, skipLead: boolean): string {
  if (!meta) return value === '' ? '' : joinLines(value, eol) + eol;
  const lead = skipLead ? '' : meta.lead;
  if (value === meta.value) return lead + meta.content + meta.trail;
  const content = value === '' ? '' : joinLines(value, meta.eol) + meta.finalEol;
  return lead + content + meta.trail;
}

function renderCode(
  value: string,
  languageId: string | undefined,
  meta: CodeMeta | undefined,
  output: OutputInput | undefined,
  docEol: DocEol,
  opts: WriteOptions,
  skipLead: boolean,
): string {
  const langChanged = meta !== undefined && languageId !== undefined && languageIdForFence(meta.lang) !== languageId;
  let s = skipLead ? '' : (meta?.lead ?? '');

  if (meta && !langChanged && value === meta.value) {
    s += meta.open + meta.body + meta.close;
  } else {
    const eol = meta?.eol ?? docEol;
    const indent = meta?.indent ?? '';
    const char = meta?.fenceChar ?? '`';
    const baseLen = meta?.fenceLen ?? 3;
    const len = Math.max(baseLen, longestClosingRun(value.split('\n'), char) + 1);
    const token = fenceForLanguageId(languageId ?? 'shellscript');
    const fence = indent + char.repeat(len);

    let open: string;
    let close: string;
    if (meta) {
      const info = langChanged ? replaceLang(meta.info, token) : meta.info;
      const openEol = trailingEol(meta.open);
      // A lone CR followed by a rebuilt body could merge into CRLF; rewrite such a line.
      const keepOpen = len === baseLen && !langChanged && openEol !== '\r';
      open = keepOpen ? meta.open : fence + info + (openEol === '\r' ? eol : openEol || eol);
      close = len === baseLen ? meta.close : fence + trailingEol(meta.close);
    } else {
      open = fence + token + eol;
      close = fence + eol;
    }
    const body = value === '' ? '' : joinLines(value, eol, indent) + eol;
    s += open + body + close;
  }

  const block = renderOutput(output, meta, docEol, opts);
  if (block !== '') {
    if (!endsWithNewline(s)) s += meta?.eol ?? docEol;
    s += block;
  }
  return s + (meta?.trail ?? '');
}

function renderOutput(
  output: OutputInput | undefined,
  meta: CodeMeta | undefined,
  docEol: DocEol,
  opts: WriteOptions,
): string {
  if (!output) return '';
  if (output.kind === 'preserved') return meta?.output ? meta.output.raw + (meta.history?.raw ?? '') : '';
  if (!opts.persistOutputs) return '';
  const text = processOutputText(output.text, opts);
  const eol = meta?.eol ?? docEol;
  const indent = meta?.indent ?? '';
  const attrs = output.previous ? { ...output.attrs, changed: output.previous.text === text ? 'no' : 'yes' } : output.attrs;
  let s = (meta?.output?.gap ?? '') + formatOutputBlock(text, attrs, indent, eol);
  if (output.history?.length) s += (meta?.history?.gap ?? '') + formatHistoryBlock(output.history, indent, eol);
  return s;
}

/** Cells exactly as parsed, as the editor would hand them back if nothing changed. */
export function toCellInputs(doc: ParsedDocument, keepOutputs = true): CellInput[] {
  return doc.cells.map((c) => ({
    kind: c.kind,
    value: c.value,
    languageId: c.languageId,
    meta: c.meta,
    output: keepOutputs && c.output ? { kind: 'preserved' as const } : undefined,
  }));
}

/** Remove every md-runbook output block from a Markdown text, leaving all other bytes alone. */
export function clearOutputBlocks(text: string): string {
  const doc = parse(text);
  return serialize(doc.meta, toCellInputs(doc, false), DEFAULT_WRITE_OPTIONS);
}

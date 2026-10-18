/**
 * Data model shared by the parser and writer. Everything here is plain JSON so it can live in
 * VS Code notebook/cell metadata between load and save.
 */

import type { DocEol } from './lines';
import type { FenceChar } from './fence';

export interface DocMeta {
  bom: boolean;
  /** Dominant line ending of the file, used for content that has no original bytes. */
  eol: DocEol;
}

/** Original bytes of a markup cell. raw = lead + content + trail. */
export interface MarkupMeta {
  kind: 'markup';
  lead: string;
  content: string;
  trail: string;
  /** Line ending used when the content is rebuilt after an edit. */
  eol: DocEol;
  /** Terminator of the last content line ('' at end of file without newline). */
  finalEol: string;
  /** Cell value as handed to the editor; if it comes back unchanged, `content` is written verbatim. */
  value: string;
}

export interface OutputMeta {
  /** Exact bytes of the output block, including `gap`. */
  raw: string;
  /** Blank lines between the closing fence and the start marker. */
  gap: string;
}

/** Original bytes of a code cell. raw = lead + open + body + close + output.raw + trail. */
export interface CodeMeta {
  kind: 'code';
  lead: string;
  open: string;
  body: string;
  close: string;
  trail: string;
  indent: string;
  fenceChar: FenceChar;
  fenceLen: number;
  info: string;
  lang: string;
  eol: DocEol;
  value: string;
  output?: OutputMeta;
}

export type CellMeta = MarkupMeta | CodeMeta;

export interface ParsedOutput {
  text: string;
  attrs: Record<string, string>;
}

export interface ParsedCell {
  kind: 'markup' | 'code';
  value: string;
  languageId: string;
  meta: CellMeta;
  output?: ParsedOutput;
}

export interface ParsedDocument {
  meta: DocMeta;
  cells: ParsedCell[];
}

/** What to write for a code cell's output on save. */
export type OutputInput =
  /** Write the output block that was loaded from the file, byte for byte. */
  | { kind: 'preserved' }
  /** Write a freshly produced output (it is cleaned, redacted and truncated first). */
  | { kind: 'new'; text: string; attrs: Record<string, string> };

export interface CellInput {
  kind: 'markup' | 'code';
  value: string;
  languageId?: string;
  /** Metadata from `parse`; anything missing or malformed makes the cell count as new. */
  meta?: unknown;
  output?: OutputInput;
}

export interface WriteOptions {
  /** Write new outputs to the file. Loaded outputs are kept either way unless cleared. */
  persistOutputs: boolean;
  /** Maximum lines of a persisted output; 0 = unlimited. */
  maxOutputLines: number;
  stripAnsi: boolean;
  redact?: (text: string) => string;
}

export const DEFAULT_WRITE_OPTIONS: WriteOptions = {
  persistOutputs: true,
  maxOutputLines: 2000,
  stripAnsi: true,
};

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

export function isMarkupMeta(v: unknown): v is MarkupMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    m.kind === 'markup' &&
    isStr(m.lead) &&
    isStr(m.content) &&
    isStr(m.trail) &&
    (m.eol === '\n' || m.eol === '\r\n') &&
    isStr(m.finalEol) &&
    isStr(m.value)
  );
}

function isOutputMeta(v: unknown): v is OutputMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return isStr(m.raw) && isStr(m.gap);
}

export function isCodeMeta(v: unknown): v is CodeMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    m.kind === 'code' &&
    isStr(m.lead) &&
    isStr(m.open) &&
    isStr(m.body) &&
    isStr(m.close) &&
    isStr(m.trail) &&
    isStr(m.indent) &&
    (m.fenceChar === '`' || m.fenceChar === '~') &&
    typeof m.fenceLen === 'number' &&
    isStr(m.info) &&
    isStr(m.lang) &&
    (m.eol === '\n' || m.eol === '\r\n') &&
    isStr(m.value) &&
    (m.output === undefined || isOutputMeta(m.output))
  );
}

export function isDocMeta(v: unknown): v is DocMeta {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.bom === 'boolean' && (m.eol === '\n' || m.eol === '\r\n');
}

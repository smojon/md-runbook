/**
 * What the assistant's answers do to a runbook, as text (the extension makes the same edits as
 * notebook cells): suggestions and pasted blocks become proposed cells, which never run before
 * they are approved; an explanation can go in as a note; the incident summary is one
 * "Findings (AI draft)" section, replaced on each run.
 */
import {
  CellInput,
  DEFAULT_WRITE_OPTIONS,
  isRunnableFenceLang,
  languageIdForFence,
  parse,
  serialize,
  toCellInputs,
} from '@md-runbook/core';
import {
  PseudonymMap,
  codeMetaFor,
  depseudonymize,
  extractFencedBlocks,
  proposalMarkdown as quotedProposal,
} from '@md-runbook/core/aiContext';
import { extractProposals, findingsMarkdown, isFindingsCell, proposalCell } from '@md-runbook/core/aiPrompt';
import { pastedBy, pastedReason } from '@md-runbook/core/pastedInfo';
import { proposedInfo } from '@md-runbook/core/proposal';

function insert(text: string, at: number, add: CellInput[]): string {
  const doc = parse(text);
  const cells = toCellInputs(doc);
  cells.splice(Math.min(Math.max(at, 0), cells.length), 0, ...add);
  return serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
}

const eolOf = (text: string): '\n' | '\r\n' => (parse(text).meta.eol === '\r\n' ? '\r\n' : '\n');

/** Suggest Next Steps: the answer's commands as proposed cells after cell `after` (else at the end). */
export function insertSuggestions(
  text: string,
  answer: string,
  map: PseudonymMap,
  max: number,
  after?: number,
): { text: string; count: number } {
  const proposals = extractProposals(answer, map).slice(0, max);
  const n = parse(text).cells.length;
  const at = after === undefined ? n : after + 1;
  const eol = eolOf(text);
  const cells: CellInput[] = proposals.map((p, i) => {
    const c = proposalCell(p, 'ai', eol, at === n && i === proposals.length - 1);
    return { kind: 'code', value: c.value, languageId: c.languageId, meta: c.meta };
  });
  return { text: cells.length ? insert(text, at, cells) : text, count: cells.length };
}

/** Paste AI Proposal: each fenced block of the clipboard, names mapped back, as a proposed cell (other languages as a quote). */
export function insertPasted(text: string, clipboard: string, map: PseudonymMap, after?: number): { text: string; count: number } {
  const blocks = extractFencedBlocks(clipboard);
  const eol = eolOf(text);
  const cells: CellInput[] = blocks.map((b) => {
    const code = depseudonymize(b.code, map);
    const raw = b.lang ? pastedReason(b.info) : undefined;
    const reason = raw !== undefined && raw.trim() !== '' ? depseudonymize(raw, map) : undefined;
    if (!isRunnableFenceLang(b.lang)) return { kind: 'markup', value: quotedProposal({ ...b, code, ...(reason ? { reason } : {}) }) };
    return {
      kind: 'code',
      value: code,
      languageId: languageIdForFence(b.lang),
      meta: codeMetaFor(proposedInfo(b.lang, pastedBy(b.info), reason), code, eol),
    };
  });
  const at = after === undefined ? parse(text).cells.length : after + 1;
  return { text: cells.length ? insert(text, at, cells) : text, count: cells.length };
}

/** Explain Output, kept: the explanation as a quoted note after the cell. */
export function insertNote(text: string, after: number, label: string, provider: string, explanation: string): string {
  return insert(text, after + 1, [
    { kind: 'markup', value: `> **AI note on ${label}** (draft by ${provider}, not verified)\n\n${explanation}` },
  ]);
}

/** Summarize Incident: the findings section, in place of an earlier one, else at the end. */
export function withFindings(text: string, answer: string, provider: string): string {
  const doc = parse(text);
  const value = findingsMarkdown(answer, provider).replace(/\n$/, '');
  const cells = toCellInputs(doc);
  const at = doc.cells.findIndex((c) => c.kind === 'markup' && isFindingsCell(c.value));
  if (at >= 0) {
    cells[at] = { kind: 'markup', value };
    return serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
  }
  return insert(text, cells.length, [{ kind: 'markup', value }]);
}

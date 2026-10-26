/**
 * Sign Run Record: a signature over a run record (the runbook with its outputs, notes and history:
 * the incident or drill as it happened), so a report or an audit can tell the record wasn't
 * changed afterwards, and who vouched for it. Unlike a runbook's signature (which covers its
 * blocks, for md-runbook-gate) it covers every byte of the file but its own block. A second person
 * (an incident lead, a drill lead) can co-sign it.
 *
 * What is signed is a short statement with the record's SHA-256, never a manifest, so a record
 * signature can't pass for a runbook's; it uses the same SSHSIG namespace, so the servers' and
 * auditors' allowed_signers lines check both (`md-runbook verify --allowed-signers`).
 *
 *   <!-- md-runbook:record-signature v1 signer=ana@example.net signed=2026-10-26T22:40:00+01:00 sha256=…
 *   signature
 *   U1NIU0lH…
 *   cosign signer=lead@example.net signed=2026-10-26T22:45:00+01:00
 *   U1NIU0lH…
 *   -->
 */

import { runbookDigest } from './runbookLink';
import { signerLabel } from './signing';

export interface RecordCosigner {
  signer: string;
  /** Local time with offset, as written. */
  signed: string;
  signature: string;
}

export interface RecordSignature {
  signer: string;
  signed: string;
  /** SHA-256 of the record (the file without this block), as signed. */
  sha256: string;
  signature: string;
  cosigners?: RecordCosigner[];
}

const B64 = '[A-Za-z0-9+/=\\r\\n]+?';
const RECORD_RE = new RegExp(
  `^<!-- md-runbook:record-signature v1 signer=(\\S+) signed=(\\S+) sha256=([0-9a-f]{64})\\r?\\nsignature\\r?\\n(${B64})((?:\\r?\\ncosign signer=\\S+ signed=\\S+\\r?\\n${B64})*)\\r?\\n-->[ \\t]*$`,
  'm',
);
const COSIGN_RE = /cosign signer=(\S+) signed=(\S+)\r?\n([A-Za-z0-9+/=\r\n]+?)(?=\r?\ncosign |$)/g;
const wrap = (b64: string): string => b64.replace(/.{1,76}/g, '$&\n').trimEnd();

/** What a signer signs: the record's digest, in words that are no runbook manifest. */
export function recordStatement(sha256: string): string {
  return `md-runbook run record v1\nsha256 ${sha256}\n`;
}

/** The record signature block, or undefined. */
export function readRecordSignature(text: string): RecordSignature | undefined {
  const m = RECORD_RE.exec(text);
  if (!m) return undefined;
  const cosigners = [...(m[5] ?? '').trim().matchAll(COSIGN_RE)].map((c) => ({ signer: c[1]!, signed: c[2]!, signature: c[3]!.replace(/\s+/g, '') }));
  return { signer: m[1]!, signed: m[2]!, sha256: m[3]!, signature: m[4]!.replace(/\s+/g, ''), ...(cosigners.length ? { cosigners } : {}) };
}

/** The text without its record signature block (and the blank line before it). */
export function withoutRecordSignature(text: string): string {
  const m = RECORD_RE.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index).replace(/(\r?\n)[ \t]*(\r?\n)+$/, '$1');
  return before + text.slice(m.index + m[0].length).replace(/^\r?\n/, '');
}

/** The digest a record signature covers: the file without its record signature block. */
export function recordDigest(text: string): string {
  return runbookDigest(withoutRecordSignature(text));
}

export function formatRecordSignature(b: RecordSignature): string {
  return (
    `<!-- md-runbook:record-signature v1 signer=${signerLabel(b.signer)} signed=${b.signed} sha256=${b.sha256}\n` +
    `signature\n${wrap(b.signature)}\n` +
    (b.cosigners ?? []).map((c) => `cosign signer=${signerLabel(c.signer)} signed=${c.signed}\n${wrap(c.signature)}\n`).join('') +
    '-->'
  );
}

/** The text with `block` as its record signature, at the end (an earlier one replaced). */
export function withRecordSignature(text: string, block: RecordSignature): string {
  const base = withoutRecordSignature(text);
  const eol = /\r\n/.test(base) ? '\r\n' : '\n';
  return `${base.replace(/(\r?\n)*$/, '')}${eol}${eol}${formatRecordSignature(block).replace(/\n/g, eol)}${eol}`;
}

/**
 * The record's signature and whether the record is unchanged since (its digest still matches).
 * Whether the signature itself is genuine takes the signers' keys: `md-runbook verify`.
 */
export function recordStatus(text: string): { block: RecordSignature; unchanged: boolean } | undefined {
  const block = readRecordSignature(text);
  return block ? { block, unchanged: recordDigest(text) === block.sha256 } : undefined;
}

/** The signers' names as the block gives them (a check against allowed_signers proves them). */
export const recordSigners = (b: RecordSignature): string[] => [b.signer, ...(b.cosigners ?? []).map((c) => c.signer)];

/** A co-signature added to a block (an earlier one by the same signer replaced). */
export function withRecordCosigner(b: RecordSignature, c: RecordCosigner): RecordSignature {
  return { ...b, cosigners: [...(b.cosigners ?? []).filter((x) => x.signer !== signerLabel(c.signer)), c] };
}

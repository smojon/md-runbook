/**
 * The lines of an OpenSSH allowed_signers file (ssh-keygen(1), ALLOWED SIGNERS), for Trusted
 * Signers…: read them with their fingerprints, add one (namespaces="md-runbook" when it has no
 * namespaces), remove one. The same reading rules as the app's trusted signers
 * (apps/mobile/src/signing/trust.ts parseAllowedSigners, which uses the app's Buffer polyfill:
 * duplicated here rather than moved, so the app is not touched). No vscode import: unit-tested.
 */

import { createHash } from 'node:crypto';
import { SIGNATURE_NAMESPACE, SIGNER_NAME_RE } from '@md-runbook/core/signing';

export interface SignerLine {
  /** 0-based line in the file. */
  line: number;
  /** The line as written (trimmed). */
  raw: string;
  /** Who may sign with the key: names or patterns, as the line lists them. */
  principals: string[];
  options: string[];
  keyType: string;
  key: string;
  fingerprint: string;
  namespaces?: string[];
  validAfter?: string;
  validBefore?: string;
}

/** A public key as in a .pub file: `ssh-ed25519 AAAA… comment`. */
export interface PublicKeyLine {
  keyType: string;
  key: string;
  comment?: string;
  fingerprint: string;
}

/** Split on `sep` outside double quotes. */
function words(line: string, sep: RegExp): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && sep.test(ch)) {
      if (cur !== '') out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}
const unquote = (s: string): string => s.replace(/^"(.*)"$/, '$1');
const isKeyType = (s: string): boolean => /^(ssh-|ecdsa-sha2-|sk-|rsa-|webauthn-)/.test(s);
/** The options OpenSSH's allowed_signers knows (sshsig.c); a line with any other is refused, as there. */
const KNOWN_OPTION = /^(cert-authority|namespaces=.*|valid-after=.*|valid-before=.*)$/i;

/** The key blob's fingerprint as ssh-keygen -l shows it, or undefined when the key isn't one of `keyType`. */
export function keyFingerprint(keyType: string, key: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+=*$/.test(key)) return undefined;
  const blob = Buffer.from(key, 'base64');
  if (blob.length < 4) return undefined;
  const n = blob.readUInt32BE(0);
  if (blob.length < 4 + n || blob.subarray(4, 4 + n).toString('latin1') !== keyType) return undefined;
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/** OpenSSH's pattern match: `*` and `?`. */
function matchPattern(s: string, pattern: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(s);
}
/** OpenSSH's pattern-list match: a `!pattern` that matches refuses, else any pattern that matches. */
function matchList(s: string, list: readonly string[]): boolean {
  let ok = false;
  for (const p of list) {
    if (p.startsWith('!')) {
      if (matchPattern(s, p.slice(1))) return false;
    } else if (matchPattern(s, p)) ok = true;
  }
  return ok;
}

/** One line of an allowed_signers file: a signer, or why it isn't one md-runbook can use (undefined: blank or a comment). */
export function parseSignerLine(raw: string, line = 0): SignerLine | { problem: string } | undefined {
  const text = raw.trim();
  if (text === '' || text.startsWith('#')) return undefined;
  const w = words(text, /\s/);
  let i = 1;
  let options: string[] = [];
  if (w[i] !== undefined && !isKeyType(w[i]!)) options = words(w[i++]!, /,/);
  const keyType = w[i];
  const key = w[i + 1];
  if (!w[0] || isKeyType(w[0])) return { problem: 'no signer name before the key (allowed_signers: name, options, key)' };
  if (!keyType || !key) return { problem: 'no public key on the line' };
  const fingerprint = keyFingerprint(keyType, key);
  if (!fingerprint) return { problem: `not a ${keyType} key (damaged, or cut off)` };
  const unknown = options.find((o) => !KNOWN_OPTION.test(o));
  if (unknown) return { problem: `an option OpenSSH doesn't know: ${unknown}` };
  if (options.some((o) => o.toLowerCase() === 'cert-authority')) return { problem: 'a certificate authority (cert-authority): not used for runbooks' };
  const opt = (name: string): string | undefined => {
    const o = options.find((x) => x.toLowerCase().startsWith(name + '='));
    return o === undefined ? undefined : unquote(o.slice(name.length + 1));
  };
  const namespaces = opt('namespaces')?.split(',');
  if (namespaces && !matchList(SIGNATURE_NAMESPACE, namespaces)) return { problem: `for other namespaces (${namespaces.join(',')}), not ${SIGNATURE_NAMESPACE}` };
  const validAfter = opt('valid-after');
  const validBefore = opt('valid-before');
  return {
    line,
    raw: text,
    principals: unquote(w[0]).split(','),
    options,
    keyType,
    key,
    fingerprint,
    ...(namespaces ? { namespaces } : {}),
    ...(validAfter ? { validAfter } : {}),
    ...(validBefore ? { validBefore } : {}),
  };
}

/** A .pub file's line (`ssh-ed25519 AAAA… alice@laptop`), or undefined when the line isn't one. */
export function parsePublicKey(raw: string): PublicKeyLine | undefined {
  const w = raw.trim().split(/\s+/);
  if (!w[0] || !isKeyType(w[0]) || !w[1]) return undefined;
  const fingerprint = keyFingerprint(w[0], w[1]);
  if (!fingerprint) return undefined;
  const comment = w.slice(2).join(' ');
  return { keyType: w[0], key: w[1], fingerprint, ...(comment ? { comment } : {}) };
}

/** The signers of a file, and how many key lines md-runbook can't use (with why). */
export function readSigners(text: string): { signers: SignerLine[]; skipped: { line: number; problem: string }[] } {
  const signers: SignerLine[] = [];
  const skipped: { line: number; problem: string }[] = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const r = parseSignerLine(raw, n);
    if (!r) return;
    if ('problem' in r) skipped.push({ line: n, problem: r.problem });
    else signers.push(r);
  });
  return { signers, skipped };
}

/** The line to add: as given, with namespaces="md-runbook" when it names no namespaces (OpenSSH's default is any). */
export function signerLineToAdd(s: SignerLine): string {
  if (s.namespaces) return s.raw;
  const w = words(s.raw, /\s/);
  const hasOptions = w[1] !== undefined && !isKeyType(w[1]);
  const options = [`namespaces="${SIGNATURE_NAMESPACE}"`, ...s.options].join(',');
  return [w[0], options, ...w.slice(hasOptions ? 2 : 1)].join(' ');
}

/** The allowed_signers line for a public key and a name. */
export function lineForKey(name: string, k: Pick<PublicKeyLine, 'keyType' | 'key' | 'comment'>): string {
  return `${name} namespaces="${SIGNATURE_NAMESPACE}" ${k.keyType} ${k.key}${k.comment ? ` ${k.comment}` : ''}`;
}

/** Whether `name` can be a signer's name (what Sign Runbook writes): no patterns, lists or spaces. */
export const signerNameOk = (name: string): boolean => SIGNER_NAME_RE.test(name);

/** Whether the file has this key for these names already. */
export function hasSigner(text: string, s: Pick<SignerLine, 'principals' | 'keyType' | 'key'>): boolean {
  const names = [...s.principals].sort().join(',');
  return readSigners(text).signers.some((x) => x.keyType === s.keyType && x.key === s.key && [...x.principals].sort().join(',') === names);
}

/** The text with `line` added at the end (on a line of its own). */
export function withLine(text: string, line: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text === '' || text.endsWith('\n') ? `${text}${line}${eol}` : `${text}${eol}${line}${eol}`;
}

/** The text without the signer's line (found by its text: the file may have changed since it was read). */
export function withoutSigner(text: string, s: Pick<SignerLine, 'raw'>): string | undefined {
  const lines = text.split(/(?<=\n)/);
  const i = lines.findIndex((l) => l.trim() === s.raw);
  if (i < 0) return undefined;
  lines.splice(i, 1);
  return lines.join('');
}

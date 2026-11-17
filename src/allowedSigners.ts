/**
 * The lines of an OpenSSH allowed_signers file (ssh-keygen(1), ALLOWED SIGNERS), for Trusted
 * Signers…: read them with their fingerprints, add one (namespaces="md-runbook" when it has no
 * namespaces), remove one. Lines are read strictly (no escapes, quotes only around option values)
 * and written in canonical form, so the key shown is the key ssh-keygen trusts. The same reading
 * rules as the app's trusted signers
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

/** How a line is read: `adding`, a line to add to your file (pasted, from a file, a library's), takes plain names only. */
export interface ReadOptions {
  adding?: boolean;
}

/**
 * Why md-runbook can't be sure it reads a line as OpenSSH does, or undefined. OpenSSH skips `\"`
 * inside quotes and reads blanks and controls its own way: a line with a backslash, a control
 * character or a blank other than space and tab could show one key here while ssh-keygen trusts
 * another, so it is refused.
 */
export function strictLineProblem(text: string): string | undefined {
  if (text.includes('\\')) return 'a backslash (OpenSSH reads escapes): not used';
  for (const ch of text) if (ch !== ' ' && ch !== '\t' && /[\p{C}\p{Z}]/u.test(ch)) return 'a control character or an unusual blank: not used';
  return undefined;
}

/** valid-after / valid-before as OpenSSH reads them: YYYYMMDD[HHMM[SS]][Z]. */
const SSH_TIME = /^\d{8}(\d{4}(\d{2})?)?Z?$/i;
/** An option with its value, quoted as OpenSSH requires (opt_dequote). */
const QUOTED_OPTION = /^(namespaces|valid-after|valid-before)="([^"]*)"$/i;

/**
 * One line of an allowed_signers file: a signer, or why it isn't one md-runbook can use (undefined:
 * blank or a comment). Read strictly, so that the key shown is the key ssh-keygen trusts: no
 * escapes, a quote only around an option's value, each option once. A line to add must name each
 * signer: a principal pattern (`*`, `?`, `!`, `*@example.net`) would let its key sign as any name
 * it matches, so trusting it is refused.
 */
export function parseSignerLine(raw: string, line = 0, opts: ReadOptions = {}): SignerLine | { problem: string } | undefined {
  const text = raw.trim();
  if (text === '' || text.startsWith('#')) return undefined;
  const strict = strictLineProblem(text);
  if (strict) return { problem: strict };
  const w = words(text, /[ \t]/);
  if (!w[0] || isKeyType(w[0])) return { problem: 'no signer name before the key (allowed_signers: name, options, key)' };
  if (w[0].includes('"')) return { problem: 'a quote in the signer names: not used' };
  let i = 1;
  let options: string[] = [];
  if (w[i] !== undefined && !isKeyType(w[i]!)) options = words(w[i++]!, /,/);
  const keyType = w[i];
  const key = w[i + 1];
  if (w.slice(i).some((x) => x.includes('"'))) return { problem: 'a quote outside an option value: not used' };
  if (!keyType || !key) return { problem: 'no public key on the line' };
  const fingerprint = keyFingerprint(keyType, key);
  if (!fingerprint) return { problem: `not a ${keyType} key (damaged, or cut off)` };
  const values = new Map<string, string>();
  for (const o of options) {
    if (o.toLowerCase() === 'cert-authority') return { problem: 'a certificate authority (cert-authority): not used for runbooks' };
    const m = QUOTED_OPTION.exec(o);
    if (!m) {
      if (o.includes('"')) return { problem: 'a quote outside an option value: not used' };
      return KNOWN_OPTION.test(o) ? { problem: `${o.split('=')[0]}: its value needs quotes, as OpenSSH reads it` } : { problem: `an option OpenSSH doesn't know: ${o}` };
    }
    const name = m[1]!.toLowerCase();
    if (values.has(name)) return { problem: `${name} given twice` };
    values.set(name, m[2]!);
  }
  const namespaces = values.get('namespaces')?.split(',');
  if (namespaces && namespaces.some((n) => n === '' || /\s/.test(n))) return { problem: 'namespaces: an empty name, or a blank in one' };
  if (namespaces && !matchList(SIGNATURE_NAMESPACE, namespaces)) return { problem: `for other namespaces (${namespaces.join(',')}), not ${SIGNATURE_NAMESPACE}` };
  const validAfter = values.get('valid-after');
  const validBefore = values.get('valid-before');
  for (const [name, v] of [
    ['valid-after', validAfter],
    ['valid-before', validBefore],
  ] as const)
    if (v !== undefined && !SSH_TIME.test(v)) return { problem: `${name}: a time as YYYYMMDD[HHMM[SS]][Z]` };
  const principals = w[0].split(',');
  if (principals.some((p) => p === '')) return { problem: 'an empty signer name' };
  const pattern = opts.adding ? principals.find((p) => !SIGNER_NAME_RE.test(p)) : undefined;
  if (pattern !== undefined)
    return { problem: `"${pattern.slice(0, 60)}" is not a signer's name (a pattern, or other characters): name each signer, with letters, digits and @ . _ + -` };
  return {
    line,
    raw: text,
    principals,
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
  if (strictLineProblem(raw.trim())) return undefined;
  const w = raw.trim().split(/[ \t]+/);
  if (!w[0] || !isKeyType(w[0]) || !w[1]) return undefined;
  const fingerprint = keyFingerprint(w[0], w[1]);
  if (!fingerprint) return undefined;
  const comment = w.slice(2).join(' ');
  return { keyType: w[0], key: w[1], fingerprint, ...(comment ? { comment } : {}) };
}

/** A key line md-runbook doesn't use, with why. */
export interface SkippedLine {
  line: number;
  problem: string;
  /** The line as written (trimmed), to remove it. */
  raw: string;
}

/** The signers of a file, and how many key lines md-runbook can't use (with why). */
export function readSigners(text: string, opts: ReadOptions = {}): { signers: SignerLine[]; skipped: SkippedLine[] } {
  const signers: SignerLine[] = [];
  const skipped: SkippedLine[] = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const r = parseSignerLine(raw, n, opts);
    if (!r) return;
    if ('problem' in r) skipped.push({ line: n, problem: r.problem, raw: raw.trim() });
    else signers.push(r);
  });
  return { signers, skipped };
}

/**
 * The line md-runbook writes for a signer: rebuilt from what was read (names, namespaces,
 * valid-after, valid-before, key type, key), never the line as given, so the file holds the key
 * that was shown. No comment.
 */
export function canonicalLine(s: Pick<SignerLine, 'principals' | 'keyType' | 'key' | 'namespaces' | 'validAfter' | 'validBefore'>): string {
  const options = [
    ...(s.namespaces ? [`namespaces="${s.namespaces.join(',')}"`] : []),
    ...(s.validAfter ? [`valid-after="${s.validAfter}"`] : []),
    ...(s.validBefore ? [`valid-before="${s.validBefore}"`] : []),
  ];
  return [s.principals.join(','), ...(options.length > 0 ? [options.join(',')] : []), s.keyType, s.key].join(' ');
}

/** The line to add: canonical, with namespaces="md-runbook" when it names no namespaces (OpenSSH's default is any). */
export function signerLineToAdd(s: SignerLine): string {
  return canonicalLine({ ...s, namespaces: s.namespaces ?? [SIGNATURE_NAMESPACE] });
}

/** The allowed_signers line for a public key and a name (the key's comment is not written). */
export function lineForKey(name: string, k: Pick<PublicKeyLine, 'keyType' | 'key'>): string {
  return canonicalLine({ principals: [name], namespaces: [SIGNATURE_NAMESPACE], keyType: k.keyType, key: k.key });
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

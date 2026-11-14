/**
 * The signers the user trusts, and what a runbook's signature is worth against them. The app has
 * no signers of its own: a team library may publish its `allowed_signers` (OpenSSH's format, as
 * md-runbook-gate reads it) and the user chooses to trust those keys, after seeing their names
 * and fingerprints, for that library only. A runbook is then "Signed by alice: these steps
 * verified" only when its signature checks out (signing/verify.ts) with a key trusted from the
 * runbook's library and listed for the name the signature block gives, and the signature covers
 * every block the app could run (coverage(), unsignedRunnable()).
 */
import { useSyncExternalStore } from 'react';
import { isCodeMeta, parse, shellKindForLanguage } from '@md-runbook/core';
import { isCallLanguage } from '@md-runbook/core/call';
import {
  SIGNATURE_NAMESPACE,
  SIGNER_NAME_RE,
  SignatureBlock,
  SignedStatus,
  readSignature,
  signedStatus,
  signerLabel,
} from '@md-runbook/core/signing';
import { Buffer } from 'buffer';
import { getJson, setJson } from '../storage/kv';
import { CannotCheck, keyFingerprint, parseSshsig, sshsigHash, verifySshsig } from './verify';

/** One key line of an allowed_signers file. */
export interface AllowedSigner {
  /** Who may sign with the key: names or patterns (`*@example.net`), as the line lists them. */
  principals: string[];
  keyType: string;
  /** The public key blob, base64. */
  key: string;
  fingerprint: string;
  /** The line's namespaces="…" (absent: any namespace). */
  namespaces?: string[];
  /** valid-after / valid-before, as the line writes them (YYYYMMDD[HHMM[SS]][Z]). */
  validAfter?: string;
  validBefore?: string;
}

export interface TrustedSigner extends AllowedSigner {
  /** The library the user trusted it from. */
  from: string;
}

/** Split on blanks outside double quotes. */
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
const isKeyType = (s: string): boolean => /^(ssh-|ecdsa-sha2-|sk-|rsa-)/.test(s);
/** The options OpenSSH's allowed_signers knows (sshsig.c); a line with any other is refused, as there. */
const KNOWN_OPTION = /^(cert-authority|namespaces=.*|valid-after=.*|valid-before=.*)$/i;

/**
 * The key lines of an allowed_signers file. Lines the app can't use are counted in `skipped`:
 * certificate authorities (cert-authority), lines for other namespaces only, lines with an option
 * OpenSSH doesn't know, damaged lines.
 */
export function parseAllowedSigners(text: string): { signers: AllowedSigner[]; skipped: number } {
  const signers: AllowedSigner[] = [];
  let skipped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const w = words(line, /\s/);
    let i = 1;
    let options: string[] = [];
    if (w[i] !== undefined && !isKeyType(w[i]!)) options = words(w[i++]!, /,/);
    const keyType = w[i];
    const key = w[i + 1];
    let blob: Buffer | undefined;
    try {
      blob = key && /^[A-Za-z0-9+/]+=*$/.test(key) ? Buffer.from(key, 'base64') : undefined;
    } catch {
      blob = undefined;
    }
    const opt = (name: string): string | undefined => {
      const o = options.find((x) => x.toLowerCase().startsWith(name + '='));
      return o === undefined ? undefined : unquote(o.slice(name.length + 1));
    };
    const blobType = blob && blob.length > 4 ? blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('latin1') : undefined;
    const namespaces = opt('namespaces')?.split(',');
    if (
      !w[0] ||
      !keyType ||
      !blob ||
      blobType !== keyType ||
      options.some((o) => !KNOWN_OPTION.test(o)) ||
      options.some((o) => o.toLowerCase() === 'cert-authority') ||
      (namespaces && !matchList(SIGNATURE_NAMESPACE, namespaces))
    ) {
      skipped++;
      continue;
    }
    const validAfter = opt('valid-after');
    const validBefore = opt('valid-before');
    signers.push({
      principals: unquote(w[0]).split(','),
      keyType,
      key: key!,
      fingerprint: keyFingerprint(new Uint8Array(blob)),
      ...(namespaces ? { namespaces } : {}),
      ...(validAfter ? { validAfter } : {}),
      ...(validBefore ? { validBefore } : {}),
    });
  }
  return { signers, skipped };
}

/** OpenSSH's pattern match: `*` and `?`. */
function matchPattern(s: string, pattern: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(s);
}

/** A pattern list (`a,b,!c`): a negated match refuses, else any match accepts. */
function matchList(s: string, patterns: readonly string[]): boolean {
  let ok = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (matchPattern(s, p.slice(1))) return false;
    } else if (matchPattern(s, p)) ok = true;
  }
  return ok;
}

/** YYYYMMDD[HHMM[SS]][Z] (local time without Z, as ssh-keygen reads it). */
function sshTime(v: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(Z?)$/i.exec(v);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return m[7] ? Date.UTC(y, mo - 1, d, h, mi, s) : new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** Whether the key may sign as `name` now (principals, namespaces, validity). */
export function signerAllows(s: AllowedSigner, name: string, now = Date.now()): boolean {
  if (!matchList(name, s.principals)) return false;
  if (s.namespaces && !matchList(SIGNATURE_NAMESPACE, s.namespaces)) return false;
  const after = s.validAfter ? sshTime(s.validAfter) : undefined;
  const before = s.validBefore ? sshTime(s.validBefore) : undefined;
  if ((s.validAfter && after === undefined) || (s.validBefore && before === undefined)) return false;
  return (after === undefined || now >= after) && (before === undefined || now <= before);
}

/** The same key for the same names (trusting a line twice keeps one). */
export const sameSigner = (a: AllowedSigner, b: AllowedSigner): boolean =>
  a.keyType === b.keyType && a.key === b.key && a.principals.join(',') === b.principals.join(',');

/** A signer name as the app shows it: names outside SIGNER_NAME_RE (spaces, look-alike letters, bidi controls) are shown made safe. */
export const shownName = (name: string): string => (SIGNER_NAME_RE.test(name) ? name : signerLabel(name));

/** An allowed_signers principal as the trust prompt shows it: a name's characters and the pattern characters, anything else `_`. */
export const shownPrincipal = (principal: string): string => principal.replace(/[^A-Za-z0-9_@.+*?!-]/g, '_');

// ---- the trusted signers (kept between launches) ----

const KEY = 'signers.trusted.v1';
const isTrusted = (v: unknown): v is TrustedSigner[] =>
  Array.isArray(v) &&
  v.every(
    (s: unknown) =>
      typeof s === 'object' &&
      s !== null &&
      Array.isArray((s as TrustedSigner).principals) &&
      (s as TrustedSigner).principals.every((p) => typeof p === 'string') &&
      typeof (s as TrustedSigner).keyType === 'string' &&
      typeof (s as TrustedSigner).key === 'string' &&
      typeof (s as TrustedSigner).fingerprint === 'string' &&
      typeof (s as TrustedSigner).from === 'string',
  );

let trusted: readonly TrustedSigner[] = [];
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
let loaded: Promise<void> | undefined;

export function loadTrustedSigners(): Promise<void> {
  return (loaded ??= (async () => {
    trusted = (await getJson(KEY, isTrusted)) ?? [];
    emit();
  })());
}

function save(next: readonly TrustedSigner[]): void {
  trusted = next;
  emit();
  void setJson(KEY, trusted).catch(() => undefined);
}

/** Every trusted key line, whichever library it was trusted from (Hosts & settings lists them). */
export const trustedSigners = (): readonly TrustedSigner[] => trusted;

/** The keys trusted from the library at `base`: the only ones its runbooks are checked against. */
export const trustedFor = (base: string): TrustedSigner[] => trusted.filter((s) => s.from === base);

/** Whether this key line is trusted for the library at `base`. */
export const isTrustedSigner = (s: AllowedSigner, base: string): boolean => trusted.some((x) => x.from === base && sameSigner(x, s));

/** Trust these lines for the library at `base` (the user said so, after seeing them); other libraries don't use them. */
export function trustSigners(signers: readonly AllowedSigner[], base: string): void {
  const add = signers.filter((s, i) => !isTrustedSigner(s, base) && signers.findIndex((x) => sameSigner(x, s)) === i);
  save([
    ...trusted,
    ...add.map(({ principals, keyType, key, fingerprint, namespaces, validAfter, validBefore }) => ({
      principals,
      keyType,
      key,
      fingerprint,
      ...(namespaces ? { namespaces } : {}),
      ...(validAfter ? { validAfter } : {}),
      ...(validBefore ? { validBefore } : {}),
      from: base,
    })),
  ]);
}

/** No longer trust these lines for the library at `base`. */
export function untrustSigners(signers: readonly AllowedSigner[], base: string): void {
  save(trusted.filter((x) => !(x.from === base && signers.some((s) => sameSigner(x, s)))));
}

/** Remove one trusted line (Hosts & settings → Trusted signers). */
export function removeTrustedSigner(s: TrustedSigner): void {
  untrustSigners([s], s.from);
}

export function useTrustedSigners(): readonly TrustedSigner[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => trusted,
  );
}

/** Tests. */
export function resetTrustedSigners(): void {
  trusted = [];
  loaded = undefined;
  emit();
}

// ---- what a runbook's signature is worth ----

/** What a manifest signs about the runbook as a whole (the gate checks the same items). */
export interface SignedManifest {
  name: string;
  version: number;
  /** `YYYY-MM-DD` (UTC): not verified after that day, as the gate refuses it. */
  expires?: string;
  scopes: string[];
}

/** A signature that checked out: who, with which key, and whether the key was listed for that name only by a pattern. */
export interface SignerCheck {
  name: string;
  fingerprint: string;
  /** The key may sign under any name its pattern matches (`*`, `*@example.net`): the name alone doesn't say whose key it is. */
  wildcard: boolean;
}

/**
 * How much of the runbook its signature covers. `partial`: the shell blocks and runbook calls
 * (manifest v1), not the text around them; `whole`: all of the text but the signature and output
 * blocks (manifest v2).
 */
export type Coverage = 'whole' | 'partial';

/**
 * The one place that decides whether the signature covers the whole runbook. Manifest v1
 * (`md-runbook-manifest 1`) signs the shell blocks and runbook calls only, so it is always
 * 'partial'. When core reads manifest v2 (a hash of the text minus the signature and output
 * blocks), return 'whole' here when `status` says that text is unchanged: the states, labels and
 * signedOnly follow from this answer, and pwsh/cmd blocks then count as signed.
 */
export function coverage(_text: string, _status: SignedStatus): Coverage {
  return 'partial';
}

/**
 * Blocks the app could run that the signature doesn't cover: shell blocks of any kind the app
 * runs (bash, sh, pwsh, powershell, cmd, bat) and runbook calls that are not in the manifest.
 * Changed bash blocks and calls are counted by signedStatus already; this adds PowerShell and cmd
 * blocks, which manifest v1 never signs.
 */
export function unsignedRunnable(text: string, status: SignedStatus): number {
  let n = 0;
  parse(text).cells.forEach((cell, i) => {
    if (cell.kind !== 'code' || !isCodeMeta(cell.meta)) return;
    const runnable = shellKindForLanguage(cell.languageId) !== undefined || isCallLanguage(cell.languageId);
    if (runnable && !status.cells.has(i) && !status.calls.has(i)) n++;
  });
  return n;
}

/** Whether a manifest's `expires` day is over (UTC, as the gate compares it). */
export const isExpired = (expires: string | undefined, now = Date.now()): boolean =>
  expires !== undefined && new Date(now).toISOString().slice(0, 10) > expires;

export type SignatureState =
  | { kind: 'unsigned' }
  /** Blocks changed, added, removed or moved since signing (a gate refuses them), or a damaged manifest. */
  | { kind: 'changed'; signers: string[] }
  /** A signature that is malformed, for another namespace, by another key than the trusted one for its name, or that doesn't check out. */
  | { kind: 'invalid'; signers: string[] }
  /** Signed and unchanged, but by no one trusted for this library (or not checkable on this device). */
  | { kind: 'unknown'; signers: string[]; manifest: SignedManifest }
  /** Runnable blocks the signature doesn't cover (PowerShell, cmd): not verified, whoever signed the rest. */
  | { kind: 'partial'; signers: string[]; manifest: SignedManifest; unsigned: number; verified: SignerCheck[] }
  /** Checked, but the manifest's expiry day is over. */
  | { kind: 'expired'; signers: string[]; manifest: SignedManifest; verified: SignerCheck[] }
  /** Checked: these signers' signatures check out with keys trusted for their names, and cover every runnable block. */
  | { kind: 'verified'; signers: string[]; manifest: SignedManifest; verified: SignerCheck[]; coverage: Coverage };

/** The only state a signedOnly library opens. */
export const isVerified = (s: SignatureState | undefined): s is Extract<SignatureState, { kind: 'verified' }> => s?.kind === 'verified';

/** The manifest of a signed, unchanged runbook's state. */
export const manifestOf = (s: SignatureState | undefined): SignedManifest | undefined => (s && 'manifest' in s ? s.manifest : undefined);

type CheckResult = { result: 'unknown' | 'invalid' } | { result: 'verified'; check: SignerCheck };

/** One signature of the block against the keys. */
async function checkOne(
  name: string,
  signature: string,
  manifest: string,
  keys: readonly AllowedSigner[],
  subtle: SubtleCrypto | undefined,
  now: number,
): Promise<CheckResult> {
  // Parsed before anything else: a blob that is no SSHSIG (AAAA), or one for another namespace or
  // hash, is a bad signature whether or not anyone is trusted for the name it claims.
  const sig = parseSshsig(signature);
  if (!sig || sig.namespace !== SIGNATURE_NAMESPACE || !sshsigHash(sig.hashAlgorithm)) return { result: 'invalid' };
  // A name no allowed_signers principal could spell the same way is never shown as a signer.
  if (!SIGNER_NAME_RE.test(name)) return { result: 'invalid' };
  const forName = keys.filter((k) => signerAllows(k, name, now));
  if (forName.length === 0) return { result: 'unknown' };
  const used = Buffer.from(sig.publicKey).toString('base64');
  const key = forName.find((k) => Buffer.from(k.key, 'base64').toString('base64') === used);
  if (!key) return { result: 'invalid' };
  try {
    if ((await verifySshsig(signature, manifest, subtle)) !== true) return { result: 'invalid' };
  } catch (e) {
    // The key matched a trusted one: anything but "this device can't check it" is a bad signature.
    return { result: e instanceof CannotCheck ? 'unknown' : 'invalid' };
  }
  return { result: 'verified', check: { name, fingerprint: key.fingerprint, wildcard: !key.principals.includes(name) } };
}

/**
 * The runbook's signature state against `keys`: for a library runbook, the keys trusted from that
 * library (runbooks/library.ts libraryKeys), never every trusted key.
 */
export async function signatureState(
  text: string,
  keys: readonly AllowedSigner[],
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
  now = Date.now(),
): Promise<SignatureState> {
  const block: SignatureBlock | undefined = readSignature(text);
  if (!block) return { kind: 'unsigned' };
  const all = [{ signer: block.signer, signature: block.signature }, ...(block.cosigners ?? [])];
  const names = all.map((s) => s.signer);
  const status = signedStatus(text);
  if (!status || status.changed.length + status.missing.length + status.moved.length + status.missingCalls.length > 0) {
    return { kind: 'changed', signers: names };
  }
  const m = status.manifest;
  const manifest: SignedManifest = { name: m.name, version: m.version, scopes: m.scopes, ...(m.expires ? { expires: m.expires } : {}) };
  const results = await Promise.all(all.map((s) => checkOne(s.signer, s.signature, block.manifest, keys, subtle, now)));
  const bad = all.filter((_, i) => results[i]!.result === 'invalid').map((s) => s.signer);
  if (bad.length > 0) return { kind: 'invalid', signers: bad };
  const verified = results.flatMap((r) => (r.result === 'verified' ? [r.check] : []));
  const covers = coverage(text, status);
  const outside = covers === 'whole' ? 0 : unsignedRunnable(text, status);
  if (outside > 0) return { kind: 'partial', signers: names, manifest, unsigned: outside, verified };
  if (verified.length === 0) return { kind: 'unknown', signers: names, manifest };
  const good = verified.map((v) => v.name);
  if (isExpired(manifest.expires, now)) return { kind: 'expired', signers: good, manifest, verified };
  return { kind: 'verified', signers: good, manifest, verified, coverage: covers };
}

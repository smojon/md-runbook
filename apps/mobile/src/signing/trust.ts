/**
 * The signers the user trusts, and what a runbook's signature is worth against them. The app has
 * no signers of its own: a team library may publish its `allowed_signers` (OpenSSH's format, as
 * md-runbook-gate reads it) and the user chooses to trust those keys, after seeing their names
 * and fingerprints. A runbook is then "Signed by alice, verified" only when its signature checks
 * out (signing/verify.ts) with a trusted key listed for the name the signature block gives.
 */
import { useSyncExternalStore } from 'react';
import { SIGNATURE_NAMESPACE, SignatureBlock, readSignature, signedStatus } from '@md-runbook/core/signing';
import { Buffer } from 'buffer';
import { getJson, setJson } from '../storage/kv';
import { keyFingerprint, parseSshsig, verifySshsig } from './verify';

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

/**
 * The key lines of an allowed_signers file. Lines the app can't use are counted in `skipped`:
 * certificate authorities (cert-authority), lines for other namespaces only, damaged lines.
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
const sameSigner = (a: AllowedSigner, b: AllowedSigner): boolean =>
  a.keyType === b.keyType && a.key === b.key && a.principals.join(',') === b.principals.join(',');

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

export const trustedSigners = (): readonly TrustedSigner[] => trusted;

/** Whether this key line is trusted already. */
export const isTrustedSigner = (s: AllowedSigner): boolean => trusted.some((x) => sameSigner(x, s));

/** Trust these lines (the user said so, after seeing them), remembering the library they came from. */
export function trustSigners(signers: readonly AllowedSigner[], from: string): void {
  save([...trusted, ...signers.filter((s) => !isTrustedSigner(s)).map((s) => ({ ...s, from }))]);
}

/** No longer trust these lines. */
export function untrustSigners(signers: readonly AllowedSigner[]): void {
  save(trusted.filter((x) => !signers.some((s) => sameSigner(x, s))));
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

export type SignatureState =
  | { kind: 'unsigned' }
  /** Blocks changed, added, removed or moved since signing (a gate refuses them), or a damaged manifest. */
  | { kind: 'changed'; signers: string[] }
  /** Checked: these signers' signatures check out with keys the user trusts for their names. */
  | { kind: 'verified'; signers: string[]; expires?: string }
  /** Signed and unchanged, but by no one the user trusts (or not checkable here). */
  | { kind: 'unknown'; signers: string[]; expires?: string }
  /** A trusted name, but not that name's trusted key, or a signature that doesn't check out. */
  | { kind: 'invalid'; signers: string[] };

/** Whether the state is a signed, unchanged runbook (what a library's signedOnly asks for). */
export const isSignedIntact = (s: SignatureState): boolean => s.kind === 'verified' || s.kind === 'unknown';

/** One signature of the block against the trusted keys. */
async function checkOne(
  name: string,
  signature: string,
  manifest: string,
  keys: readonly AllowedSigner[],
  subtle: SubtleCrypto | undefined,
  now: number,
): Promise<'verified' | 'unknown' | 'invalid'> {
  const forName = keys.filter((k) => signerAllows(k, name, now));
  if (forName.length === 0) return 'unknown';
  const sig = parseSshsig(signature);
  if (!sig) return 'invalid';
  const used = Buffer.from(sig.publicKey).toString('base64');
  if (!forName.some((k) => Buffer.from(k.key, 'base64').toString('base64') === used)) return 'invalid';
  try {
    return (await verifySshsig(signature, manifest, subtle)) ? 'verified' : 'invalid';
  } catch {
    return 'unknown';
  }
}

/** The runbook's signature state against `keys` (the trusted signers by default). */
export async function signatureState(
  text: string,
  keys: readonly AllowedSigner[] = trusted,
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
  const expires = status.manifest.expires ? { expires: status.manifest.expires } : {};
  const results = await Promise.all(all.map((s) => checkOne(s.signer, s.signature, block.manifest, keys, subtle, now)));
  const bad = all.filter((_, i) => results[i] === 'invalid').map((s) => s.signer);
  if (bad.length > 0) return { kind: 'invalid', signers: bad };
  const good = all.filter((_, i) => results[i] === 'verified').map((s) => s.signer);
  if (good.length > 0) return { kind: 'verified', signers: good, ...expires };
  return { kind: 'unknown', signers: names, ...expires };
}

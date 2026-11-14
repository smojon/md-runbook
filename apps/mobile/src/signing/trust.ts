/**
 * The signers the user trusts (one list, Hosts & settings → Trusted signers), and what a
 * runbook's signature is worth against them. Each key has a source:
 * - a team library (`from`: its base address): the user trusted it from that library's
 *   `allowed_signers` (OpenSSH's format, as md-runbook-gate reads it) after seeing its names and
 *   fingerprint; it counts for that library's runbooks only, and stops counting once the library
 *   no longer publishes it (`withdrawn`, remembered);
 * - "added by you" (`from`: ADDED_BY_YOU): allowed_signers lines the user pasted; they count for
 *   every runbook.
 * keysFor() gives the keys a runbook is checked against: its library's, plus the user's own.
 *
 * A runbook is "Signed by alice: … verified" only when its signature checks out
 * (signing/verify.ts, namespace md-runbook) with such a key listed for the name the signature
 * block gives, and the signature covers every block the app could run (coverage()). The team
 * library's list, the runbook screen's banner and run reports' report-runs-required/-signed
 * (reportSigner) all read the same signatureState.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
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
  wholeRunbookSigned,
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

/** The source of a key the user added by pasting its allowed_signers line: it counts for every runbook. */
export const ADDED_BY_YOU = 'you';

export interface TrustedSigner extends AllowedSigner {
  /**
   * Where it counts: the base address of the library the user trusted it from (that library's
   * runbooks only), or ADDED_BY_YOU (every runbook). A library base is an https address, never
   * ADDED_BY_YOU.
   */
  from: string;
  /**
   * A library's key its allowed_signers no longer listed when last read: it no longer counts,
   * also while the file can't be read (offline, a server error), until the library lists it again.
   */
  withdrawn?: boolean;
}

/** Whether the key was pasted by the user (counts everywhere) rather than trusted from a library. */
export const isAddedByYou = (s: Pick<TrustedSigner, 'from'>): boolean => s.from === ADDED_BY_YOU;

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
 * The key lines of an allowed_signers file that may sign in `namespace` (no default: the trusted
 * signers are runbook signers, SIGNATURE_NAMESPACE). Lines the app can't use are counted in
 * `skipped`: certificate authorities (cert-authority), lines for other namespaces only, lines
 * with an option OpenSSH doesn't know, damaged lines.
 */
export function parseAllowedSigners(text: string, namespace: string): { signers: AllowedSigner[]; skipped: number } {
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
      (namespaces && !matchList(namespace, namespaces))
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

/** Whether the key may sign as `name` in `namespace` now (principals, namespaces, validity). */
export function signerAllows(s: AllowedSigner, name: string, namespace: string, now = Date.now()): boolean {
  if (!namespace || !matchList(name, s.principals)) return false;
  if (s.namespaces && !matchList(namespace, s.namespaces)) return false;
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

const KEY = 'signers.trusted.v2';
/** Before the one list (unreleased builds): the team library's keys, and the run reports' pasted lines in the settings. */
const LEGACY_LIBRARY_KEY = 'signers.trusted.v1';
const LEGACY_SETTINGS_KEY = 'settings.v1';

const isSignerList = (v: unknown): v is TrustedSigner[] =>
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
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

let trusted: readonly TrustedSigner[] = [];
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
let loaded: Promise<void> | undefined;

/** A key line as stored: only the fields of an allowed_signers line, and where it counts. */
const stored = (
  { principals, keyType, key, fingerprint, namespaces, validAfter, validBefore }: AllowedSigner,
  from: string,
): TrustedSigner => ({
  principals,
  keyType,
  key,
  fingerprint,
  ...(namespaces ? { namespaces } : {}),
  ...(validAfter ? { validAfter } : {}),
  ...(validBefore ? { validBefore } : {}),
  from,
});

/**
 * Once: the two lists of the builds before into the one list. The team library's keys
 * (`signers.trusted.v1`) keep their library; the run reports' allowed_signers text (the
 * settings' `trustedSigners`) becomes "added by you", as it counted for every runbook there.
 */
export async function migrateTrustedSigners(): Promise<TrustedSigner[]> {
  const out: TrustedSigner[] = [];
  const add = (s: TrustedSigner): void => {
    if (!out.some((x) => x.from === s.from && sameSigner(x, s))) out.push(s);
  };
  for (const s of (await getJson(LEGACY_LIBRARY_KEY, isSignerList)) ?? []) if (s.from !== ADDED_BY_YOU) add(stored(s, s.from));
  const settings = await getJson(LEGACY_SETTINGS_KEY, isObject);
  if (typeof settings?.trustedSigners === 'string')
    for (const s of parseAllowedSigners(settings.trustedSigners, SIGNATURE_NAMESPACE).signers) add(stored(s, ADDED_BY_YOU));
  return out;
}

export function loadTrustedSigners(): Promise<void> {
  return (loaded ??= (async () => {
    const saved = await getJson(KEY, isSignerList);
    if (saved) trusted = saved;
    else {
      trusted = await migrateTrustedSigners();
      // Written even when empty, so the migration runs once; the settings drop their old field at their next save.
      await setJson(KEY, trusted).catch(() => undefined);
      await AsyncStorage.removeItem(LEGACY_LIBRARY_KEY).catch(() => undefined);
    }
    emit();
  })());
}

function save(next: readonly TrustedSigner[]): void {
  trusted = next;
  emit();
  void setJson(KEY, trusted).catch(() => undefined);
}

/** Every trusted key line, from a library or added by you (Hosts & settings → Trusted signers lists them). */
export const trustedSigners = (): readonly TrustedSigner[] => trusted;

/** The keys trusted from the library at `base`, withdrawn ones included (its signers card, the list). */
export const trustedFor = (base: string): TrustedSigner[] => trusted.filter((s) => s.from === base);

/** The keys the user pasted: they count for every runbook. */
export const addedByYou = (): TrustedSigner[] => trusted.filter(isAddedByYou);

/**
 * The keys a runbook is checked against: those trusted from its library (`base`; undefined for a
 * runbook from elsewhere) that it hasn't withdrawn, and the keys added by you. Never a key trusted
 * from another library. runbooks/library.ts libraryKeys narrows a library read now to the lines it
 * publishes.
 */
export const keysFor = (base: string | undefined): TrustedSigner[] =>
  trusted.filter((s) => isAddedByYou(s) || (base !== undefined && s.from === base && !s.withdrawn));

/** Whether this key line is trusted from the library at `base` (or, with ADDED_BY_YOU, added by you). */
export const isTrustedSigner = (s: AllowedSigner, base: string): boolean => trusted.some((x) => x.from === base && sameSigner(x, s));

/** Trust these lines for the library at `base` (the user said so, after seeing them); other libraries don't use them. */
export function trustSigners(signers: readonly AllowedSigner[], base: string): void {
  if (base === ADDED_BY_YOU) return;
  const add = signers.filter((s, i) => !isTrustedSigner(s, base) && signers.findIndex((x) => sameSigner(x, s)) === i);
  // Trusted again from a library that publishes it again: it counts again.
  const again = trusted.map((x) => (x.from === base && x.withdrawn && signers.some((s) => sameSigner(x, s)) ? stored(x, x.from) : x));
  save([...again, ...add.map((s) => stored(s, base))]);
}

/**
 * Add pasted allowed_signers lines as "added by you" (they count for every runbook): how many were
 * added, were there already, and how many lines were not used (another namespace only, a
 * certificate authority, an unknown option, a damaged line).
 */
export function addSigners(text: string): { added: number; already: number; skipped: number } {
  const { signers, skipped } = parseAllowedSigners(text, SIGNATURE_NAMESPACE);
  const add = signers.filter((s, i) => !isTrustedSigner(s, ADDED_BY_YOU) && signers.findIndex((x) => sameSigner(x, s)) === i);
  if (add.length > 0) save([...trusted, ...add.map((s) => stored(s, ADDED_BY_YOU))]);
  return { added: add.length, already: signers.length - add.length, skipped };
}

/** No longer trust these lines from the library at `base` (or, with ADDED_BY_YOU, as added by you). */
export function untrustSigners(signers: readonly AllowedSigner[], base: string): void {
  save(trusted.filter((x) => !(x.from === base && signers.some((s) => sameSigner(x, s)))));
}

/** Remove one trusted line (Hosts & settings → Trusted signers). */
export function removeTrustedSigner(s: TrustedSigner): void {
  untrustSigners([s], s.from);
}

/**
 * The library at `base` was read and publishes these lines: its trusted keys it no longer lists
 * are marked withdrawn (remembered: they don't count while the file can't be read either), and
 * those it lists again are no longer.
 */
export function noteWithdrawn(base: string, published: readonly AllowedSigner[]): void {
  let changed = false;
  const next = trusted.map((x) => {
    if (x.from !== base) return x;
    const gone = !published.some((s) => sameSigner(s, x));
    if (gone === Boolean(x.withdrawn)) return x;
    changed = true;
    return gone ? { ...x, withdrawn: true } : stored(x, x.from);
  });
  if (changed) save(next);
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

/** A short identity of a key list (which keys, for which names, with which options): a state checked with other keys is not reused. */
export const keysId = (keys: readonly AllowedSigner[]): string =>
  keys
    .map((k) =>
      [k.keyType, k.key, k.principals.join(','), k.namespaces?.join(',') ?? '', k.validAfter ?? '', k.validBefore ?? ''].join(' '),
    )
    .join('\n');

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
 * How much of the runbook its signature covers. `partial`: the bash blocks and runbook calls
 * (manifest version 1), not the text around them ("only these steps verified"); `whole`: all of
 * the text but the signature and output blocks (manifest version 2), PowerShell and cmd blocks
 * included ("whole runbook verified").
 */
export type Coverage = 'whole' | 'partial';

/**
 * The one place that decides what the signature covers, for the team library's states, the
 * runbook screen's banner and run reports alike (signatureState, unsignedRunnable, reportSigner):
 * - manifest version 2 with the text as signed (core wholeRunbookSigned): 'whole';
 * - manifest version 2 whose text changed since signing (prose, front matter, a block added):
 *   'changed', never 'partial' (a gate refuses it, and the signature says nothing of the text now);
 * - manifest version 1: 'partial', whatever the text around the blocks says.
 */
export function coverage(status: SignedStatus): Coverage | 'changed' {
  if (status.version === 2) return wholeRunbookSigned(status) ? 'whole' : 'changed';
  return 'partial';
}

/**
 * Blocks the app could run that the signature doesn't cover: shell blocks of any kind the app
 * runs (bash, sh, pwsh, powershell, cmd, bat) and runbook calls that are not in the manifest.
 * Changed bash blocks and calls are counted by signedStatus already; this adds PowerShell and cmd
 * blocks, which manifest version 1 never signs. 0 unless coverage() is 'partial': a whole
 * runbook signature covers them, and a changed one is 'changed', not partly signed.
 */
export function unsignedRunnable(text: string, status: SignedStatus): number {
  if (coverage(status) !== 'partial') return 0;
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
  /** Blocks changed, added, removed or moved since signing (a gate refuses them), a version 2 runbook whose text changed, or a damaged manifest. */
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
  const forName = keys.filter((k) => signerAllows(k, name, SIGNATURE_NAMESPACE, now));
  if (forName.length === 0) return { result: 'unknown' };
  const used = Buffer.from(sig.publicKey).toString('base64');
  const key = forName.find((k) => Buffer.from(k.key, 'base64').toString('base64') === used);
  if (!key) return { result: 'invalid' };
  try {
    if ((await verifySshsig(signature, manifest, SIGNATURE_NAMESPACE, subtle)) !== true) return { result: 'invalid' };
  } catch (e) {
    // The key matched a trusted one: anything but "this device can't check it" is a bad signature.
    return { result: e instanceof CannotCheck ? 'unknown' : 'invalid' };
  }
  return { result: 'verified', check: { name, fingerprint: key.fingerprint, wildcard: !key.principals.includes(name) } };
}

/**
 * The runbook's signature state against `keys`: keysFor() the runbook (for a library runbook,
 * runbooks/library.ts libraryKeys: the keys trusted from that library, and added by you), never
 * every trusted key.
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
  const covers = coverage(status);
  if (covers === 'changed') return { kind: 'changed', signers: names };
  const m = status.manifest;
  const manifest: SignedManifest = { name: m.name, version: m.version, scopes: m.scopes, ...(m.expires ? { expires: m.expires } : {}) };
  const results = await Promise.all(all.map((s) => checkOne(s.signer, s.signature, block.manifest, keys, subtle, now)));
  const bad = all.filter((_, i) => results[i]!.result === 'invalid').map((s) => s.signer);
  if (bad.length > 0) return { kind: 'invalid', signers: bad };
  const verified = results.flatMap((r) => (r.result === 'verified' ? [r.check] : []));
  const outside = unsignedRunnable(text, status);
  if (outside > 0) return { kind: 'partial', signers: names, manifest, unsigned: outside, verified };
  if (verified.length === 0) return { kind: 'unknown', signers: names, manifest };
  const good = verified.map((v) => v.name);
  if (isExpired(manifest.expires, now)) return { kind: 'expired', signers: good, manifest, verified };
  return { kind: 'verified', signers: good, manifest, verified, coverage: covers };
}

/**
 * The signer whose signature makes a runbook's `report-runs-required` / `-signed` count (core
 * reportPlan): the runbook's state against `keys` (keysFor the runbook: its library's keys and
 * those added by you) is verified, and the signature covers the whole runbook, front matter
 * included. Undefined otherwise: then the run is reported only as the user allows.
 */
export async function reportSigner(
  text: string,
  keys: readonly AllowedSigner[],
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
  now = Date.now(),
): Promise<string | undefined> {
  const s = await signatureState(text, keys, subtle, now);
  return s.kind === 'verified' && s.coverage === 'whole' ? s.verified[0]?.name : undefined;
}

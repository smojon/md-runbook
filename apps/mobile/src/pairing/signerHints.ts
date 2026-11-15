/**
 * What the other device trusts, to compare with: a pairing link carries, for each team library
 * that device trusts signers from, the library's address and the fingerprints of those keys.
 * Kept here as a hint, never as trust: the library's Trust these signers prompt
 * (screens/LibrarySection.tsx) marks each key the library publishes as trusted on the other
 * device or not, and says when the two differ (a library whose list changed between the two
 * devices, or a link that names other keys). A link can confirm or warn about the keys a library
 * publishes; it can never add one, and the user still decides.
 */
import { useSyncExternalStore } from 'react';
import { getJson, setJson } from '../storage/kv';
import { toPublicUrl } from '../settings/publicAddress';
import { ADDED_BY_YOU, TrustedSigner } from '../signing/trust';

export interface SignerHint {
  /** The library's base address, as the other device's users reach it (its public address). */
  library: string;
  /** `SHA256:…` of each key that device trusts for this library. */
  fingerprints: string[];
}

/** At most this many libraries and keys per library in a link (a QR code has room for little). */
export const MAX_HINT_LIBRARIES = 8;
export const MAX_HINT_KEYS = 32;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const KEY = 'pairing.signerHints.v1';

/** A library's address as compared: a URL's own spelling (lower-case host), ending in `/`. */
export function libraryKey(base: string): string | undefined {
  let u: URL;
  try {
    u = new URL(base.trim());
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return undefined;
  u.hash = '';
  u.search = '';
  return u.href.endsWith('/') ? u.href : u.href + '/';
}

/** The hints in a pairing's JSON, checked; undefined when the field is not a list of them. */
export function readSignerHints(v: unknown): SignerHint[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_HINT_LIBRARIES) return undefined;
  const out: SignerHint[] = [];
  for (const h of v) {
    if (typeof h !== 'object' || h === null) return undefined;
    const { library, fingerprints } = h as Record<string, unknown>;
    const key = typeof library === 'string' ? libraryKey(library) : undefined;
    if (!key || !Array.isArray(fingerprints) || fingerprints.length === 0 || fingerprints.length > MAX_HINT_KEYS) return undefined;
    if (!fingerprints.every((f) => typeof f === 'string' && FINGERPRINT.test(f))) return undefined;
    if (out.some((x) => x.library === key)) return undefined;
    out.push({ library: key, fingerprints: [...new Set(fingerprints as string[])] });
  }
  return out;
}

/**
 * What this device trusts, for a pairing link: per library, the fingerprints of the keys trusted
 * from it that it still publishes (not those added by you: they count everywhere, not for a
 * library), with the library at its public address.
 */
export function hintsFrom(trusted: readonly TrustedSigner[]): SignerHint[] {
  const by = new Map<string, Set<string>>();
  for (const s of trusted) {
    if (s.from === ADDED_BY_YOU || s.withdrawn) continue;
    const key = libraryKey(toPublicUrl(s.from));
    if (!key) continue;
    if (!by.has(key)) by.set(key, new Set());
    by.get(key)!.add(s.fingerprint);
  }
  return [...by].slice(0, MAX_HINT_LIBRARIES).map(([library, set]) => ({ library, fingerprints: [...set].slice(0, MAX_HINT_KEYS) }));
}

interface Stored {
  /** When the pairing was set up (ms). */
  at: number;
  hints: SignerHint[];
}
const isStored = (v: unknown): v is Stored =>
  typeof v === 'object' && v !== null && typeof (v as Stored).at === 'number' && readSignerHints((v as Stored).hints) !== undefined;

let current: Stored | undefined;
let loaded: Promise<void> | undefined;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

export function loadSignerHints(): Promise<void> {
  return (loaded ??= (async () => {
    current = (await getJson(KEY, isStored)) ?? current;
    emit();
  })());
}

/** A pairing was set up: its hints replace the earlier ones (the latest pairing is the other device). */
export function rememberSignerHints(hints: readonly SignerHint[], now = Date.now()): void {
  current = { at: now, hints: [...hints] };
  emit();
  void setJson(KEY, current).catch(() => undefined);
}

/** The other device's hint for the library at `base` (as this device reaches it, or at its public address). */
export function signerHintFor(base: string): (SignerHint & { at: number }) | undefined {
  if (!current) return undefined;
  const keys = new Set([libraryKey(base), libraryKey(toPublicUrl(base))].filter((k): k is string => k !== undefined));
  const hint = current.hints.find((h) => keys.has(h.library));
  return hint ? { ...hint, at: current.at } : undefined;
}

export interface HintComparison {
  /** Fingerprints the library publishes that the other device trusts. */
  trustedThere: Set<string>;
  /** Keys the library publishes that the other device doesn't trust. */
  notThere: number;
  /** Keys the other device trusts that this library doesn't publish (now). */
  missingHere: number;
  /** The same keys on both sides. */
  same: boolean;
}

/** The library's published keys against the other device's hint. */
export function compareWithHint(published: readonly { fingerprint: string }[], hint: SignerHint): HintComparison {
  const there = new Set(hint.fingerprints);
  const here = new Set(published.map((s) => s.fingerprint));
  const trustedThere = new Set([...here].filter((f) => there.has(f)));
  const notThere = [...here].filter((f) => !there.has(f)).length;
  const missingHere = [...there].filter((f) => !here.has(f)).length;
  return { trustedThere, notThere, missingHere, same: notThere === 0 && missingHere === 0 };
}

/** Re-renders when a pairing brings new hints; loads them the first time. */
export function useSignerHints(): void {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      void loadSignerHints();
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function resetSignerHints(): void {
  current = undefined;
  loaded = undefined;
  emit();
}

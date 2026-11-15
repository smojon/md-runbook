/**
 * The pairing waiting to be confirmed (screens/PairScreen.tsx): from a pairing link's fragment, or
 * a code scanned with Pair with another device. Kept in memory only, and handed over once: never
 * through the router's query (the token would land in the address bar and the history).
 */
import { PAIR_MARKER, PAIR_PATH } from './payload';

export type PendingSource = 'link' | 'code';

let pending: { payload: string; source: PendingSource } | undefined;

export function setPendingPairing(payload: string, source: PendingSource): void {
  pending = { payload, source };
}

/** The pairing waiting for the user's answer. */
export function pendingPairing(): { payload: string; source: PendingSource } | undefined {
  return pending;
}

/** Answered (set up, or not): the payload is forgotten. */
export function clearPendingPairing(): void {
  pending = undefined;
}

interface PageLike {
  location: { pathname: string; search: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void; state?: unknown };
}

/**
 * A pairing link opened (`…/pair#mdrb-pair.v1.…`): its payload is kept for the pair screen and the
 * fragment is removed from the address bar at once (history.replaceState), so it is neither in
 * the history nor in a bookmark or a shared address afterwards. Read once, when the app loads;
 * true when there was one. `page`: tests (by default the browser's window).
 */
/**
 * Whether the route still carries a pairing link's fragment: Expo Router keeps a URL's fragment
 * as the route's `#` param and writes it back into the address bar whenever it updates the URL,
 * so history.replaceState alone leaves the token there. `hash`: the address bar's, if any.
 */
export function pairingFragmentInRoute(fragment: unknown, hash?: string): boolean {
  return (typeof fragment === 'string' && fragment.startsWith(PAIR_MARKER)) || (hash?.startsWith('#' + PAIR_MARKER) ?? false);
}

export function capturePairingFragment(page?: PageLike): boolean {
  const w = page ?? (globalThis as { window?: PageLike }).window;
  if (!w?.location || !w.history) return false;
  const { pathname, search, hash } = w.location;
  if (!pathname.replace(/\/+$/, '').endsWith(PAIR_PATH) || !hash.startsWith('#' + PAIR_MARKER)) return false;
  setPendingPairing(hash.slice(1), 'link');
  try {
    w.history.replaceState(w.history.state ?? null, '', pathname + search);
  } catch {
    // An address bar that can't be changed: the payload is still read only once.
  }
  return true;
}

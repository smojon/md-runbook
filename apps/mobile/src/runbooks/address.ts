/**
 * Where a runbook can be downloaded from, for a QR code or a link that points there instead of
 * carrying the runbook (Show QR Code's "Link to its address"): a team library copy's file, or the
 * address an url= link opened. Such a link is small whatever the runbook's size, and pinned
 * (sha256): the other device refuses another text. Runbooks with no address (a file, one made
 * here, one carried in a link) are carried in the code (rb=).
 */
import { clearOutputBlocks } from '@md-runbook/core';
import { RunbookLink, formatRunbookLink, runbookDigest } from '@md-runbook/core/runbookLink';
import { openLinkBase, toPublicUrl } from '../settings/publicAddress';
import { LibraryState, libraryFileUrl, libraryHash } from './library';
import { textHash } from './origin';
import type { Runbook } from './store';

export type NoAddress = 'edited' | 'changed' | 'https';

/**
 * The runbook's address as others reach it (the web app's public address for a library on its
 * own origin) and the pin of its text without outputs; or why a link to it would not open the
 * same text; undefined when it has no address.
 */
export function runbookAddress(r: Runbook, library: LibraryState): { url: string; sha256: string } | { problem: NoAddress } | undefined {
  const bare = clearOutputBlocks(r.text);
  /** The text the address serves, when the app has it as served (else the copy's, without outputs). */
  let served = bare;
  let url: string;
  if (r.source === 'library' && r.library) {
    const ref = r.library;
    if (libraryHash(bare) !== ref.bare) return { problem: 'edited' };
    // The library's file is no longer the one the copy was made from: a pin would be refused.
    const entry = library.base === ref.base ? library.library?.entries.find((e) => e.path === ref.path) : undefined;
    if (entry?.hash !== undefined && entry.hash !== ref.hash) return { problem: 'changed' };
    if (entry?.text !== undefined) served = entry.text;
    url = toPublicUrl(libraryFileUrl(ref.base, ref.path));
  } else if (r.source === 'file' && r.link) {
    // linkKey: `<address> <fingerprint of the text it gave>` (`rb …` for a runbook carried in a link).
    const at = r.link.lastIndexOf(' ');
    const source = r.link.slice(0, at);
    if (at < 0 || source === 'rb' || !/^https:\/\//.test(source)) return undefined;
    const given = r.link.slice(at + 1);
    if (textHash(bare) !== given && textHash(r.text) !== given) return { problem: 'edited' };
    url = source;
  } else return undefined;
  if (!url.startsWith('https://')) return { problem: 'https' };
  return { url, sha256: runbookDigest(served) };
}

/** The link a QR code shows: to the address (pinned) when there is one, else the runbook itself. */
export function qrLink(
  r: Runbook,
  address: { url: string; sha256: string } | undefined,
  extra: Pick<RunbookLink, 'host' | 'params'>,
): string {
  const l: RunbookLink = address ? { url: address.url, sha256: address.sha256, ...extra } : { text: clearOutputBlocks(r.text), ...extra };
  return formatRunbookLink(l, openLinkBase());
}

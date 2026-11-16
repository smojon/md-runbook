/**
 * Opening a runbook from a link: what VS Code's Open in the App sends, a link in a mail or a chat,
 * a file on GitHub or GitLab. The app keeps a copy (a link can't be saved back to); Share Runbook
 * or Download hands it on. The same link opened again (each click on an alert's link) opens that
 * copy, as long as the runbook at the address is unchanged; Start Incident makes a copy per incident.
 * A link to a runbook of the team library opens the library copy instead (openInLibrary).
 */
import { clearOutputBlocks } from '@md-runbook/core';
import { LinkTrust, RunbookLink, checkedLinkTrust, linkTrust, parseRunbookLink, rawRunbookUrl } from '@md-runbook/core/runbookLink';
import { choiceProblem } from '@md-runbook/core/secrets';
import { readSignature, signedText } from '@md-runbook/core/signing';
import { getHosts, loadHosts } from '../hosts/store';
import { t } from '../i18n';
import { loadSettings, outputSettings } from '../settings/store';
import { loadRuntimeConfig } from '../settings/runtimeConfig';
import { isVerified, loadTrustedSigners, signatureState } from '../signing/trust';
import {
  keysForLibrary,
  libraryHost,
  libraryState,
  libraryTarget,
  loadLibraryMemory,
  openLibraryRunbook,
  refreshLibrary,
  signedOnlyPolicy,
} from './library';
import { activeCall } from './calls';
import { runbookBusy, setLinkContext } from './linkContext';
import { runbookParams, setParamValue } from './params';
import { MAX_RUNBOOK_BYTES, Runbook, addRunbook, libraryCopy, linkKey, linkedRunbook, loadRunbooks, titleOf } from './store';

/** The raw file behind a link (in core, shared with VS Code's link handler). */
export { rawRunbookUrl };

/**
 * Whether a copy's text is still `fetched` but for what running it adds (core signedText: outputs,
 * notes and ticks outside code), with the same signature block.
 */
function sameBareText(copy: string, fetched: string): boolean {
  const sig = (s: string): string => JSON.stringify(readSignature(s) ?? null);
  return signedText(copy) === signedText(fetched) && sig(copy) === sig(fetched);
}

/** `deploy.md` from `…/runbooks/deploy.md?x=1`; `runbook.md` when the link has no file name. */
function fileNameOf(url: string): string {
  const raw = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  let last: string;
  try {
    last = decodeURIComponent(raw);
  } catch {
    last = raw; // a stray % in the name
  }
  return /\.(md|markdown)$/i.test(last) ? last : `${last || 'runbook'}.md`;
}

/**
 * Open a runbook link (core/runbookLink.ts): download the runbook or unpack the one the link
 * carries, refuse a text other than the link pins, fill in the link's parameters and remember its
 * host and action for the runbook screen. Nothing runs.
 */
export async function openRunbookLink(
  link: string,
  fetcher?: typeof fetch,
): Promise<{ kind: 'opened'; runbook: Runbook } | { kind: 'error'; message: string }> {
  const parsed = parseRunbookLink(link);
  if (!parsed.ok) return { kind: 'error', message: t.linkProblem[parsed.problem] };
  const l = parsed.link;
  // A runbook of the team library: its copy there, under the library's rules.
  if (l.url !== undefined) {
    const fromLibrary = await openInLibrary(l, fetcher);
    if (fromLibrary) return fromLibrary;
  }
  let text: string;
  let fileName: string;
  let source: string;
  if (l.text !== undefined) {
    source = 'rb';
    text = l.text;
    fileName = `${
      titleOf(text, 'runbook.md')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'runbook'
    }.md`;
  } else {
    const url = rawRunbookUrl(l.url!);
    if (!url) return { kind: 'error', message: t.linkInvalid };
    source = url;
    fileName = fileNameOf(url);
    try {
      const res = await (fetcher ?? fetch)(url);
      if (!res.ok) return { kind: 'error', message: t.linkFailed(`HTTP ${res.status}`) };
      // Too large: refused before reading it, where the server says its size.
      if (Number(res.headers?.get('content-length') ?? 0) > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(fileName) };
      text = await res.text();
    } catch (e) {
      return { kind: 'error', message: t.linkFailed(e instanceof Error ? e.message : String(e)) };
    }
    if (text.length > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(fileName) };
  }
  // Opened at a cold start (a QR code, a pager alert): the hosts and settings may still be loading.
  // The remembered runbooks too, to find a copy this link opened before.
  await Promise.all([loadHosts(), loadSettings(), loadRunbooks()]);
  const trust = await checkedTrust(l, text, undefined);
  if (trust === 'mismatch') return { kind: 'error', message: t.linkMismatch };
  if (trust !== 'signed' && outputSettings().signedLinksOnly) return { kind: 'error', message: t.linkUnsignedRefused };

  const key = linkKey(source, text);
  // The copy this link opened before, only while it is still the text whose trust was just checked
  // (but for what runs add: outputs, notes, ticks). One edited since: a new copy. One running or
  // waiting for an answer, or a call's copy (the same key when the call adds no front matter): a
  // new copy too, so the link's values don't change what it is about to run.
  const fits = (r: Runbook): boolean => sameBareText(r.text, text);
  const before = linkedRunbook(key, fits);
  const runbook = linkedRunbook(key, (r) => fits(r) && !inUse(r)) ?? addRunbook(fileName, text, undefined, key);
  applyLink(runbook, l, text, trust, before !== undefined && inUse(before));
  return { kind: 'opened', runbook };
}

/** A runbook a link must not fill values into: its screen runs it or waits for an answer, or it is a call's copy. */
function inUse(r: Runbook): boolean {
  return runbookBusy(r.id) || activeCall(r.id) !== undefined;
}

/**
 * The link's trust with its signature checked: `signed` only when the signature verifies against
 * the keys the runbook is checked against everywhere else (keysForLibrary: its library's and those
 * added by you; for a runbook from elsewhere, those added by you). A signature block anyone can
 * write isn't enough (security review, 2026-11-16).
 */
async function checkedTrust(l: RunbookLink, text: string, libraryBase: string | undefined): Promise<LinkTrust> {
  const trust = linkTrust(l, text);
  if (trust !== 'signed') return trust;
  await loadTrustedSigners();
  return checkedLinkTrust(l, trust, isVerified(await signatureState(text, keysForLibrary(libraryBase))));
}

/** Fill in the link's parameters and remember its host and action for the runbook screen. */
function applyLink(runbook: Runbook, l: RunbookLink, text: string, trust: Exclude<LinkTrust, 'mismatch'>, freshCopy = false): void {
  const declared = new Map(runbookParams(text).map((p) => [p.name, p]));
  const ignoredParams: string[] = [];
  const refusedParams: string[] = [];
  for (const [name, value] of Object.entries(l.params)) {
    const spec = declared.get(name);
    if (!spec) ignoredParams.push(name);
    // Not one of its choices ("One of: get, describe"): not taken, typed when it runs (as VS Code).
    else if (choiceProblem(spec, value)) refusedParams.push(name);
    else setParamValue(runbook.id, name, value);
  }
  // A link names a host; it never adds one (its address and key are the user's to set).
  const host = l.host ? getHosts().find((h) => h.name === l.host) : undefined;
  setLinkContext(runbook.id, {
    trust,
    ...(host ? { hostId: host.id } : l.host ? { missingHost: l.host } : {}),
    ignoredParams,
    ...(refusedParams.length > 0 ? { refusedParams } : {}),
    cosign: l.action === 'cosign',
    ...(freshCopy ? { freshCopy } : {}),
  });
}

/**
 * A link to a runbook of the team library the app reads (runbooks/library.ts libraryTarget): it
 * opens THE library copy, the one Team runbooks opens (its outputs, Update / Keep mine), with the
 * link's parameters and host, never a second copy. The library's rules hold as when it is opened
 * from the list (openLibraryRunbook: signedOnly, trusted signers, versions seen), and the link's
 * own: its sha256 pin, and Only signed links. The library is read first when it isn't yet (within
 * a minute of the last read, what was read is used).
 *
 * When the library can't be read or doesn't list the file: the user's copy when there is one (the
 * runbook screen still holds it to the library's rules: copyRefusal); else, for a library that
 * opens verified runbooks only, the link is refused (a link must not get round signedOnly); else
 * undefined, and the link opens as any other.
 */
async function openInLibrary(
  l: RunbookLink,
  fetcher: typeof fetch | undefined,
): Promise<{ kind: 'opened'; runbook: Runbook } | { kind: 'error'; message: string } | undefined> {
  await Promise.all([loadSettings(), loadRuntimeConfig(fetcher)]);
  const target = libraryTarget(l.url!);
  if (!target) return undefined;
  await Promise.all([loadHosts(), loadRunbooks(), loadLibraryMemory()]);
  await refreshLibrary({ fetcher });
  const s = libraryState();
  const lib = s.base === target.base && s.status === 'ready' ? s.library : undefined;
  const entry = lib?.entries.find((e) => e.path === target.path);
  const opened = async (
    text: string,
    open: () => Promise<{ kind: 'opened'; runbook: Runbook } | { kind: 'error'; message: string }>,
  ): Promise<{ kind: 'opened'; runbook: Runbook } | { kind: 'error'; message: string }> => {
    const trust = await checkedTrust(l, text, target.base);
    if (trust === 'mismatch') return { kind: 'error', message: t.linkMismatch };
    if (trust !== 'signed' && outputSettings().signedLinksOnly) return { kind: 'error', message: t.linkUnsignedRefused };
    // The library copy is the only one: while it runs or waits for an answer, the link is refused
    // rather than change its values (or its text, through Update).
    const busyCopy = libraryCopy(target.base, target.path);
    if (busyCopy && inUse(busyCopy)) return { kind: 'error', message: t.linkRunbookBusy(busyCopy.fileName ?? busyCopy.title) };
    const r = await open();
    if (r.kind === 'opened' && inUse(r.runbook))
      return { kind: 'error', message: t.linkRunbookBusy(r.runbook.fileName ?? r.runbook.title) };
    if (r.kind === 'opened') applyLink(r.runbook, l, r.runbook.text, trust);
    return r;
  };
  if (lib && entry?.text !== undefined) {
    const text = entry.text;
    return opened(text, () => openLibraryRunbook(lib, entry));
  }
  const mine = libraryCopy(target.base, target.path);
  if (mine) return opened(clearOutputBlocks(mine.text), async () => ({ kind: 'opened', runbook: mine }));
  if (!signedOnlyPolicy(target.base)) return undefined;
  return { kind: 'error', message: lib ? t.libraryLinkNotListed(target.path) : t.libraryLinkUnavailable(libraryHost(target.base)) };
}

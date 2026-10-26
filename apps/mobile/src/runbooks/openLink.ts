/**
 * Opening a runbook from a link: what VS Code's Open in the App sends, a link in a mail or a chat,
 * a file on GitHub or GitLab. The app keeps a copy (a link can't be saved back to); Share Runbook
 * or Download hands it on.
 */
import { linkTrust, parseRunbookLink } from '@md-runbook/core/runbookLink';
import { getHosts, loadHosts } from '../hosts/store';
import { t } from '../i18n';
import { loadSettings, outputSettings } from '../settings/store';
import { setLinkContext } from './linkContext';
import { runbookParams, setParamValue } from './params';
import { MAX_RUNBOOK_BYTES, Runbook, addRunbook, titleOf } from './store';

/** The raw file behind a link: GitHub and GitLab pages give their raw address; only https. */
export function rawRunbookUrl(link: string): string | undefined {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:') return undefined;
  const gh = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
  if (u.hostname === 'github.com' && gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
  const gl = /^(.+)\/-\/blob\/(.+)$/.exec(u.pathname);
  if (gl) return `${u.origin}${gl[1]}/-/raw/${gl[2]}${u.search}`;
  return u.toString();
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
  fetcher: typeof fetch = fetch,
): Promise<{ kind: 'opened'; runbook: Runbook } | { kind: 'error'; message: string }> {
  const parsed = parseRunbookLink(link);
  if (!parsed.ok) return { kind: 'error', message: t.linkProblem[parsed.problem] };
  const l = parsed.link;
  let text: string;
  let fileName: string;
  if (l.text !== undefined) {
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
    fileName = fileNameOf(url);
    try {
      const res = await fetcher(url);
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
  await Promise.all([loadHosts(), loadSettings()]);
  const trust = linkTrust(l, text);
  if (trust === 'mismatch') return { kind: 'error', message: t.linkMismatch };
  if (trust !== 'signed' && outputSettings().signedLinksOnly) return { kind: 'error', message: t.linkUnsignedRefused };

  const runbook = addRunbook(fileName, text);
  const declared = new Set(runbookParams(text).map((p) => p.name));
  const ignoredParams: string[] = [];
  for (const [name, value] of Object.entries(l.params)) {
    if (declared.has(name)) setParamValue(runbook.id, name, value);
    else ignoredParams.push(name);
  }
  // A link names a host; it never adds one (its address and key are the user's to set).
  const host = l.host ? getHosts().find((h) => h.name === l.host) : undefined;
  setLinkContext(runbook.id, {
    trust,
    ...(host ? { hostId: host.id } : l.host ? { missingHost: l.host } : {}),
    ignoredParams,
    cosign: l.action === 'cosign',
  });
  return { kind: 'opened', runbook };
}

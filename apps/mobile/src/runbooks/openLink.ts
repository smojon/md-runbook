/**
 * Opening a runbook from a link: what VS Code's Open in the App sends, a link in a mail or a chat,
 * a file on GitHub or GitLab. The app keeps a copy (a link can't be saved back to); Share Runbook
 * or Download hands it on.
 */
import { t } from '../i18n';
import { MAX_RUNBOOK_BYTES, Runbook, addRunbook } from './store';

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

export async function openRunbookLink(
  link: string,
  fetcher: typeof fetch = fetch,
): Promise<{ kind: 'opened'; runbook: Runbook } | { kind: 'error'; message: string }> {
  const url = rawRunbookUrl(link);
  if (!url) return { kind: 'error', message: t.linkInvalid };
  let text: string;
  try {
    const res = await fetcher(url);
    if (!res.ok) return { kind: 'error', message: t.linkFailed(`HTTP ${res.status}`) };
    // Too large: refused before reading it, where the server says its size.
    if (Number(res.headers?.get('content-length') ?? 0) > MAX_RUNBOOK_BYTES)
      return { kind: 'error', message: t.fileTooLarge(fileNameOf(url)) };
    text = await res.text();
  } catch (e) {
    return { kind: 'error', message: t.linkFailed(e instanceof Error ? e.message : String(e)) };
  }
  if (text.length > MAX_RUNBOOK_BYTES) return { kind: 'error', message: t.fileTooLarge(fileNameOf(url)) };
  return { kind: 'opened', runbook: addRunbook(fileNameOf(url), text) };
}

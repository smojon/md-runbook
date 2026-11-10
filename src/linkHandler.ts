/**
 * Runbook links in VS Code: `vscode://smojon.md-runbook/open?…` (core/runbookLink.ts, the same
 * fields as the app's mdrunbook:// links) opens the runbook here, so the link in a pager alert
 * works on a laptop too. The runbook opens from the workspace when a clone of its repository is
 * open there, else as a downloaded copy; the link's parameters are filled in. Nothing runs.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LinkProblem, LinkTrust, RunbookLink, linkTrust, linkableParams, parseVsCodeLinkQuery, rawRunbookUrl, repoPathCandidates, runbookDigest } from '@md-runbook/core/runbookLink';
import { runbookTitle } from '@md-runbook/core/title';
import type { SecretsInfo } from './secrets';
import { NOTEBOOK_TYPE } from './serializer';

/** A runbook larger than this is refused (the app's limit). */
const MAX_RUNBOOK_BYTES = 5 * 1024 * 1024;

const PROBLEMS: Record<LinkProblem, string> = {
  'not-a-link': 'it is not a runbook link',
  'no-runbook': 'it names no runbook (url= or rb=)',
  both: 'it has both url= and rb=',
  'not-https': 'the runbook address is not https',
  'bad-text': 'the runbook it carries is damaged',
  'too-large': 'the runbook it carries is too large',
  'bad-sha256': 'its sha256= is not a SHA-256',
  'bad-host': 'its host= is not a host name',
  'bad-param': 'a parameter name or value is invalid',
};

const TRUST: Record<Exclude<LinkTrust, 'mismatch'>, string> = {
  signed: 'signed, no signed block changed',
  pinned: 'the version the link pins',
  unverified: 'not signed or pinned: read it before you run it',
};

/** `deploy.md` from `…/runbooks/deploy.md?x=1`; `runbook.md` when the address has no file name. */
function fileNameOf(url: string): string {
  const raw = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  let last: string;
  try {
    last = decodeURIComponent(raw);
  } catch {
    last = raw;
  }
  last = last.replace(/[\\/:*?"<>|]/g, '-');
  return /\.(md|markdown)$/i.test(last) ? last : `${last || 'runbook'}.md`;
}

/** The workspace's copy of a GitHub or GitLab file: the longest repository path that exists in an open folder. */
function workspaceCopy(url: string): vscode.Uri | undefined {
  for (const rel of repoPathCandidates(url)) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      const file = path.join(folder.uri.fsPath, ...rel.split('/'));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return vscode.Uri.file(file);
    }
  }
  return undefined;
}

async function download(url: string): Promise<string> {
  const raw = rawRunbookUrl(url);
  if (!raw) throw new Error('the runbook address is not https');
  const res = await fetch(raw);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${raw}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_RUNBOOK_BYTES) throw new Error('the runbook is too large');
  const text = await res.text();
  if (text.length > MAX_RUNBOOK_BYTES) throw new Error('the runbook is too large');
  return text;
}

/**
 * The copy a link opens: one per source and downloaded text, so opening the same link again (each
 * click on an alert) opens the copy with its runs, as long as the runbook is unchanged.
 */
function linkCopy(storage: vscode.Uri, source: string, text: string, fileName: string): vscode.Uri {
  const key = createHash('sha256').update(source).update('\0').update(runbookDigest(text)).digest('hex').slice(0, 16);
  const dir = path.join(storage.fsPath, 'links', key);
  const file = path.join(dir, fileName);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
  return vscode.Uri.file(file);
}

type OpenedTrust = Exclude<LinkTrust, 'mismatch'>;
export type OpenLinkResult = { kind: 'opened'; uri: vscode.Uri; trust: OpenedTrust; filled: string[]; ignored: string[] } | { kind: 'error'; message: string } | { kind: 'cancelled' };

/** Open a link's runbook (the query of a vscode:// link, as VS Code gives it). */
export async function openRunbookLinkQuery(query: string, storage: vscode.Uri, secrets: SecretsInfo): Promise<OpenLinkResult> {
  const parsed = parseVsCodeLinkQuery(query);
  if (!parsed.ok) return { kind: 'error', message: `md-runbook: this link can't be opened: ${PROBLEMS[parsed.problem]}.` };
  const l: RunbookLink = parsed.link;

  let target: vscode.Uri;
  let text: string;
  if (l.text !== undefined) {
    text = l.text;
    const title = runbookTitle(text) ?? 'runbook';
    target = linkCopy(storage, 'rb', text, `${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'runbook'}.md`);
  } else {
    const url = l.url!;
    const local = workspaceCopy(url);
    const localText = local ? fs.readFileSync(local.fsPath, 'utf8') : undefined;
    if (local && localText !== undefined && (!l.sha256 || runbookDigest(localText) === l.sha256)) {
      target = local;
      text = localText;
    } else {
      if (local) {
        // An edited copy, or another branch: the user chooses.
        const yours = 'Open Your Copy';
        const linked = 'Open the Linked Version';
        const choice = await vscode.window.showWarningMessage(
          `md-runbook: your workspace's ${vscode.workspace.asRelativePath(local)} differs from the version the link pins (edited, or another branch).`,
          yours,
          linked,
        );
        if (choice === undefined) return { kind: 'cancelled' };
        if (choice === yours) {
          // Not the pinned version: only its own signature can vouch for it.
          const { sha256: _pin, ...unpinned } = l;
          const own = linkTrust(unpinned, localText!);
          return finish(l, local, localText!, own === 'signed' ? 'signed' : 'unverified', secrets);
        }
      }
      try {
        text = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `md-runbook: downloading ${fileNameOf(url)}` }, () => download(url));
      } catch (e) {
        return { kind: 'error', message: `md-runbook: the runbook could not be downloaded: ${e instanceof Error ? e.message : String(e)}` };
      }
      target = linkCopy(storage, url, text, fileNameOf(url));
    }
  }
  const trust = linkTrust(l, text);
  if (trust === 'mismatch') return { kind: 'error', message: 'md-runbook: the runbook at this address is not the one the link pins (it changed since the link was made): not opened.' };
  return finish(l, target, text, trust, secrets);
}

async function finish(l: RunbookLink, target: vscode.Uri, text: string, trust: OpenedTrust, secrets: SecretsInfo): Promise<OpenLinkResult> {
  await vscode.commands.executeCommand('vscode.openWith', target, NOTEBOOK_TYPE);
  const nb = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === target.toString());
  const known = new Set(linkableParams(text).map((p) => p.name));
  const filled = Object.keys(l.params).filter((n) => known.has(n));
  const ignored = Object.keys(l.params).filter((n) => !known.has(n));
  if (nb && filled.length > 0) secrets.fillParameters(nb, Object.fromEntries(filled.map((n) => [n, l.params[n]!])));
  return { kind: 'opened', uri: target, trust, filled, ignored };
}

export function registerLinkHandler(context: vscode.ExtensionContext, secrets: SecretsInfo, testMode: boolean): void {
  const open = async (query: string): Promise<OpenLinkResult> => {
    const r = await openRunbookLinkQuery(query, context.globalStorageUri, secrets);
    if (r.kind === 'error') void vscode.window.showErrorMessage(r.message);
    if (r.kind === 'opened') {
      const parsed = parseVsCodeLinkQuery(query);
      const l = parsed.ok ? parsed.link : undefined;
      const parts = [`md-runbook: opened ${path.basename(r.uri.fsPath)} from a link (${TRUST[r.trust]}).`];
      if (r.filled.length) parts.push(`Filled in: ${r.filled.map((n) => `${n}=${l?.params[n]}`).join(', ')}.`);
      if (r.ignored.length) parts.push(`Not used by this runbook: ${r.ignored.join(', ')}.`);
      if (l?.host) parts.push(`The link names the app host ${l.host}: here, cells run on this machine or on their own host=.`);
      parts.push('Nothing runs until you run it.');
      const cosign = l?.action === 'cosign' ? 'Co-sign Runbook' : undefined;
      const message = parts.join(' ');
      const buttons = cosign ? [cosign] : [];
      const shown = r.trust === 'unverified' ? vscode.window.showWarningMessage(message, ...buttons) : vscode.window.showInformationMessage(message, ...buttons);
      void shown.then((c) => {
        if (c === cosign) void vscode.commands.executeCommand('mdRunbook.cosignRunbook');
      });
    }
    return r;
  };
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path === '/open') void open(uri.query);
      },
    }),
  );
  // For tests: open a link as the handler would (the query as VS Code decodes it).
  if (testMode) context.subscriptions.push(vscode.commands.registerCommand('mdRunbook._test.openLink', (link: string) => open(vscode.Uri.parse(link).query)));
}

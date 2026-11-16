/**
 * Publish to Library… and Remove from Library… (Share ▾): what `md-runbook publish` and
 * `md-runbook unpublish` do (libraryClient.ts), from the editor. The library server's address is
 * a setting (machine scope: a workspace can't send the token elsewhere); its upload token is kept
 * in VS Code's SecretStorage, per server, and only ever sent to that server. Only a runbook signed
 * as a whole, unchanged since, can go in: otherwise Sign Runbook is offered first.
 */

import * as vscode from 'vscode';
import { libraryPathProblem, nameFitsPath } from '@md-runbook/core/library';
import { readSignature, parseManifest } from '@md-runbook/core/signing';
import { SECTION } from './config';
import { LibraryAnswer, PublishCheck, cleanLibraryPath, libraryServerAddress, publishCheck, publishedText, removeRefusal, sendToLibrary } from './libraryClient';
import { saveIfOpen, targetUri } from './signing';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
/** globalState: the library path each file was last published at (the default next time). */
const PUBLISHED_KEY = 'mdRunbook.library.published';
const TOKEN_KEY = 'mdRunbook.library.token ';
const TOKEN_RE = /^[\x21-\x7e]{24,}$/;

let ctx: vscode.ExtensionContext;

const originOf = (server: string): string => {
  try {
    return new URL(server).origin;
  } catch {
    return server;
  }
};
const hostOf = (server: string): string => {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
};

/**
 * The library server's address: `mdRunbook.library.server`, else the origin of the library the
 * Library view reads (`mdRunbook.library.url`: the web container serves both). Asked for, and
 * saved in the user settings, when there is none and `ask`.
 */
export async function libraryServer(ask: boolean): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const set = cfg.get<string>('library.server', '').trim();
  const fromUrl = cfg.get<string>('library.url', '').trim();
  const candidate = set || (fromUrl ? originOf(fromUrl) : '');
  if (candidate) {
    const a = libraryServerAddress(candidate);
    if ('base' in a) return a.base;
    if (!ask) return undefined;
    void vscode.window.showErrorMessage(`md-runbook: ${set ? 'mdRunbook.library.server' : 'mdRunbook.library.url'} is not usable: ${a.problem}.`);
  }
  if (!ask) return undefined;
  const typed = await vscode.window.showInputBox({
    title: 'md-runbook: the library server’s address',
    prompt: 'Where your team’s library server answers (apps/library-server). Saved in your user settings.',
    placeHolder: 'https://runbooks.example.net',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const a = libraryServerAddress(v);
      return 'problem' in a ? a.problem : undefined;
    },
  });
  if (!typed) return undefined;
  const a = libraryServerAddress(typed);
  if ('problem' in a) return undefined;
  await cfg.update('library.server', a.base, vscode.ConfigurationTarget.Global);
  return a.base;
}

/** The stored upload token for `server`, asked for (and stored) when there is none and `ask`. */
async function tokenFor(server: string, ask: boolean, again = false): Promise<string | undefined> {
  const key = TOKEN_KEY + originOf(server);
  if (!again) {
    const stored = await ctx.secrets.get(key);
    if (stored) return stored;
  }
  if (!ask) return undefined;
  const typed = await vscode.window.showInputBox({
    title: `md-runbook: upload token for ${hostOf(server)}`,
    prompt: again ? 'The server refused the stored token. Enter another one (kept in VS Code’s secret storage).' : 'From the library server’s admin (LIBRARY_UPLOAD_TOKENS). Kept in VS Code’s secret storage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (TOKEN_RE.test(v.trim()) ? undefined : 'An upload token: at least 24 characters, no spaces.'),
  });
  if (!typed || !TOKEN_RE.test(typed.trim())) return undefined;
  await ctx.secrets.store(key, typed.trim());
  return typed.trim();
}

const CHECK_TEXT: Record<Exclude<PublishCheck, { ok: true }>['why'], { title: string; points: string[] }> = {
  unsigned: { title: 'This runbook is not signed.', points: ['A team library takes signed runbooks only.', 'Sign Runbook signs the whole runbook.'] },
  unreadable: { title: 'Its signature block is damaged.', points: ['A team library takes signed runbooks only.', 'Sign it again.'] },
  version1: { title: 'Only its bash blocks are signed.', points: ['It was signed before manifest version 2.', 'A team library takes runbooks signed as a whole: sign it again.'] },
  changed: { title: 'It changed since signing.', points: ['A team library takes it only as signed.', 'Sign it again (a new version).'] },
  expired: { title: 'Its signature has expired.', points: ['The library refuses expired runbooks.', 'Sign it again with a later expiry.'] },
};
const bullets = (points: readonly string[]): string => points.map((p) => `• ${p}`).join('\n');

/** The text, once it is signed as the library needs (after Sign Runbook if the user chooses it). */
async function signedText(target: vscode.Uri): Promise<{ text: string; check: Extract<PublishCheck, { ok: true }> } | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await saveIfOpen(target);
    const text = decoder.decode(await vscode.workspace.fs.readFile(target));
    const check = publishCheck(text);
    if (check.ok) return { text, check };
    if (attempt > 0) return undefined;
    const what = CHECK_TEXT[check.why];
    const sign = 'Sign Runbook';
    const choice = await vscode.window.showWarningMessage(`md-runbook: ${what.title}`, { modal: true, detail: bullets(what.points) }, sign);
    if (choice !== sign) return undefined;
    await vscode.commands.executeCommand('mdRunbook.signRunbook', target);
  }
  return undefined;
}

/** The path the runbook at `uri` was last published at, else its signed name as a file. */
function defaultPath(uri: vscode.Uri | undefined, name: string | undefined): string {
  const seen = uri ? ctx.globalState.get<Record<string, string>>(PUBLISHED_KEY, {})[uri.toString()] : undefined;
  return seen ?? (name ? `${name}.md` : '');
}

/** The signed name of the runbook at `uri`, if it has a readable signature. */
async function signedNameOf(uri: vscode.Uri | undefined): Promise<string | undefined> {
  if (!uri || uri.scheme !== 'file') return undefined;
  try {
    const block = readSignature(decoder.decode(await vscode.workspace.fs.readFile(uri)));
    return block ? parseManifest(block.manifest).name : undefined;
  } catch {
    return undefined;
  }
}

/** Send, and when the server refuses the stored token (401), ask for another once and send again. */
async function send(method: 'POST' | 'DELETE', server: string, where: string, text: string | undefined, title: string) {
  let token = await tokenFor(server, true);
  for (let attempt = 0; token && attempt < 2; attempt++) {
    const t = token;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () =>
      sendToLibrary({ method, server, path: where, token: t, ...(text !== undefined ? { text } : {}) }),
    );
    if (r.kind === 'answer' && r.status === 401 && attempt === 0) {
      token = await tokenFor(server, true, true);
      continue;
    }
    return r;
  }
  return undefined;
}

const refusedDetail = (a: LibraryAnswer): string => bullets([a.error ?? 'No reason given.', ...(a.problems ?? [])]);

async function publishToLibrary(uri?: unknown): Promise<void> {
  const target = targetUri(uri);
  if (!target || target.scheme !== 'file') return void vscode.window.showErrorMessage('md-runbook: open a runbook (a .md file) to publish.');
  const signed = await signedText(target);
  if (!signed) return;
  const { name } = signed.check.manifest;
  const server = await libraryServer(true);
  if (!server) return;
  const typed = await vscode.window.showInputBox({
    title: `md-runbook: publish ${name} version ${signed.check.manifest.version} to ${hostOf(server)}`,
    prompt: `Its path in the library. The signed name (${name}) must end it.`,
    value: defaultPath(target, name),
    ignoreFocusOut: true,
    validateInput: (v) => {
      const p = cleanLibraryPath(v);
      return libraryPathProblem(p) ?? (nameFitsPath(name, p) ? undefined : `The path must end with the signed name: ${name}.md`);
    },
  });
  if (typed === undefined) return;
  const where = cleanLibraryPath(typed);
  if (libraryPathProblem(where) || !nameFitsPath(name, where)) return;
  const r = await send('POST', server, where, signed.text, `md-runbook: publishing ${where} to ${hostOf(server)}`);
  if (!r) return;
  if (r.kind === 'unreachable') return void vscode.window.showErrorMessage(`md-runbook: ${hostOf(server)} did not answer: ${r.why}.`);
  if (r.status === 200 || r.status === 201) {
    await ctx.globalState.update(PUBLISHED_KEY, { ...ctx.globalState.get<Record<string, string>>(PUBLISHED_KEY, {}), [target.toString()]: where });
    await vscode.commands.executeCommand('mdRunbook.library.refresh').then(undefined, () => undefined);
    return void vscode.window.showInformationMessage(`md-runbook: ${publishedText(where, r.answer)}.`);
  }
  if (r.status === 401) return void vscode.window.showErrorMessage(`md-runbook: ${hostOf(server)} refused the upload token.`);
  void vscode.window.showErrorMessage(`md-runbook: ${hostOf(server)} refused ${where} (HTTP ${r.status}).`, { modal: true, detail: refusedDetail(r.answer) });
}

/** Remove from Library…: the runbook at a path (a Library view row's, or typed), after a confirm. */
async function removeFromLibrary(arg?: unknown): Promise<void> {
  const given = typeof arg === 'object' && arg !== null && typeof (arg as { libraryPath?: unknown }).libraryPath === 'string' ? (arg as { libraryPath: string }).libraryPath : undefined;
  const server = await libraryServer(true);
  if (!server) return;
  let where = given;
  if (where === undefined) {
    const current = targetUri(arg);
    const typed = await vscode.window.showInputBox({
      title: `md-runbook: remove a runbook from ${hostOf(server)}`,
      prompt: 'Its path in the library, e.g. ops/restart-api.md',
      value: defaultPath(current, await signedNameOf(current)),
      ignoreFocusOut: true,
      validateInput: (v) => libraryPathProblem(cleanLibraryPath(v)),
    });
    if (typed === undefined) return;
    where = cleanLibraryPath(typed);
    if (libraryPathProblem(where)) return;
  }
  const go = 'Remove';
  const sure = await vscode.window.showWarningMessage(
    `md-runbook: remove ${where} from the team library at ${hostOf(server)}?`,
    {
      modal: true,
      detail: bullets(['Nobody can open it from the library any more.', 'Copies people opened stay theirs.', 'Publishing there again needs a higher version.']),
    },
    go,
  );
  if (sure !== go) return;
  const r = await send('DELETE', server, where, undefined, `md-runbook: removing ${where} from ${hostOf(server)}`);
  if (!r) return;
  if (r.kind === 'unreachable') return void vscode.window.showErrorMessage(`md-runbook: ${hostOf(server)} did not answer: ${r.why}.`);
  if (r.status === 200) {
    await vscode.commands.executeCommand('mdRunbook.library.refresh').then(undefined, () => undefined);
    return void vscode.window.showInformationMessage(`md-runbook: removed ${where}${r.answer.version ? ` (version ${r.answer.version})` : ''} from the library.`);
  }
  if (r.status === 405) {
    return void vscode.window.showErrorMessage('md-runbook: this library server doesn’t allow removing runbooks.', {
      modal: true,
      detail: bullets(['Its admin can turn it on: LIBRARY_ALLOW_DELETE=true.', 'Or remove the file from the library folder by hand.']),
    });
  }
  void vscode.window.showErrorMessage(`md-runbook: ${removeRefusal(where, r.status, r.answer)}.`);
}

/** Library Upload Token…: set or replace the token for the library server, or forget it. */
async function manageToken(): Promise<void> {
  const server = await libraryServer(true);
  if (!server) return;
  const stored = await tokenFor(server, false);
  const set = { label: stored ? '$(key) Replace the Token…' : '$(key) Set the Token…', id: 'set' };
  const forget = { label: '$(trash) Forget the Token', id: 'forget' };
  const picked = await vscode.window.showQuickPick(stored ? [set, forget] : [set], {
    title: `md-runbook: upload token for ${hostOf(server)}`,
    placeHolder: stored ? 'A token is stored (VS Code’s secret storage)' : 'No token stored yet',
  });
  if (!picked) return;
  if (picked.id === 'forget') {
    await ctx.secrets.delete(TOKEN_KEY + originOf(server));
    return void vscode.window.showInformationMessage(`md-runbook: the upload token for ${hostOf(server)} is forgotten.`);
  }
  if (await tokenFor(server, true, true)) void vscode.window.showInformationMessage(`md-runbook: upload token for ${hostOf(server)} stored in VS Code’s secret storage.`);
}

export function registerLibraryPublish(context: vscode.ExtensionContext): void {
  ctx = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('mdRunbook.library.publish', publishToLibrary),
    vscode.commands.registerCommand('mdRunbook.library.remove', removeFromLibrary),
    vscode.commands.registerCommand('mdRunbook.library.uploadToken', manageToken),
  );
}

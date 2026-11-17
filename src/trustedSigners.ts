/**
 * Trusted Signers… (Share ▾, the Library view's ⋯): the signers you trust, as the app's Hosts &
 * settings → Trusted signers, in two groups:
 * - yours, in the allowed_signers file `mdRunbook.signing.allowedSigners` names: they count for
 *   every runbook. Added as an allowed_signers line or a public key, pasted or from a file. With
 *   no file set, adding one offers to make it in the extension's storage (after a yes) or to
 *   choose one;
 * - each team library's, trusted from its own allowed_signers (src/libraryTrust.ts): they count
 *   for that library's runbooks only. A key it no longer publishes is shown withdrawn; published
 *   again, it is offered with when it was withdrawn, not pre-picked.
 * List them with their fingerprints, remove one from the file it is in. Keys an earlier version
 * added to your file from the library are marked as also published by it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION } from './config';
import { PublicKeyLine, SignerLine, SkippedLine, lineForKey, parsePublicKey, parseSignerLine, readSigners, signerLineToAdd, signerNameOk, withoutSigner } from './allowedSigners';
import { alsoPublished, libraryAddressOf, librarySignerFiles, librarySignerOf, librarySignersFile, readLibrarySigners, shownLibrary, trustLibraryLines, withTrustedLines, type LibrarySigner } from './libraryTrust';
import type { LibraryTree } from './libraryView';

const home = (p: string): string => p.replace(/^~(?=$|[\\/])/, os.homedir());
const bullets = (points: readonly string[]): string => points.map((p) => `• ${p}`).join('\n');
const HEADER = '# Signers md-runbook trusts (OpenSSH allowed_signers): name namespaces="md-runbook" key-type key\n';

const hostOf = (base: string): string => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};

/** Your allowed_signers file as the settings name it, or undefined. */
function ownSetting(): string | undefined {
  const set = vscode.workspace.getConfiguration(SECTION).get<string>('signing.allowedSigners', '').trim();
  return set ? home(set) : undefined;
}

/** Your allowed_signers file; with none set, made or chosen after asking. */
async function signersFile(context: vscode.ExtensionContext): Promise<string | undefined> {
  const set = ownSetting();
  if (set) return set;
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const create = 'Create the File';
  const choose = 'Choose a File…';
  const answer = await vscode.window.showInformationMessage(
    'md-runbook: no trusted signers file is set. Make one?',
    {
      modal: true,
      detail: bullets([
        'An OpenSSH allowed_signers file, in VS Code’s storage for md-runbook.',
        'Sets mdRunbook.signing.allowedSigners to it.',
        'Or choose a file you have (your servers’ allowed_signers).',
      ]),
    },
    create,
    choose,
  );
  let file: string | undefined;
  if (answer === create) {
    file = path.join(context.globalStorageUri.fsPath, 'allowed_signers');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER, 'utf8');
  } else if (answer === choose) {
    const picked = await vscode.window.showOpenDialog({ title: 'md-runbook: your allowed_signers file', canSelectMany: false, openLabel: 'Trust These Signers', defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')) });
    file = picked?.[0]?.fsPath;
  }
  if (!file) return undefined;
  await cfg.update('signing.allowedSigners', file, vscode.ConfigurationTarget.Global);
  return file;
}

const readText = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/** The name a public key signs as: its comment when that is a signer's name, else asked. */
async function nameFor(k: PublicKeyLine): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title: `md-runbook: who signs with ${k.fingerprint}?`,
    prompt: 'The name in their signatures (Sign Runbook writes it), e.g. alice@example.net',
    value: k.comment && signerNameOk(k.comment) ? k.comment : '',
    ignoreFocusOut: true,
    validateInput: (v) => (signerNameOk(v.trim()) ? undefined : 'Letters, digits and @ . _ + - only (no spaces).'),
  });
  return name?.trim() || undefined;
}

type Lines = { lines: { line: string; label: string; fingerprint: string }[]; problems: string[] };

/** The lines to add for some text (pasted, or a file): allowed_signers lines as they are, public keys with a name. */
async function linesFrom(text: string): Promise<Lines | undefined> {
  const found: ({ kind: 'signer'; s: SignerLine } | { kind: 'key'; k: PublicKeyLine })[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const k = parsePublicKey(raw);
    if (k) return void found.push({ kind: 'key', k });
    const s = parseSignerLine(raw, n, { adding: true });
    if (!s) return;
    if ('problem' in s) problems.push(`Line ${n + 1}: ${s.problem}.`);
    else found.push({ kind: 'signer', s });
  });
  let chosen = found;
  if (found.length > 1) {
    const items = found.map((f) => ({
      label: f.kind === 'signer' ? f.s.principals.join(', ') : (f.k.comment ?? 'a public key'),
      description: f.kind === 'signer' ? f.s.fingerprint : f.k.fingerprint,
      picked: true,
      f,
    }));
    const picked = await vscode.window.showQuickPick(items, { title: 'md-runbook: which signers to trust?', canPickMany: true });
    if (!picked) return undefined;
    chosen = picked.map((p) => p.f);
  }
  const lines: Lines['lines'] = [];
  for (const f of chosen) {
    if (f.kind === 'signer') lines.push({ line: signerLineToAdd(f.s), label: f.s.principals.join(', '), fingerprint: f.s.fingerprint });
    else {
      const name = await nameFor(f.k);
      if (!name) return undefined;
      lines.push({ line: lineForKey(name, f.k), label: name, fingerprint: f.k.fingerprint });
    }
  }
  return { lines, problems };
}

/** Say what was added, and check the library again when something was. */
function tellAdded(got: Lines, added: readonly number[], already: number): void {
  if (added.length > 0) void vscode.commands.executeCommand('mdRunbook.library.refresh').then(undefined, () => undefined);
  const one = added.length === 1 ? got.lines[added[0]!] : undefined;
  const parts = [
    added.length === 0 ? 'No signer added.' : one ? `Trusted: ${one.label} (${one.fingerprint}).` : `${added.length} signers trusted.`,
    ...(already > 0 ? [already === 1 ? '1 was there already.' : `${already} were there already.`] : []),
    ...got.problems.slice(0, 3),
  ];
  const message = `md-runbook: ${parts.join(' ')}`;
  if (added.length === 0 && got.problems.length > 0) void vscode.window.showWarningMessage(message);
  else void vscode.window.showInformationMessage(message);
}

/** Add the lines to your file (not those it has already). */
function addLines(file: string, got: Lines): void {
  const r = withTrustedLines(readText(file), HEADER, got.lines.map((l) => l.line));
  if (r.added.length > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.text, 'utf8');
  }
  tellAdded(got, r.added, r.already);
}

async function addPasted(context: vscode.ExtensionContext): Promise<void> {
  const typed = await vscode.window.showInputBox({
    title: 'md-runbook: add a trusted signer',
    prompt: 'An allowed_signers line (as on the servers), or a public key (.pub)',
    placeHolder: 'ops@example.net namespaces="md-runbook" ssh-ed25519 AAAA…',
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (v.trim() === '' || parsePublicKey(v)) return undefined;
      const s = parseSignerLine(v, 0, { adding: true });
      return s && 'problem' in s ? s.problem : undefined;
    },
  });
  if (!typed?.trim()) return;
  const got = await linesFrom(typed);
  if (!got) return;
  const file = await signersFile(context);
  if (file) addLines(file, got);
}

async function addFromFile(context: vscode.ExtensionContext): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'md-runbook: an allowed_signers file or a public key (.pub)',
    canSelectMany: false,
    openLabel: 'Add Its Signers',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')),
  });
  const source = picked?.[0]?.fsPath;
  if (!source) return;
  let text: string;
  try {
    text = fs.readFileSync(source, 'utf8');
  } catch (e) {
    return void vscode.window.showErrorMessage(`md-runbook: ${e instanceof Error ? e.message : String(e)}`);
  }
  const got = await linesFrom(text);
  if (!got) return;
  const file = await signersFile(context);
  if (file) addLines(file, got);
}

/** The team library's own allowed_signers, after its fingerprints and what trusting them means: into the library's file. */
async function addFromLibrary(context: vscode.ExtensionContext, tree: LibraryTree): Promise<void> {
  const lib = tree.library();
  const address = lib ? libraryAddressOf(lib.base) : undefined;
  if (!lib?.allowedSigners || address === undefined) return void vscode.window.showInformationMessage('md-runbook: the team library publishes no allowed_signers file.');
  const { signers, skipped } = readSigners(lib.allowedSigners, { adding: true });
  if (signers.length === 0) return void vscode.window.showInformationMessage(`md-runbook: the team library's allowed_signers has no key md-runbook can use${skipped.length ? ` (${skipped.length} line${skipped.length === 1 ? '' : 's'} skipped)` : ''}.`);
  // A key trusted before and withdrawn since counts again only after this same yes (never by itself).
  const libText = readText(librarySignersFile(context.globalStorageUri.fsPath, address));
  const withdrawnOf = (s: SignerLine): LibrarySigner | undefined => {
    const x = librarySignerOf(libText, s);
    return x?.withdrawn ? x : undefined;
  };
  const picked = await vscode.window.showQuickPick(
    signers.map((s) => {
      const w = withdrawnOf(s);
      return {
        label: s.principals.join(', '),
        description: s.fingerprint,
        detail: [s.keyType, s.validBefore ? `valid before ${s.validBefore}` : '', w ? withdrawnText(w) : ''].filter(Boolean).join(' · '),
        picked: !w,
        s,
      };
    }),
    { title: `md-runbook: signers the team library at ${hostOf(lib.base)} publishes`, canPickMany: true, placeHolder: 'Compare the fingerprints with what the signers tell you' },
  );
  if (!picked || picked.length === 0) return;
  const go = 'Trust Them';
  const sure = await vscode.window.showWarningMessage(
    `md-runbook: trust ${picked.length === 1 ? 'this key' : `these ${picked.length} keys`} from ${hostOf(lib.base)}?`,
    {
      modal: true,
      detail: bullets([
        'The keys come from the same server as the runbooks: it vouches for itself.',
        'Trust them only if you trust that server. Better: compare the fingerprints with the signers.',
        `They count only for this library’s runbooks (${shownLibrary(address)}).`,
        ...picked.flatMap((p) => {
          const w = withdrawnOf(p.s);
          return w ? [`${p.s.principals.join(', ')} (${p.s.fingerprint}): ${withdrawnText(w)}.`] : [];
        }),
      ]),
    },
    go,
  );
  if (sure !== go) return;
  const got: Lines = { lines: picked.map((p) => ({ line: signerLineToAdd(p.s), label: p.s.principals.join(', '), fingerprint: p.s.fingerprint })), problems: [] };
  const r = trustLibraryLines(context.globalStorageUri.fsPath, address, got.lines.map((l) => l.line));
  tellAdded(got, r.added, r.already);
}

/** Take the signer's line out of the file it is in. */
async function removeSigner(file: string, s: SignerLine, points: readonly string[]): Promise<void> {
  const go = 'Remove';
  const sure = await vscode.window.showWarningMessage(`md-runbook: stop trusting ${s.principals.join(', ')}?`, { modal: true, detail: bullets([`Key ${s.fingerprint}.`, ...points]) }, go);
  if (sure !== go) return;
  const next = withoutSigner(readText(file), s);
  if (next === undefined) return void vscode.window.showWarningMessage('md-runbook: that line is no longer in the file (it changed meanwhile).');
  fs.writeFileSync(file, next, 'utf8');
  void vscode.commands.executeCommand('mdRunbook.library.refresh').then(undefined, () => undefined);
  void vscode.window.showInformationMessage(`md-runbook: ${s.principals.join(', ')} is no longer trusted.`);
}

/** Take a line md-runbook doesn't use out of your file (ssh-keygen may still read it its own way). */
async function removeLine(file: string, k: SkippedLine): Promise<void> {
  const go = 'Remove';
  const sure = await vscode.window.showWarningMessage(`md-runbook: remove line ${k.line + 1} from your allowed_signers?`, { modal: true, detail: bullets([k.problem, 'ssh-keygen may still trust a key on it.']) }, go);
  if (sure !== go) return;
  const next = withoutSigner(readText(file), k);
  if (next === undefined) return void vscode.window.showWarningMessage('md-runbook: that line is no longer in the file (it changed meanwhile).');
  fs.writeFileSync(file, next, 'utf8');
  void vscode.commands.executeCommand('mdRunbook.library.refresh').then(undefined, () => undefined);
}

/** When a key was withdrawn, in a few words. */
const withdrawnText = (w: LibrarySigner): string => (w.withdrawnOn ? `withdrawn on ${w.withdrawnOn}` : 'withdrawn');

type Item = vscode.QuickPickItem & { run?: () => Promise<void> };

const keyDetail = (s: SignerLine, extra: readonly string[] = []): string =>
  [s.keyType, s.namespaces ? `namespaces ${s.namespaces.join(',')}` : 'any namespace', s.validBefore ? `valid before ${s.validBefore}` : '', ...extra].filter(Boolean).join(' · ');

/** Your signers: they count for every runbook. */
function ownItems(file: string | undefined, libHost: string | undefined, published: string | undefined): Item[] {
  if (file === undefined) return [{ label: 'Yours: no file set yet (Add a Signer… makes one)', kind: vscode.QuickPickItemKind.Separator }];
  const { signers, skipped } = readSigners(readText(file));
  const also = alsoPublished(signers, published);
  return [
    { label: signers.length === 0 ? 'Yours: none yet' : 'Yours: count for every runbook (choose one to remove it)', kind: vscode.QuickPickItemKind.Separator },
    ...signers.map((s): Item => {
      const shared = also.has(s.line) && libHost !== undefined;
      return {
        label: `$(key) ${s.principals.join(', ')}`,
        description: s.fingerprint,
        detail: keyDetail(s, shared ? [`also published by ${libHost}`] : []),
        run: () =>
          removeSigner(file, s, [
            'Its runbooks no longer show as verified.',
            ...(shared ? [`${libHost} publishes it too: Add the Team Library’s Signers… trusts it for that library’s runbooks only.`] : []),
          ]),
      };
    }),
    ...(skipped.length > 0 ? [{ label: `${skipped.length} line${skipped.length === 1 ? '' : 's'} not used`, kind: vscode.QuickPickItemKind.Separator }, ...skipped.map((k): Item => ({ label: `$(circle-slash) Line ${k.line + 1}`, detail: `${k.problem} (choose it to remove it)`, run: () => removeLine(file, k) }))] : []),
  ];
}

/** Each library's signers, under its address: they count for its runbooks only. */
function libraryItems(storage: string): Item[] {
  const out: Item[] = [];
  for (const { address, file } of librarySignerFiles(storage)) {
    const { signers } = readLibrarySigners(readText(file));
    if (signers.length === 0) continue;
    const shown = shownLibrary(address);
    out.push({ label: `${shown}: its runbooks only`, kind: vscode.QuickPickItemKind.Separator });
    out.push(
      ...signers.map((s: LibrarySigner): Item => ({
        label: `${s.withdrawn ? '$(circle-slash)' : '$(key)'} ${s.principals.join(', ')}`,
        description: s.fingerprint,
        detail: keyDetail(s, s.withdrawn ? [`${withdrawnText(s)}: no longer counts`] : []),
        run: () =>
          removeSigner(file, s, s.withdrawn ? ['Withdrawn: it counts again only if you trust it again.'] : [`Its runbooks from ${shown} no longer show as verified.`]),
      })),
    );
  }
  return out;
}

async function trustedSigners(context: vscode.ExtensionContext, tree: LibraryTree | undefined): Promise<void> {
  const file = ownSetting();
  const lib = tree?.library();
  const libHost = lib ? hostOf(lib.base) : undefined;
  const items: Item[] = [
    { label: '$(add) Add a Signer…', detail: 'Paste an allowed_signers line or a public key: counts for every runbook', run: () => addPasted(context) },
    { label: '$(file) Add from a File…', detail: 'An allowed_signers file or a .pub file: counts for every runbook', run: () => addFromFile(context) },
    ...(tree && lib?.allowedSigners ? [{ label: '$(library) Add the Team Library’s Signers…', detail: `Its allowed_signers, at ${libHost}: for its runbooks only`, run: () => addFromLibrary(context, tree) }] : []),
    {
      label: '$(go-to-file) Open Your File',
      detail: file ?? 'None set yet',
      run: async () => {
        const f = await signersFile(context);
        if (f) await vscode.window.showTextDocument(vscode.Uri.file(f));
      },
    },
    ...ownItems(file, libHost, lib?.allowedSigners),
    ...libraryItems(context.globalStorageUri.fsPath),
  ];
  const picked = await vscode.window.showQuickPick(items, { title: 'md-runbook: trusted signers', matchOnDescription: true, matchOnDetail: true });
  await picked?.run?.();
}

export function registerTrustedSigners(context: vscode.ExtensionContext, tree: LibraryTree | undefined): void {
  context.subscriptions.push(vscode.commands.registerCommand('mdRunbook.trustedSigners', () => trustedSigners(context, tree)));
}

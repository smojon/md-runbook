/**
 * Trusted Signers… (Share ▾, the Library view's ⋯): the signers in the allowed_signers file that
 * `mdRunbook.signing.allowedSigners` names, as the app's Hosts & settings → Trusted signers. List
 * them with their fingerprints, add one (an allowed_signers line or a public key, pasted or from a
 * file, or the team library's own), remove one. With no file set, it offers to make one in the
 * extension's storage (after a yes) or to choose one. The Library view and run reports check
 * signatures against this file (ssh-keygen -Y verify, namespace md-runbook).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION } from './config';
import { PublicKeyLine, SignerLine, hasSigner, lineForKey, parsePublicKey, parseSignerLine, readSigners, signerLineToAdd, signerNameOk, withLine, withoutSigner } from './allowedSigners';
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

/** The allowed_signers file of the settings; with none set, made or chosen after asking. */
async function signersFile(context: vscode.ExtensionContext): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const set = cfg.get<string>('signing.allowedSigners', '').trim();
  if (set) return home(set);
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

/** The lines to add for some text (pasted, or a file): allowed_signers lines as they are, public keys with a name. */
async function linesFrom(text: string): Promise<{ lines: { line: string; label: string; fingerprint: string }[]; problems: string[] } | undefined> {
  const found: ({ kind: 'signer'; s: SignerLine } | { kind: 'key'; k: PublicKeyLine })[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const k = parsePublicKey(raw);
    if (k) return void found.push({ kind: 'key', k });
    const s = parseSignerLine(raw, n);
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
  const lines: { line: string; label: string; fingerprint: string }[] = [];
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

/** Add the lines to the file (not those it has already), say what changed, and check the library again. */
async function addLines(file: string, got: { lines: { line: string; label: string; fingerprint: string }[]; problems: string[] }): Promise<void> {
  let text = readText(file);
  const added: string[] = [];
  let already = 0;
  for (const l of got.lines) {
    const s = parseSignerLine(l.line);
    if (!s || 'problem' in s) continue;
    if (hasSigner(text, s)) {
      already++;
      continue;
    }
    text = withLine(text || HEADER, l.line);
    added.push(`${l.label} (${l.fingerprint})`);
  }
  if (added.length > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    void vscode.commands.executeCommand('mdRunbook.library.refresh').then(undefined, () => undefined);
  }
  const parts = [
    added.length === 0 ? 'No signer added.' : added.length === 1 ? `Trusted: ${added[0]}.` : `${added.length} signers trusted.`,
    ...(already > 0 ? [already === 1 ? '1 was there already.' : `${already} were there already.`] : []),
    ...got.problems.slice(0, 3),
  ];
  const message = `md-runbook: ${parts.join(' ')}`;
  if (added.length === 0 && got.problems.length > 0) void vscode.window.showWarningMessage(message);
  else void vscode.window.showInformationMessage(message);
}

async function addPasted(file: string): Promise<void> {
  const typed = await vscode.window.showInputBox({
    title: 'md-runbook: add a trusted signer',
    prompt: 'An allowed_signers line (as on the servers), or a public key (.pub)',
    placeHolder: 'ops@example.net namespaces="md-runbook" ssh-ed25519 AAAA…',
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (v.trim() === '' || parsePublicKey(v)) return undefined;
      const s = parseSignerLine(v);
      return s && 'problem' in s ? s.problem : undefined;
    },
  });
  if (!typed?.trim()) return;
  const got = await linesFrom(typed);
  if (got) await addLines(file, got);
}

async function addFromFile(file: string): Promise<void> {
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
  if (got) await addLines(file, got);
}

/** The team library's own allowed_signers, after its fingerprints and what trusting them means. */
async function addFromLibrary(file: string, tree: LibraryTree): Promise<void> {
  const lib = tree.library();
  if (!lib?.allowedSigners) return void vscode.window.showInformationMessage('md-runbook: the team library publishes no allowed_signers file.');
  const { signers, skipped } = readSigners(lib.allowedSigners);
  if (signers.length === 0) return void vscode.window.showInformationMessage(`md-runbook: the team library's allowed_signers has no key md-runbook can use${skipped.length ? ` (${skipped.length} line${skipped.length === 1 ? '' : 's'} skipped)` : ''}.`);
  const picked = await vscode.window.showQuickPick(
    signers.map((s) => ({ label: s.principals.join(', '), description: s.fingerprint, detail: [s.keyType, s.validBefore ? `valid before ${s.validBefore}` : ''].filter(Boolean).join(' · '), picked: true, s })),
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
        'Here they count for every runbook, not only the library’s.',
      ]),
    },
    go,
  );
  if (sure !== go) return;
  await addLines(file, { lines: picked.map((p) => ({ line: signerLineToAdd(p.s), label: p.s.principals.join(', '), fingerprint: p.s.fingerprint })), problems: [] });
}

async function removeSigner(file: string, s: SignerLine): Promise<void> {
  const go = 'Remove';
  const sure = await vscode.window.showWarningMessage(
    `md-runbook: stop trusting ${s.principals.join(', ')}?`,
    { modal: true, detail: bullets([`Key ${s.fingerprint}.`, 'Its runbooks no longer show as verified.']) },
    go,
  );
  if (sure !== go) return;
  const next = withoutSigner(readText(file), s);
  if (next === undefined) return void vscode.window.showWarningMessage('md-runbook: that line is no longer in the file (it changed meanwhile).');
  fs.writeFileSync(file, next, 'utf8');
  void vscode.commands.executeCommand('mdRunbook.library.refresh').then(undefined, () => undefined);
  void vscode.window.showInformationMessage(`md-runbook: ${s.principals.join(', ')} is no longer trusted.`);
}

type Item = vscode.QuickPickItem & { run?: () => Promise<void> };

async function trustedSigners(context: vscode.ExtensionContext, tree: LibraryTree | undefined): Promise<void> {
  const file = await signersFile(context);
  if (!file) return;
  const { signers, skipped } = readSigners(readText(file));
  const items: Item[] = [
    { label: '$(add) Add a Signer…', detail: 'Paste an allowed_signers line or a public key', run: () => addPasted(file) },
    { label: '$(file) Add from a File…', detail: 'An allowed_signers file or a .pub file', run: () => addFromFile(file) },
    ...(tree?.library()?.allowedSigners ? [{ label: '$(library) Add the Team Library’s Signers…', detail: `Its allowed_signers, at ${hostOf(tree.library()!.base)}`, run: () => addFromLibrary(file, tree) }] : []),
    { label: '$(go-to-file) Open the File', detail: file, run: async () => void (await vscode.window.showTextDocument(vscode.Uri.file(file))) },
    { label: signers.length === 0 ? 'No signers yet: signatures show, but none is verified.' : 'Trusted signers (choose one to remove it)', kind: vscode.QuickPickItemKind.Separator },
    ...signers.map((s): Item => ({
      label: `$(key) ${s.principals.join(', ')}`,
      description: s.fingerprint,
      detail: [s.keyType, s.namespaces ? `namespaces ${s.namespaces.join(',')}` : 'any namespace', s.validBefore ? `valid before ${s.validBefore}` : ''].filter(Boolean).join(' · '),
      run: () => removeSigner(file, s),
    })),
    ...(skipped.length > 0 ? [{ label: `${skipped.length} line${skipped.length === 1 ? '' : 's'} not used`, kind: vscode.QuickPickItemKind.Separator }, ...skipped.map((k): Item => ({ label: `$(circle-slash) Line ${k.line + 1}`, detail: k.problem }))] : []),
  ];
  const picked = await vscode.window.showQuickPick(items, { title: `md-runbook: trusted signers (${path.basename(file)})`, matchOnDescription: true, matchOnDetail: true });
  await picked?.run?.();
}

export function registerTrustedSigners(context: vscode.ExtensionContext, tree: LibraryTree | undefined): void {
  context.subscriptions.push(vscode.commands.registerCommand('mdRunbook.trustedSigners', () => trustedSigners(context, tree)));
}

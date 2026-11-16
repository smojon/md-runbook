/**
 * The Library view (Runbook activity bar, under Steps): the team library at `mdRunbook.library.url`,
 * as the app's Team runbooks show it. Its runbooks by folder, each with what its signature is
 * worth against your trusted signers (`mdRunbook.signing.allowedSigners`, ssh-keygen). Opening one
 * makes your own copy (global storage, one per library file and text, as links do): the shared
 * file is never changed. A library whose index.json asks for signedOnly opens verified ones only.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION } from './config';
import { CANT_CHECK, Library, LibraryEntry, LibraryRead, Verdict, groupEntries, libraryBaseOf, libraryUrlProblem, libraryVerdict, readLibrary, verdictLabel } from './libraryRead';
import { NOTEBOOK_TYPE } from './serializer';
import { SignerCache } from './signerCheck';

/** globalState: per library, the highest version verified of each path under its signed name. */
const VERSIONS_KEY = 'mdRunbook.library.versions';

type Node =
  | { kind: 'folder'; folder: string; entries: LibraryEntry[] }
  | { kind: 'entry'; entry: LibraryEntry; libraryPath: string }
  | { kind: 'message'; text: string; icon: string; tooltip?: string };

const home = (p: string): string => p.replace(/^~(?=$|[\\/])/, os.homedir());
const hostOf = (base: string): string => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};
const bullets = (points: readonly string[]): string => points.map((p) => `• ${p}`).join('\n');

const ICONS: Record<Verdict['kind'], [string, string?]> = {
  verified: ['verified-filled', 'testing.iconPassed'],
  untrusted: ['unverified'],
  'cant-check': ['warning', 'list.warningForeground'],
  unsigned: ['file'],
  damaged: ['warning', 'list.warningForeground'],
  partial: ['warning', 'list.warningForeground'],
  changed: ['warning', 'list.warningForeground'],
  expired: ['warning', 'list.warningForeground'],
  'other-name': ['warning', 'list.warningForeground'],
  older: ['warning', 'list.warningForeground'],
};

export class LibraryTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private state: { base?: string; status: 'idle' | 'loading' | 'done'; read?: LibraryRead } = { status: 'idle' };
  private verdicts = new Map<string, Verdict>();
  /** ssh-keygen's answer per allowed_signers file (as it is now) and text. */
  private readonly trust = new SignerCache();
  private loading: Promise<void> | undefined;
  /** Each read's number: a read overtaken by a newer one (a refresh) is dropped. */
  private generation = 0;
  view?: vscode.TreeView<Node>;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
  }

  base(): string | undefined {
    return libraryBaseOf(this.config().get<string>('library.url', ''));
  }

  library(): Library | undefined {
    return this.state.read?.kind === 'ok' ? this.state.read.library : undefined;
  }

  verdictOf(e: LibraryEntry): Verdict | undefined {
    return this.verdicts.get(e.path);
  }

  /** Read the library again (the refresh button, a changed setting, a publish). */
  refresh(clearTrust = false): Promise<void> {
    if (clearTrust) this.trust.clear();
    this.state = { status: 'idle' };
    this.changed.fire(undefined);
    return this.load();
  }

  /** The read going on, or a new one when none was made yet. */
  load(): Promise<void> {
    if (this.state.status !== 'idle') return this.loading ?? Promise.resolve();
    const base = this.base();
    const generation = ++this.generation;
    this.state = { status: 'loading', ...(base ? { base } : {}) };
    this.updateMessage();
    this.loading = (async () => {
      const read: LibraryRead | undefined = base ? await readLibrary(base) : undefined;
      if (generation !== this.generation) return;
      const verdicts = read?.kind === 'ok' ? await this.check(read.library) : new Map<string, Verdict>();
      if (generation !== this.generation) return;
      this.verdicts = verdicts;
      this.state = { status: 'done', ...(base ? { base } : {}), ...(read ? { read } : {}) };
      this.updateMessage();
      this.changed.fire(undefined);
    })();
    return this.loading;
  }

  /** Each runbook's verdict, against the allowed_signers file of the settings (a few ssh-keygen at a time). */
  private async check(lib: Library): Promise<Map<string, Verdict>> {
    const file = home(this.config().get<string>('signing.allowedSigners', '').trim());
    const floors = this.context.globalState.get<Record<string, Record<string, number>>>(VERSIONS_KEY, {});
    const mine = { ...(floors[lib.base] ?? {}) };
    const verdicts = new Map<string, Verdict>();
    const todo = lib.entries.filter((e) => e.text !== undefined);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const e = todo[next++]!;
        const text = e.text!;
        let trusted: string | typeof CANT_CHECK | undefined;
        if (file && /md-runbook:signature v1/.test(text)) {
          const got = await this.trust.signer(text, file);
          trusted = got.cantCheck ? CANT_CHECK : got.signer;
        }
        const first = libraryVerdict(e.path, text, trusted, undefined);
        const seen = 'name' in first ? mine[`${e.path}\n${first.name}`] : undefined;
        verdicts.set(e.path, libraryVerdict(e.path, text, trusted, seen));
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker));
    let raised = false;
    for (const [p, v] of verdicts) {
      if (v.kind !== 'verified') continue;
      const k = `${p}\n${v.name}`;
      if ((mine[k] ?? 0) < v.version) {
        mine[k] = v.version;
        raised = true;
      }
    }
    if (raised) await this.context.globalState.update(VERSIONS_KEY, { ...floors, [lib.base]: mine });
    return verdicts;
  }

  private updateMessage(): void {
    if (!this.view) return;
    const base = this.state.base;
    this.view.description = base ? hostOf(base) : undefined;
    const lib = this.library();
    this.view.message =
      this.state.status === 'loading'
        ? 'Loading team runbooks…'
        : this.state.read?.kind === 'error'
          ? `Team runbooks could not be loaded: ${this.state.read.message}`
          : this.state.read?.kind === 'none'
            ? 'No library at this address (nothing listed there).'
            : lib && lib.entries.length === 0
              ? 'The team library has no runbooks yet.'
              : lib?.signedOnly
                ? 'This library opens verified runbooks only.'
                : undefined;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'folder') {
      const item = new vscode.TreeItem(n.folder, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('folder');
      item.contextValue = 'libraryFolder';
      return item;
    }
    if (n.kind === 'message') {
      const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(n.icon);
      if (n.tooltip) item.tooltip = n.tooltip;
      return item;
    }
    const e = n.entry;
    const item = new vscode.TreeItem(e.title, vscode.TreeItemCollapsibleState.None);
    item.id = `library:${e.path}`;
    item.contextValue = 'libraryRunbook';
    const v = this.verdicts.get(e.path);
    if (e.error !== undefined) {
      item.description = e.error;
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
    } else if (v) {
      item.description = verdictLabel(v);
      const [icon, color] = ICONS[v.kind];
      item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    }
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${escapeMd(e.title)}**\n\n`);
    tip.appendMarkdown(`- \`${e.path}\`\n`);
    tip.appendMarkdown(`- ${escapeMd(e.error ?? (v ? verdictLabel(v) : 'checking…'))}\n`);
    if (v && v.kind === 'untrusted') tip.appendMarkdown('- Trusted Signers… adds the keys you trust.\n');
    item.tooltip = tip;
    item.command = { command: 'mdRunbook.library.open', title: 'Open from Library', arguments: [n] };
    return item;
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (n?.kind === 'folder') return n.entries.map((entry) => ({ kind: 'entry', entry, libraryPath: entry.path }));
    if (n) return [];
    if (!this.base()) {
      const set = this.config().get<string>('library.url', '').trim();
      // No address: the welcome text (package.json viewsWelcome). One that can't be used: why.
      return set ? [{ kind: 'message', text: libraryUrlProblem(set) ?? 'Not a library address.', icon: 'error' }] : [];
    }
    if (this.state.status === 'idle') void this.load();
    const lib = this.library();
    if (!lib) return [];
    const groups = groupEntries(lib.entries);
    const out: Node[] = [];
    for (const g of groups) {
      if (g.folder === '') out.push(...g.entries.map((entry): Node => ({ kind: 'entry', entry, libraryPath: entry.path })));
      else out.push({ kind: 'folder', folder: g.folder, entries: g.entries });
    }
    return out;
  }
}

const escapeMd = (s: string): string => s.replace(/[\\`*_{}[\]()#+!|<>]/g, '\\$&');

/** Your copy of a library runbook: one per library file and text, so opening it again opens the copy with its runs. */
function libraryCopy(storage: vscode.Uri, base: string, entry: LibraryEntry & { text: string }): vscode.Uri {
  const key = createHash('sha256').update(base).update('\0').update(entry.path).update('\0').update(entry.text).digest('hex').slice(0, 16);
  const dir = path.join(storage.fsPath, 'library', key);
  const file = path.join(dir, entry.fileName.replace(/[\\/:*?"<>|]/g, '-'));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, entry.text, 'utf8');
  }
  return vscode.Uri.file(file);
}

/** Why a verdict keeps a signedOnly library's runbook closed, for the modal's points. */
const refusalPoints = (v: Verdict | undefined): string[] => [
  v ? `This one: ${verdictLabel(v)}.` : 'Its signature could not be checked.',
  ...(v?.kind === 'untrusted' ? ['Trusted Signers… adds the signers you trust.'] : []),
];

async function openFromLibrary(tree: LibraryTree, context: vscode.ExtensionContext, arg?: unknown): Promise<void> {
  const base = tree.base();
  if (!base) {
    const set = 'Set Library Address…';
    if ((await vscode.window.showInformationMessage('md-runbook: no team library is set.', set)) === set) await vscode.commands.executeCommand('mdRunbook.library.setUrl');
    return;
  }
  let entry = typeof arg === 'object' && arg !== null && (arg as Node).kind === 'entry' ? (arg as Extract<Node, { kind: 'entry' }>).entry : undefined;
  if (!entry) {
    await vscode.window.withProgress({ location: { viewId: 'mdRunbook.library' } }, () => tree.load());
    const lib = tree.library();
    if (!lib) return void vscode.window.showErrorMessage(`md-runbook: the team library at ${hostOf(base)} could not be read.`);
    const picked = await vscode.window.showQuickPick(
      lib.entries.map((e) => {
        const v = tree.verdictOf(e);
        return { label: e.title, description: e.path, detail: e.error ?? (v ? verdictLabel(v) : ''), entry: e };
      }),
      { title: `md-runbook: open from the team library at ${hostOf(base)}`, matchOnDescription: true },
    );
    if (!picked) return;
    entry = picked.entry;
  }
  if (entry.text === undefined) return void vscode.window.showErrorMessage(`md-runbook: ${entry.path} could not be read from the library: ${entry.error ?? 'no text'}.`);
  const lib = tree.library();
  const v = tree.verdictOf(entry);
  if (lib?.signedOnly && v?.kind !== 'verified') {
    const trust = 'Trusted Signers…';
    const choice = await vscode.window.showWarningMessage('md-runbook: this library opens verified runbooks only.', { modal: true, detail: bullets(refusalPoints(v)) }, trust);
    if (choice === trust) await vscode.commands.executeCommand('mdRunbook.trustedSigners');
    return;
  }
  const target = libraryCopy(context.globalStorageUri, base, { ...entry, text: entry.text });
  await vscode.commands.executeCommand('vscode.openWith', target, NOTEBOOK_TYPE);
  const what = v ? verdictLabel(v) : 'not checked';
  if (v?.kind === 'verified') void vscode.window.showInformationMessage(`md-runbook: opened your copy of ${entry.path} (${what}). Nothing runs until you run it.`);
  else void vscode.window.showWarningMessage(`md-runbook: opened your copy of ${entry.path} (${what}). Read it before you run it.`);
}

async function setLibraryUrl(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const typed = await vscode.window.showInputBox({
    title: 'md-runbook: team library address',
    prompt: 'The https address of the library folder. Empty: no library.',
    placeHolder: 'https://runbooks.example.net/runbooks/',
    value: cfg.get<string>('library.url', ''),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() === '' ? undefined : libraryUrlProblem(v)),
  });
  if (typed === undefined) return;
  const value = typed.trim() === '' ? '' : libraryBaseOf(typed);
  if (value === undefined) return;
  await cfg.update('library.url', value === '' ? undefined : value, vscode.ConfigurationTarget.Global);
}

export function registerLibraryView(context: vscode.ExtensionContext, testMode = false): LibraryTree {
  const tree = new LibraryTree(context);
  const view = vscode.window.createTreeView('mdRunbook.library', { treeDataProvider: tree, showCollapseAll: true });
  tree.view = view;
  context.subscriptions.push(
    view,
    vscode.commands.registerCommand('mdRunbook.library.refresh', () => vscode.window.withProgress({ location: { viewId: 'mdRunbook.library' } }, () => tree.refresh(true))),
    vscode.commands.registerCommand('mdRunbook.library.open', (arg?: unknown) => openFromLibrary(tree, context, arg)),
    vscode.commands.registerCommand('mdRunbook.library.setUrl', setLibraryUrl),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.library.url`) || e.affectsConfiguration(`${SECTION}.signing.allowedSigners`)) void tree.refresh(true);
    }),
  );
  // For tests: the library as read, and its rows to open (as a click passes them).
  if (testMode) {
    context.subscriptions.push(
      vscode.commands.registerCommand('mdRunbook._test.library', async () => {
        await tree.load();
        const lib = tree.library();
        return lib ? { signedOnly: lib.signedOnly, rows: lib.entries.map((entry) => ({ node: { kind: 'entry', entry, libraryPath: entry.path }, verdict: tree.verdictOf(entry) })) } : undefined;
      }),
    );
  }
  return tree;
}

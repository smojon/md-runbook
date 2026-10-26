/**
 * md-runbook: Sign Runbook: what `md-runbook sign` does, from the editor. The runbook is saved,
 * signed with ssh-keygen and written back with its signature block; servers that run
 * md-runbook-gate then run its bash blocks for restricted keys (docs/features/signed-runbooks.md).
 * Blocks changed since signing show up as lint warnings (core lint).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatLocalIso, parse, shellKindForLanguage } from '@md-runbook/core';
import { recordDigest, recordSigners, recordStatement, recordStatus, withRecordCosigner, withRecordSignature } from '@md-runbook/core/record';
import { findRefs } from '@md-runbook/core/secrets';
import { checkSignedSteps, keyComment, manifestHash, nodeShellEnv, resolveShell, sshSign } from '@md-runbook/core/node';
import { executionConfig } from './config';
import {
  ManifestMeta,
  RUNBOOK_NAME_RE,
  SCOPE_RE,
  buildManifest,
  cosignable,
  formatManifest,
  parseManifest,
  readSignature,
  signerLabel,
  signerNames,
  withSignature,
} from '@md-runbook/core/signing';
import { NOTEBOOK_TYPE } from './serializer';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();

function targetUri(uri: unknown): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri) return uri;
  return vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
}

/** Save the runbook if it is open with changes: what gets signed is the file. */
async function saveIfOpen(uri: vscode.Uri): Promise<void> {
  const nb = vscode.workspace.notebookDocuments.find((d) => d.notebookType === NOTEBOOK_TYPE && d.uri.toString() === uri.toString());
  if (nb?.isDirty) await nb.save();
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc?.isDirty) await doc.save();
}

async function pickKey(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('mdRunbook').get<string>('signing.key', '').trim();
  if (configured) return configured.replace(/^~(?=$|[\\/])/, os.homedir());
  const picked = await vscode.window.showOpenDialog({
    title: 'md-runbook: the SSH key to sign with (a key file, or a .pub whose key is in the SSH agent)',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')),
    canSelectMany: false,
    openLabel: 'Sign with this key',
  });
  return picked?.[0]?.fsPath;
}

async function signRunbook(uri?: unknown): Promise<void> {
  const target = targetUri(uri);
  if (!target || target.scheme !== 'file') return void vscode.window.showErrorMessage('md-runbook: open a runbook (a .md file) to sign.');
  await saveIfOpen(target);
  const text = decoder.decode(await vscode.workspace.fs.readFile(target));
  const prevBlock = readSignature(text);
  let prev: ReturnType<typeof parseManifest> | undefined;
  try {
    prev = prevBlock ? parseManifest(prevBlock.manifest) : undefined;
  } catch {
    prev = undefined;
  }

  // First signing: the name and where it may run. Later ones keep them and count the version up.
  let name = prev?.name;
  let scopes = prev?.scopes;
  if (!prev) {
    name = await vscode.window.showInputBox({
      title: 'md-runbook: runbook name',
      prompt: 'Shown in server logs and to support teams, e.g. ops/restart-api',
      value: path.basename(target.fsPath).replace(/(\.runbook)?\.md$/i, ''),
      validateInput: (v) => (RUNBOOK_NAME_RE.test(v) ? undefined : 'Letters, digits and . _ / - (at most 100)'),
    });
    if (name === undefined) return;
    const s = await vscode.window.showInputBox({
      title: 'md-runbook: scopes (optional)',
      prompt: 'Where it may run, space-separated (servers and keys accept scopes). Empty: only servers that accept any scope.',
      validateInput: (v) => (v.trim() === '' || v.trim().split(/\s+/).every((x) => SCOPE_RE.test(x)) ? undefined : 'Letters, digits and . _ - per scope'),
    });
    if (s === undefined) return;
    scopes = s.trim() === '' ? [] : s.trim().split(/\s+/);
  }
  const days = await vscode.window.showInputBox({
    title: 'md-runbook: valid for how many days? (optional)',
    prompt: 'Servers refuse it after that. Empty: no expiry (withdraw it through the servers’ revoked list).',
    validateInput: (v) => (v.trim() === '' || /^\d+$/.test(v.trim()) ? undefined : 'A number of days'),
  });
  if (days === undefined) return;

  // A pattern for each ${param:NAME}, ${input:NAME} and ${out:NAME} that has none yet (secrets
  // can't be signed; buildManifest says so).
  const patterns = { ...(prev?.patterns ?? {}) };
  const names = new Map<string, string>();
  for (const cell of parse(text).cells) {
    if (cell.kind !== 'code' || shellKindForLanguage(cell.languageId) !== 'bash') continue;
    try {
      for (const r of findRefs(cell.value)) if (r.kind !== 'secret' && !r.secret && !names.has(r.name)) names.set(r.name, r.kind);
    } catch {
      // reported by buildManifest
    }
  }
  for (const [p, kind] of names) {
    if (patterns[p] !== undefined) continue;
    const re = await vscode.window.showInputBox({
      title: `md-runbook: what may \${${kind}:${p}} be?`,
      prompt: 'A POSIX extended regular expression the whole value must match, e.g. [a-z0-9-]{1,32}',
      validateInput: (v) => (v.trim() === '' ? 'A pattern is needed: servers check the value against it' : undefined),
    });
    if (re === undefined) return;
    patterns[p] = re.trim();
  }

  const meta: ManifestMeta = {
    name: name!,
    version: prev ? prev.version + 1 : 1,
    ...(days.trim() !== '' ? { expires: new Date(Date.now() + Number(days) * 86_400_000).toISOString().slice(0, 10) } : {}),
    scopes: scopes ?? [],
    patterns,
  };
  const built = buildManifest(text, meta);
  if ('errors' in built) {
    return void vscode.window.showErrorMessage(`md-runbook: can't sign this runbook: ${built.errors.slice(0, 3).join('; ')}${built.errors.length > 3 ? ' …' : ''}`, { modal: true });
  }
  const bash = resolveShell('bash', executionConfig().shell, nodeShellEnv());
  const stepProblems = bash.ok ? await checkSignedSteps(built.manifest, bash.shell.command) : undefined;
  if (stepProblems?.length) {
    return void vscode.window.showErrorMessage(
      `md-runbook: can't sign this runbook: servers run a cell's commands one by one, and bash doesn't read these on their own: ${stepProblems.slice(0, 3).join('; ')}`,
      { modal: true },
    );
  }
  const key = await pickKey();
  if (!key) return;
  const manifest = formatManifest(built.manifest);
  let signature: string;
  try {
    signature = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'md-runbook: signing (touch your security key if it blinks)' },
      () => sshSign(manifest, key, { interactive: false }),
    );
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return void vscode.window.showErrorMessage(
      `md-runbook: ${why}. A key with a passphrase signs through the SSH agent: add it (ssh-add) and choose its .pub file.`,
    );
  }
  const signer = keyComment(key) ?? prevBlock?.signer ?? os.userInfo().username;
  const signed = withSignature(text, { signer, signed: new Date().toISOString().slice(0, 10), manifest, signature });
  await vscode.workspace.fs.writeFile(target, encoder.encode(signed));
  const hash = manifestHash(manifest);
  const m = built.manifest;
  const choice = await vscode.window.showInformationMessage(
    `md-runbook: ${m.name} version ${m.version} signed by ${signer} (${m.cells.length} block${m.cells.length === 1 ? '' : 's'}${m.expires ? `, until ${m.expires}` : ''}).`,
    'Copy Manifest Hash',
  );
  if (choice) await vscode.env.clipboard.writeText(hash);
}

/**
 * Co-sign Runbook: a second signer (a reviewer) signs the manifest as it is, for servers that
 * need two signers (`signers = 2` in gate.conf). Refused when the runbook changed since signing.
 */
async function cosignRunbook(uri?: unknown): Promise<void> {
  const target = targetUri(uri);
  if (!target || target.scheme !== 'file') return void vscode.window.showErrorMessage('md-runbook: open a signed runbook (a .md file) to co-sign.');
  await saveIfOpen(target);
  const text = decoder.decode(await vscode.workspace.fs.readFile(target));
  const block = readSignature(text);
  if (!block) return void vscode.window.showErrorMessage('md-runbook: this runbook is not signed yet. Sign it first (Sign Runbook); a second signer then co-signs it.');
  if (!cosignable(text, block)) {
    return void vscode.window.showErrorMessage(
      `md-runbook: the runbook changed since ${block.signer} signed it, so its signature no longer covers it. Sign it again (a new version), then co-sign that.`,
      { modal: true },
    );
  }
  const m = parseManifest(block.manifest);
  const go = await vscode.window.showInformationMessage(
    `md-runbook: co-sign ${m.name} version ${m.version}, signed by ${signerNames(block).join(', ')}? Your signature says you reviewed these ${m.cells.length} block${m.cells.length === 1 ? '' : 's'}.`,
    { modal: true },
    'Co-sign',
  );
  if (go !== 'Co-sign') return;
  const key = await pickKey();
  if (!key) return;
  let signature: string;
  try {
    signature = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'md-runbook: co-signing (touch your security key if it blinks)' },
      () => sshSign(block.manifest, key, { interactive: false }),
    );
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return void vscode.window.showErrorMessage(`md-runbook: ${why}. A key with a passphrase signs through the SSH agent: add it (ssh-add) and choose its .pub file.`);
  }
  const signer = keyComment(key) ?? os.userInfo().username;
  const cosigners = [...(block.cosigners ?? []).filter((c) => c.signer !== signerLabel(signer)), { signer, signed: new Date().toISOString().slice(0, 10), signature }];
  const next = { ...block, cosigners };
  await vscode.workspace.fs.writeFile(target, encoder.encode(withSignature(text, next)));
  void vscode.window.showInformationMessage(`md-runbook: ${m.name} version ${m.version} is signed by ${signerNames(next).join(', ')}.`);
}

/**
 * Sign Run Record (core/record.ts): vouch for a run record (an incident, a drill) as it is now, so
 * a report or an audit can tell it wasn't changed afterwards. When the record is signed and
 * unchanged, this co-signs it (an incident or drill lead); when it changed, signing again replaces
 * the earlier signatures.
 */
async function signRecord(uri?: unknown): Promise<void> {
  const target = targetUri(uri);
  if (!target || target.scheme !== 'file') return void vscode.window.showErrorMessage('md-runbook: open a run record (a .md file) to sign.');
  await saveIfOpen(target);
  const text = decoder.decode(await vscode.workspace.fs.readFile(target));
  const status = recordStatus(text);
  const cosign = status?.unchanged === true;
  const question = !status
    ? 'md-runbook: sign this run record? Your signature says it is the record as it happened (outputs, notes and earlier attempts); any later change shows in its report.'
    : cosign
      ? `md-runbook: co-sign this run record, signed by ${recordSigners(status.block).join(', ')}? Your signature says you reviewed it as it is.`
      : `md-runbook: this record changed since ${recordSigners(status.block).join(', ')} signed it. Sign it again? That replaces the earlier signatures.`;
  const go = await vscode.window.showInformationMessage(question, { modal: true }, cosign ? 'Co-sign' : 'Sign');
  if (!go) return;
  const key = await pickKey();
  if (!key) return;
  const sha256 = recordDigest(text);
  let signature: string;
  try {
    signature = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'md-runbook: signing the run record (touch your security key if it blinks)' },
      () => sshSign(recordStatement(sha256), key, { interactive: false }),
    );
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return void vscode.window.showErrorMessage(`md-runbook: ${why}. A key with a passphrase signs through the SSH agent: add it (ssh-add) and choose its .pub file.`);
  }
  const signer = keyComment(key) ?? os.userInfo().username;
  const signed = formatLocalIso(new Date());
  const block = cosign && status ? withRecordCosigner(status.block, { signer, signed, signature }) : { signer, signed, sha256, signature };
  await vscode.workspace.fs.writeFile(target, encoder.encode(withRecordSignature(text, block)));
  void vscode.window.showInformationMessage(`md-runbook: the run record is signed by ${recordSigners(block).join(', ')}. Export Report shows it; md-runbook verify checks the signatures.`);
}

export function registerSigning(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mdRunbook.signRunbook', signRunbook),
    vscode.commands.registerCommand('mdRunbook.cosignRunbook', cosignRunbook),
    vscode.commands.registerCommand('mdRunbook.signRecord', signRecord),
  );
}

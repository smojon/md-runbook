/** The Library view: a team library on a local web server, read, and a runbook opened as your own copy. */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { sshSign } from '@md-runbook/core/node';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { Test, closeAll, setConfig, waitFor, work } from './suite';

export const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>): void => void tests.push({ name, fn });

type Row = { node: { kind: 'entry'; entry: { path: string; title: string; text?: string }; libraryPath: string }; verdict?: { kind: string } };
type Read = { signedOnly: boolean; rows: Row[] } | undefined;

/** Serve `files` under /runbooks/ on 127.0.0.1 (http is allowed for this machine only). */
async function serve(files: Record<string, string>): Promise<{ base: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url ?? '/').replace(/^\/runbooks\//, ''));
    const body = files[p];
    if (body === undefined) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': p.endsWith('.json') ? 'application/json' : 'text/markdown' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/runbooks/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('library: the view lists a team library by folder, and opening a row opens your own copy', async () => {
  const srv = await serve({
    'index.json': JSON.stringify({ runbooks: ['deploy.md', { path: 'db/restore.md', folder: 'Databases' }] }),
    'deploy.md': '# Deploy the API\n\n```bash\necho deploy\n```\n',
    'db/restore.md': '# Restore\n',
  });
  try {
    await setConfig('library.url', srv.base);
    await vscode.commands.executeCommand('mdRunbook.library.refresh');
    // The refresh waits for the read; the test command waits for any read still going on.
    const read = await vscode.commands.executeCommand<Read>('mdRunbook._test.library');
    assert.ok(read, 'the library was read');
    assert.equal(read.signedOnly, false);
    assert.deepEqual(
      read.rows.map((r) => [r.node.entry.path, r.node.entry.title, r.verdict?.kind]),
      [
        ['deploy.md', 'Deploy the API', 'unsigned'],
        ['db/restore.md', 'Restore', 'unsigned'],
      ],
    );
    const row = read.rows[0]!;
    await vscode.commands.executeCommand('mdRunbook.library.open', row.node);
    const editor = await waitFor('the copy', () => vscode.window.visibleNotebookEditors.find((e) => e.notebook.uri.fsPath.endsWith('deploy.md')), 15_000);
    assert.match(editor.notebook.uri.fsPath.replace(/\\/g, '/'), /\/library\/[0-9a-f]{16}\/deploy\.md$/, 'a copy in global storage, not the shared file');
    assert.equal(editor.notebook.cellAt(0).document.getText().trim(), '# Deploy the API');
  } finally {
    await setConfig('library.url', undefined);
    await closeAll();
    await srv.close();
  }
});

test("library: Open from Library takes the library's text, not the text a caller passes", async () => {
  const srv = await serve({ 'index.json': JSON.stringify({ runbooks: ['check.md'] }), 'check.md': '# Check the API\n\n```bash\necho check\n```\n' });
  try {
    await setConfig('library.url', srv.base);
    await vscode.commands.executeCommand('mdRunbook.library.refresh');
    const read = await vscode.commands.executeCommand<Read>('mdRunbook._test.library');
    const row = read!.rows[0]!;
    // A stale row, or another extension calling the command with its own text under this path.
    const forged = { ...row.node, entry: { ...row.node.entry, text: '# Forged\n\n```bash\necho forged\n```\n' } };
    await vscode.commands.executeCommand('mdRunbook.library.open', forged);
    const editor = await waitFor('the copy', () => vscode.window.visibleNotebookEditors.find((e) => e.notebook.uri.fsPath.endsWith('check.md')), 15_000);
    assert.equal(editor.notebook.cellAt(0).document.getText().trim(), '# Check the API');
    assert.doesNotMatch(editor.notebook.getCells().map((c) => c.document.getText()).join('\n'), /forged/);
    // A path the library doesn't list opens nothing.
    await closeAll();
    await vscode.commands.executeCommand('mdRunbook.library.open', { ...forged, entry: { ...forged.entry, path: 'elsewhere.md', fileName: 'elsewhere.md' } });
    assert.equal(vscode.window.visibleNotebookEditors.length, 0);
  } finally {
    await setConfig('library.url', undefined);
    await closeAll();
    await srv.close();
  }
});

test("library: a key trusted from library A doesn't verify library B's runbook, and stops counting once A withdraws it", async () => {
  // One key, published by both libraries (two addresses), and a runbook signed with it in each.
  const key = path.join(work, 'library-trust-key');
  fs.rmSync(key, { force: true });
  fs.rmSync(key + '.pub', { force: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ana@example.net', '-f', key]);
  const pub = fs.readFileSync(key + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
  const text = '# Restart the API\n\n```bash\necho restart\n```\n';
  const built = buildManifest(text, { name: 'restart', version: 1, scopes: [], patterns: {} });
  if ('errors' in built) throw new Error(built.errors.join('; '));
  const manifest = formatManifest(built.manifest);
  const signed = withSignature(text, { signer: 'ana@example.net', signed: '2026-11-16', manifest, signature: await sshSign(manifest, key, { interactive: false }) });
  const published = `ana@example.net namespaces="md-runbook" ${pub}\n`;
  const filesA: Record<string, string> = { 'index.json': JSON.stringify({ runbooks: ['restart.md'] }), 'restart.md': signed, allowed_signers: published };
  const filesB: Record<string, string> = { ...filesA };
  const a = await serve(filesA);
  const b = await serve(filesB);
  const verdict = async (base: string): Promise<string | undefined> => {
    await setConfig('library.url', base);
    await vscode.commands.executeCommand('mdRunbook.library.refresh');
    const read = await vscode.commands.executeCommand<Read>('mdRunbook._test.library');
    return read?.rows[0]?.verdict?.kind;
  };
  let trusted: string | undefined;
  try {
    // Only the library's keys: none of your own.
    await setConfig('signing.allowedSigners', undefined);
    assert.equal(await verdict(a.base), 'untrusted', 'nothing trusted yet');
    trusted = await vscode.commands.executeCommand<string | undefined>('mdRunbook._test.trustLibrarySigners');
    assert.ok(trusted, "library A's keys trusted");
    assert.equal(await verdict(a.base), 'verified', "A's runbook, with A's key");
    assert.equal(await verdict(b.base), 'untrusted', "B's runbook: A's key doesn't count there");
    // A no longer publishes it: withdrawn, kept as a comment line.
    delete filesA.allowed_signers;
    assert.equal(await verdict(a.base), 'untrusted', 'withdrawn by A');
    assert.match(fs.readFileSync(trusted, 'utf8'), /^# withdrawn ana@example\.net/m);
    // Published again: it counts again.
    filesA.allowed_signers = published;
    assert.equal(await verdict(a.base), 'verified', 'published again');
  } finally {
    if (trusted) fs.rmSync(path.dirname(trusted), { recursive: true, force: true });
    await setConfig('library.url', undefined);
    await a.close();
    await b.close();
  }
});

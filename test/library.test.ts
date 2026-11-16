/**
 * The team library as VS Code's Library view reads it (src/libraryRead.ts) with core's parsers
 * (packages/core/src/library.ts, the app's too): index.json, nginx's listing, the address rules,
 * redirects, and what each runbook's signature is worth.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { libraryUrlProblemKind, normalizeLibraryUrl, parseAutoindex, parseIndexJson } from '@md-runbook/core/library';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { CANT_CHECK, ReadFetch, groupEntries, libraryBaseOf, libraryVerdict, readLibrary, verdictLabel } from '../src/libraryRead';

const BASE = 'https://runbooks.example.net/runbooks/';

/** A fake server: path → body (a string) or a status; `redirect` answers from another address. */
function server(files: Record<string, string | number>, redirect: Record<string, string> = {}): { fetch: ReadFetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: ReadFetch = async (url) => {
    asked.push(url);
    const body = files[url.slice(BASE.length)];
    const status = typeof body === 'number' ? body : body === undefined ? 404 : 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      url: redirect[url] ?? url,
      headers: { get: () => null },
      text: async () => (typeof body === 'string' ? body : 'not found'),
    };
  };
  return { fetch, asked };
}

const signed = (text: string, name: string, version = 1, expires?: string): string => {
  const built = buildManifest(text, { name, version, scopes: [], patterns: {}, ...(expires ? { expires } : {}) });
  assert.ok(!('errors' in built));
  return withSignature(text, { signer: 'ops@example.net', signed: '2026-11-14', manifest: formatManifest(built.manifest), signature: 'U1NIU0lH' });
};

describe('core library parsers (shared with the app)', () => {
  it('parseIndexJson: paths, titles, folders, signedOnly; unsafe paths and other files left out', () => {
    assert.deepEqual(
      parseIndexJson({ signedOnly: true, runbooks: ['deploy.md', { path: 'db/restore.md', title: ' Restore ', folder: 'Databases' }, '../x.md', 'a.txt', 'https://x/a.md', 'deploy.md'] }),
      { signedOnly: true, files: [{ path: 'deploy.md' }, { path: 'db/restore.md', title: 'Restore', folder: 'Databases' }] },
    );
    assert.equal(parseIndexJson({ files: [] }), undefined);
  });

  it('parseAutoindex: runbooks, folders and allowed_signers; hidden files left out', () => {
    assert.deepEqual(
      parseAutoindex([
        { name: 'b.md', type: 'file' },
        { name: 'a.md', type: 'file' },
        { name: 'db', type: 'directory' },
        { name: '.git', type: 'directory' },
        { name: 'allowed_signers', type: 'file' },
        { name: 'notes.txt', type: 'file' },
      ]),
      { files: ['a.md', 'b.md'], dirs: ['db'], allowedSigners: true },
    );
  });

  it('libraryUrlProblemKind: https only (http for localhost), no user name, no query; normalizeLibraryUrl makes a folder', () => {
    assert.equal(libraryUrlProblemKind(BASE), undefined);
    assert.equal(libraryUrlProblemKind('http://localhost:8080/runbooks/'), undefined);
    assert.equal(libraryUrlProblemKind('http://runbooks.example.net/'), 'https');
    assert.equal(libraryUrlProblemKind('https://me:pw@runbooks.example.net/'), 'userinfo');
    assert.equal(libraryUrlProblemKind('https://runbooks.example.net/?x=1'), 'invalid');
    assert.equal(libraryUrlProblemKind('https://runbooks.example.net\\@evil.example/'), 'invalid');
    assert.equal(normalizeLibraryUrl('https://Runbooks.Example.net/runbooks'), BASE);
    assert.equal(libraryBaseOf(' https://runbooks.example.net/runbooks '), BASE);
    assert.equal(libraryBaseOf('http://runbooks.example.net/'), undefined);
  });
});

describe('readLibrary', () => {
  it('reads index.json, each runbook (title from its heading) and allowed_signers', async () => {
    const s = server({
      'index.json': JSON.stringify({ runbooks: ['deploy.md', { path: 'db/restore.md', folder: 'Databases' }] }),
      'deploy.md': '# Deploy the API\n',
      'db/restore.md': '# Restore\n',
      allowed_signers: 'ops@example.net namespaces="md-runbook" ssh-ed25519 AAAA\n',
    });
    const r = await readLibrary(BASE, s.fetch);
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.deepEqual(
      r.library.entries.map((e) => [e.path, e.folder, e.title]),
      [
        ['deploy.md', '', 'Deploy the API'],
        ['db/restore.md', 'Databases', 'Restore'],
      ],
    );
    assert.match(r.library.allowedSigners ?? '', /ops@example.net/);
    assert.deepEqual(groupEntries(r.library.entries).map((g) => g.folder), ['', 'Databases']);
  });

  it('without index.json: the JSON listing of the folder and its subfolders', async () => {
    const s = server({
      '': JSON.stringify([{ name: 'a.md', type: 'file' }, { name: 'db', type: 'directory' }]),
      'db/': JSON.stringify([{ name: 'restore.md', type: 'file' }]),
      'a.md': '# A\n',
      'db/restore.md': '# Restore\n',
    });
    const r = await readLibrary(BASE, s.fetch);
    assert.equal(r.kind, 'ok');
    if (r.kind === 'ok') assert.deepEqual(r.library.entries.map((e) => [e.path, e.folder]), [['a.md', ''], ['db/restore.md', 'db']]);
    // No allowed_signers listed: not asked for.
    assert.ok(!s.asked.includes(BASE + 'allowed_signers'));
  });

  it('no listing: no library; a redirect to another server: not read', async () => {
    assert.deepEqual(await readLibrary(BASE, server({ '': '<!doctype html><html></html>' }).fetch), { kind: 'none' });
    const away = server({ 'index.json': '["a.md"]' }, { [BASE + 'index.json']: 'https://evil.example/index.json' });
    const r = await readLibrary(BASE, away.fetch);
    assert.equal(r.kind, 'error');
    if (r.kind === 'error') assert.match(r.message, /redirected to another server \(evil.example\)/);
  });

  it('a runbook that cannot be read is listed with why', async () => {
    const r = await readLibrary(BASE, server({ 'index.json': '["gone.md"]', 'gone.md': 500 }).fetch);
    assert.equal(r.kind, 'ok');
    if (r.kind === 'ok') assert.deepEqual([r.library.entries[0]!.title, r.library.entries[0]!.error], ['gone', 'HTTP 500']);
  });
});

describe('libraryVerdict', () => {
  const text = '# Restart\n\n```bash\nsystemctl restart api\n```\n';
  it('verified only when signed as a whole by a trusted signer, under a name that fits, not older than seen', () => {
    const doc = signed(text, 'restart', 3);
    assert.deepEqual(libraryVerdict('ops/restart.md', doc, 'ops@example.net', undefined), { kind: 'verified', name: 'restart', version: 3, signer: 'ops@example.net' });
    assert.equal(libraryVerdict('ops/restart.md', doc, undefined, undefined).kind, 'untrusted');
    assert.equal(libraryVerdict('ops/other.md', doc, 'ops@example.net', undefined).kind, 'other-name');
    assert.deepEqual(libraryVerdict('ops/restart.md', doc, 'ops@example.net', 4), { kind: 'older', name: 'restart', version: 3, seen: 4 });
    assert.equal(libraryVerdict('ops/restart.md', doc.replace('restart api', 'restart db'), 'ops@example.net', undefined).kind, 'changed');
    assert.equal(libraryVerdict('ops/restart.md', signed(text, 'restart', 1, '2020-01-01'), 'ops@example.net', undefined).kind, 'expired');
    assert.equal(libraryVerdict('ops/restart.md', text, undefined, undefined).kind, 'unsigned');
    assert.equal(verdictLabel(libraryVerdict('ops/restart.md', doc, 'ops@example.net', undefined)), 'verified · v3 · ops@example.net');
  });

  it("no ssh-keygen: says it can't check, not that the signer isn't trusted", () => {
    const v = libraryVerdict('ops/restart.md', signed(text, 'restart', 3), CANT_CHECK, undefined);
    assert.equal(v.kind, 'cant-check');
    assert.equal(verdictLabel(v), "signed by ops@example.net · can't check signatures: ssh-keygen not found (install OpenSSH)");
  });
});

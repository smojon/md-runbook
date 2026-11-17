import { SIGNATURE_NAMESPACE } from '@md-runbook/core/signing';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { Buffer } from 'buffer';
import { allowedSignersLine, generateKey } from '@md-runbook/ssh';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import {
  applyUpdate,
  carryOutputs,
  copyStatus,
  fetchLibrary,
  keepMine,
  libraryState,
  libraryUrlProblem,
  normalizeLibraryUrl,
  openLibraryRunbook,
  openableReason,
  parseAutoindex,
  parseIndexJson,
  planUpdate,
  refreshLibrary,
  resetLibrary,
  libraryHash,
} from '../runbooks/library';
import type { Library, LibraryEntry } from '../runbooks/library';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { flushRunbooks, getRunbook, loadRunbooks, resetRunbooks, updateRunbookText } from '../runbooks/store';
import { resetSettings, setLibraryUrl } from '../settings/store';
import { signRunbook, signPlan } from '../signing/sign';
import {
  parseAllowedSigners,
  resetTrustedSigners,
  signatureState,
  trustSigners,
  trustedFor,
  trustedSigners,
  untrustSigners,
} from '../signing/trust';
import { keyFingerprint, verifySshsig } from '../signing/verify';

const BASE = 'https://app.example.net/runbooks/';
const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';
const output = (text: string): string =>
  `\n<!-- md-runbook:output start exit=0 -->\n\`\`\`text\n${text}\n\`\`\`\n<!-- md-runbook:output end -->\n`;
const RUNBOOK = '# Restart the API\n\n' + fence('bash', 'systemctl restart api') + '\n' + fence('bash', 'systemctl status api');

/** A fetch that answers from a table of URLs (anything else: 404). */
function server(files: Record<string, string>, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(url);
    const body = files[url];
    return body === undefined
      ? { ok: false, status: 404, url, headers: new Headers(), text: async () => 'not found' }
      : { ok: true, status: 200, url, headers: new Headers(), text: async () => body };
  }) as unknown as typeof fetch;
}

let alice: KeyPair;
let bob: KeyPair;
async function signed(text: string, signer: string, key: KeyPair): Promise<string> {
  const r = await signRunbook(text, signPlan(text, 'restart.md'), { name: 'restart', scopes: '', days: '', patterns: {} }, signer, key);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.text;
}

beforeAll(async () => {
  alice = await generateKey();
  bob = await generateKey();
});
beforeEach(async () => {
  await AsyncStorage.clear();
  resetRunbooks();
  resetSettings();
  resetTrustedSigners();
  resetLibrary();
});

describe('reading a library', () => {
  it('index.json: names, titles, folders, signedOnly; paths that leave the folder are dropped', () => {
    expect(
      parseIndexJson({
        signedOnly: true,
        runbooks: [
          'deploy.md',
          { path: './db/restore.md', title: ' Restore ', folder: 'Databases' },
          { path: '../etc/passwd.md' },
          '/abs.md',
          'https://evil.example.net/x.md',
          'notes.txt',
          'deploy.md',
        ],
      }),
    ).toEqual({ signedOnly: true, files: [{ path: 'deploy.md' }, { path: 'db/restore.md', title: 'Restore', folder: 'Databases' }] });
    expect(parseIndexJson(['a.md'])).toEqual({ signedOnly: false, files: [{ path: 'a.md' }] });
    expect(parseIndexJson({ files: [] })).toBeUndefined();
    expect(parseIndexJson('x')).toBeUndefined();
  });

  it("nginx's JSON listing: runbooks, subfolders and allowed_signers; hidden and other files are not", () => {
    expect(
      parseAutoindex([
        { name: 'ops', type: 'directory', mtime: 'Sat, 14 Nov 2026 10:00:00 GMT' },
        { name: 'b.md', type: 'file', mtime: 'x', size: 10 },
        { name: 'a.markdown', type: 'file', mtime: 'x', size: 10 },
        { name: 'allowed_signers', type: 'file', mtime: 'x', size: 10 },
        { name: 'index.json', type: 'file', mtime: 'x', size: 10 },
        { name: '.hidden.md', type: 'file' },
        { name: 'link', type: 'other' },
      ]),
    ).toEqual({ files: ['a.markdown', 'b.md'], dirs: ['ops'], allowedSigners: true });
    expect(parseAutoindex({})).toBeUndefined();
  });

  it('from the listing: subfolders become groups, titles come from the runbooks, allowed_signers is read', async () => {
    const seen: string[] = [];
    const got = await fetchLibrary(
      BASE,
      server(
        {
          [BASE]: JSON.stringify([
            { name: 'ops', type: 'directory' },
            { name: 'hello.md', type: 'file' },
            { name: 'allowed_signers', type: 'file' },
          ]),
          [BASE + 'ops/']: JSON.stringify([{ name: 'db restore.md', type: 'file' }]),
          [BASE + 'hello.md']: 'no heading here\n',
          [BASE + 'ops/db%20restore.md']: RUNBOOK,
          [BASE + 'allowed_signers']: '# none yet\n',
        },
        seen,
      ),
    );
    expect(got.kind).toBe('ok');
    if (got.kind !== 'ok') return;
    expect(got.library.entries.map((e) => [e.path, e.folder, e.title, e.hash === libraryHash(e.text ?? '')])).toEqual([
      ['hello.md', '', 'hello', true],
      ['ops/db restore.md', 'ops', 'Restart the API', true],
    ]);
    expect(got.library.signers).toEqual({ list: [], skipped: 0 });
    expect(seen[0]).toBe(BASE + 'index.json');
  });

  it('index.json wins over the listing; a file that is missing is listed with why', async () => {
    const got = await fetchLibrary(
      BASE,
      server({
        [BASE + 'index.json']: JSON.stringify({ runbooks: [{ path: 'r.md', title: 'Given title' }, 'gone.md'] }),
        [BASE + 'r.md']: RUNBOOK,
      }),
    );
    if (got.kind !== 'ok') throw new Error(got.kind);
    expect(got.library.entries).toMatchObject([
      { path: 'r.md', title: 'Given title', text: RUNBOOK },
      { path: 'gone.md', title: 'gone', error: 'HTTP 404' },
    ]);
    // No listing there: allowed_signers is asked for anyway (404: it publishes none).
    expect(got.library.signers).toEqual({ list: [], skipped: 0 });
  });

  it('no library (404, a listing that is not JSON) is none; a server error says so', async () => {
    expect(await fetchLibrary(BASE, server({}))).toEqual({ kind: 'none' });
    // A single-page app's fallback page where the folder should be.
    expect(await fetchLibrary(BASE, server({ [BASE]: '<!doctype html><html></html>' }))).toEqual({ kind: 'none' });
    const failing = (async () => ({ ok: false, status: 500, headers: new Headers(), text: async () => '' })) as unknown as typeof fetch;
    expect(await fetchLibrary(BASE, failing)).toEqual({ kind: 'error', message: 'HTTP 500' });
    const offline = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    expect(await fetchLibrary(BASE, offline)).toEqual({ kind: 'error', message: 'Network request failed' });
    expect(await fetchLibrary(BASE, server({ [BASE + 'index.json']: '{"runbooks": 3}' }))).toMatchObject({ kind: 'error' });
  });

  it('the address: https only (http for this machine), always a folder', () => {
    expect(libraryUrlProblem('https://runbooks.example.net/runbooks/')).toBeUndefined();
    expect(libraryUrlProblem('http://localhost:8080/runbooks/')).toBeUndefined();
    expect(libraryUrlProblem('http://127.0.0.1/runbooks')).toBeUndefined();
    expect(libraryUrlProblem('http://runbooks.example.net/')).toMatch(/https/);
    expect(libraryUrlProblem('ftp://x.example.net/')).toMatch(/https/);
    expect(libraryUrlProblem('runbooks.example.net')).toMatch(/Not a library address/);
    expect(libraryUrlProblem('https://x.example.net/r/?token=1')).toMatch(/Not a library address/);
    expect(normalizeLibraryUrl(' https://x.example.net/r ')).toBe('https://x.example.net/r/');
  });
});

describe('copies of library runbooks', () => {
  const lib = (entries: LibraryEntry[], signedOnly = false): Library => ({ base: BASE, signedOnly, entries });
  const entry = (text: string, path = 'ops/restart.md'): LibraryEntry & { text: string; hash: string } => ({
    path,
    fileName: path.split('/').pop()!,
    folder: 'ops',
    title: 'Restart',
    text,
    hash: libraryHash(text),
  });

  it('opening makes the user’s copy; opening again opens it; the library file is not touched', async () => {
    const e = entry(RUNBOOK);
    const first = await openLibraryRunbook(lib([e]), e);
    if (first.kind !== 'opened') throw new Error(first.message);
    expect(first.runbook).toMatchObject({
      source: 'library',
      fileName: 'restart.md',
      text: RUNBOOK,
      library: { base: BASE, path: 'ops/restart.md', hash: e.hash },
    });
    updateRunbookText(first.runbook.id, RUNBOOK.replace('restart api', 'restart api # ran') + output('ok'));
    const again = await openLibraryRunbook(lib([e]), e);
    expect(again.kind === 'opened' && again.runbook.id).toBe(first.runbook.id);
    expect(e.text).toBe(RUNBOOK);
  });

  it('a changed library file: Update available; Keep mine skips that version; a newer one asks again', async () => {
    const e = entry(RUNBOOK);
    const r = await openLibraryRunbook(lib([e]), e);
    if (r.kind !== 'opened') throw new Error(r.message);
    expect(copyStatus(getRunbook(r.runbook.id)!, e)).toBe('current');
    const v2 = entry(RUNBOOK + '\nMore notes.\n');
    expect(copyStatus(getRunbook(r.runbook.id)!, v2)).toBe('update');
    keepMine(r.runbook.id, v2);
    expect(copyStatus(getRunbook(r.runbook.id)!, v2)).toBe('kept');
    expect(copyStatus(getRunbook(r.runbook.id)!, entry(RUNBOOK + '\nv3\n'))).toBe('update');
  });

  it('Update takes the new text and keeps the outputs of blocks that did not change; others are counted', async () => {
    const e = entry(RUNBOOK);
    const r = await openLibraryRunbook(lib([e]), e);
    if (r.kind !== 'opened') throw new Error(r.message);
    // Both blocks ran.
    const ran =
      '# Restart the API\n\n' +
      fence('bash', 'systemctl restart api') +
      output('restarted') +
      '\n' +
      fence('bash', 'systemctl status api') +
      output('active');
    updateRunbookText(r.runbook.id, ran);
    // The new version changes the second block and adds a paragraph.
    const v2 = entry(
      '# Restart the API\n\nNew intro.\n\n' +
        fence('bash', 'systemctl restart api') +
        '\n' +
        fence('bash', 'systemctl status api --no-pager'),
    );
    const plan = planUpdate(getRunbook(r.runbook.id)!, v2, { kind: 'unsigned' });
    expect(plan.warnings).toEqual([{ kind: 'lost-outputs', count: 1 }]);
    expect(plan.text).toBe(
      '# Restart the API\n\nNew intro.\n\n' +
        fence('bash', 'systemctl restart api') +
        output('restarted') +
        '\n' +
        fence('bash', 'systemctl status api --no-pager'),
    );
    applyUpdate(r.runbook.id, BASE, v2, plan.text);
    expect(getRunbook(r.runbook.id)).toMatchObject({ text: plan.text, library: { hash: v2.hash } });
    expect(copyStatus(getRunbook(r.runbook.id)!, v2)).toBe('current');
    // The copy's own edits (not outputs) are flagged.
    updateRunbookText(r.runbook.id, plan.text.replace('New intro.', 'My notes.'));
    expect(planUpdate(getRunbook(r.runbook.id)!, entry(RUNBOOK), { kind: 'unsigned' }).warnings).toContainEqual({ kind: 'own-edits' });
  });

  it('carrying outputs into an unchanged text gives the same bytes', () => {
    const ran = RUNBOOK.replace('systemctl restart api\n```\n', 'systemctl restart api\n```\n' + output('ok'));
    expect(carryOutputs(ran, RUNBOOK)).toEqual({ text: ran, lost: 0 });
    expect(carryOutputs(RUNBOOK, RUNBOOK)).toEqual({ text: RUNBOOK, lost: 0 });
  });

  it('the copies are still library copies after a restart', async () => {
    const e = entry(RUNBOOK);
    const r = await openLibraryRunbook(lib([e]), e);
    if (r.kind !== 'opened') throw new Error(r.message);
    await flushRunbooks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    resetRunbooks();
    expect(getRunbook(r.runbook.id)).toBeUndefined();
    await loadRunbooks();
    expect(getRunbook(r.runbook.id)).toMatchObject({ source: 'library', library: { base: BASE, path: 'ops/restart.md', hash: e.hash } });
  });
});

describe('signatures in the library', () => {
  const line = async (key: KeyPair, name: string): Promise<string> => allowedSignersLine(key, name);

  it('allowed_signers: names, fingerprints, options; certificate authorities and other namespaces are skipped', async () => {
    const a = await line(alice, 'alice@example.net');
    const text = [
      '# the team',
      a + ' alice laptop',
      `bob@example.net,*@ops.example.net ${(await line(bob, 'x')).split(' ').slice(2).join(' ')}`,
      // Quotes only around an option's value: quoted names are not used.
      `"dave@example.net" ${(await line(bob, 'x')).split(' ').slice(2).join(' ')}`,
      `carol@example.net namespaces="git" ${(await line(bob, 'x')).split(' ').slice(2).join(' ')}`,
      `ca@example.net cert-authority ${(await line(bob, 'x')).split(' ').slice(2).join(' ')}`,
      'broken line',
    ].join('\n');
    const { signers, skipped } = parseAllowedSigners(text, SIGNATURE_NAMESPACE);
    expect(skipped).toBe(4);
    expect(signers.map((s) => [s.principals, s.keyType, s.namespaces])).toEqual([
      [['alice@example.net'], 'ecdsa-sha2-nistp256', ['md-runbook']],
      [['bob@example.net', '*@ops.example.net'], 'ecdsa-sha2-nistp256', undefined],
    ]);
    const blob = Buffer.from(a.split(' ')[3]!, 'base64');
    expect(signers[0]!.fingerprint).toBe('SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''));
  });

  it('verified with a trusted key; unknown signer when untrusted; another key under a trusted name does not check out', async () => {
    const text = await signed(RUNBOOK, 'alice@example.net', alice);
    const keys = () => trustedFor(BASE);
    expect(await signatureState(text, keys())).toEqual({
      kind: 'unknown',
      signers: ['alice@example.net'],
      manifest: { name: 'restart', version: 1, scopes: [] },
    });
    const list = parseAllowedSigners(await line(alice, 'alice@example.net'), SIGNATURE_NAMESPACE).signers;
    trustSigners(list, BASE);
    expect(trustedSigners()).toHaveLength(1);
    expect(await signatureState(text, keys())).toEqual({
      kind: 'verified',
      signers: ['alice@example.net'],
      manifest: { name: 'restart', version: 1, scopes: [] },
      verified: [{ name: 'alice@example.net', fingerprint: list[0]!.fingerprint, wildcard: false }],
      coverage: 'whole',
    });
    // Bob signs as alice: the name is trusted, the key is not hers.
    const forged = await signed(RUNBOOK, 'alice@example.net', bob);
    expect(await signatureState(forged, keys())).toEqual({ kind: 'invalid', signers: ['alice@example.net'] });
    // A changed block, and no signature at all.
    expect(await signatureState(text.replace('systemctl status api', 'rm -rf /'), keys())).toEqual({
      kind: 'changed',
      signers: ['alice@example.net'],
    });
    expect(await signatureState(RUNBOOK, keys())).toEqual({ kind: 'unsigned' });
    untrustSigners(list, BASE);
    expect(await signatureState(text, keys())).toMatchObject({ kind: 'unknown' });
  });

  it('a trusted key past its valid-before is not trusted any more', async () => {
    const text = await signed(RUNBOOK, 'alice@example.net', alice);
    const [name, , ...key] = (await line(alice, 'alice@example.net')).split(' ');
    const list = parseAllowedSigners(
      `${name} namespaces="md-runbook",valid-before="20200101" ${key.join(' ')}`,
      SIGNATURE_NAMESPACE,
    ).signers;
    expect(list).toHaveLength(1);
    expect(await signatureState(text, list)).toMatchObject({ kind: 'unknown' });
  });

  it('checks ssh-ed25519 and RSA signatures as ssh-keygen makes them', async () => {
    const str = (b: Uint8Array | string): Buffer => {
      const v = typeof b === 'string' ? Buffer.from(b) : Buffer.from(b);
      const n = Buffer.alloc(4);
      n.writeUInt32BE(v.length, 0);
      return Buffer.concat([n, v]);
    };
    const mpint = (b: Buffer): Buffer => str(b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
    const sshsig = (pub: Buffer, sigType: string, sign: (data: Buffer) => Buffer, message: string): string => {
      const h = createHash('sha512').update(message).digest();
      const signedData = Buffer.concat([Buffer.from('SSHSIG'), str('md-runbook'), str(''), str('sha512'), str(h)]);
      const sig = Buffer.concat([str(sigType), str(sign(signedData))]);
      const blob = Buffer.concat([
        Buffer.from('SSHSIG'),
        Buffer.from([0, 0, 0, 1]),
        str(pub),
        str('md-runbook'),
        str(''),
        str('sha512'),
        str(sig),
      ]);
      return blob.toString('base64');
    };
    const ed = generateKeyPairSync('ed25519');
    const edPub = Buffer.concat([str('ssh-ed25519'), str(Buffer.from(ed.publicKey.export({ format: 'jwk' }).x!, 'base64url'))]);
    const edSig = sshsig(edPub, 'ssh-ed25519', (d) => Buffer.from(nodeSign(null, d, ed.privateKey)), 'manifest');
    expect(await verifySshsig(edSig, 'manifest', SIGNATURE_NAMESPACE)).toBe(true);
    expect(await verifySshsig(edSig, 'other manifest', SIGNATURE_NAMESPACE)).toBe(false);
    expect(keyFingerprint(edPub)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = rsa.publicKey.export({ format: 'jwk' });
    const rsaPub = Buffer.concat([str('ssh-rsa'), mpint(Buffer.from(jwk.e!, 'base64url')), mpint(Buffer.from(jwk.n!, 'base64url'))]);
    const rsaSig = sshsig(rsaPub, 'rsa-sha2-512', (d) => Buffer.from(nodeSign('sha512', d, rsa.privateKey)), 'manifest');
    expect(await verifySshsig(rsaSig, 'manifest', SIGNATURE_NAMESPACE)).toBe(true);
    expect(await verifySshsig(rsaSig, 'manifest!', SIGNATURE_NAMESPACE)).toBe(false);
    // A damaged blob is no signature.
    expect(await verifySshsig(rsaSig.replace(/^U/, 'A'), 'manifest', SIGNATURE_NAMESPACE)).toBe(false);
  });

  it('signedOnly: unsigned and changed runbooks are listed as not openable, with why; signed ones open', async () => {
    const good = await signed(RUNBOOK, 'alice@example.net', alice);
    const e = (text: string, path: string): LibraryEntry => ({
      path,
      fileName: path,
      folder: '',
      title: path,
      text,
      hash: libraryHash(text),
    });
    const library: Library = { base: BASE, signedOnly: true, entries: [] };
    expect(openableReason(library, e(RUNBOOK, 'u.md'), { kind: 'unsigned' })).toMatch(/not signed/);
    expect(openableReason(library, e(good, 'c.md'), { kind: 'changed', signers: ['alice@example.net'] })).toMatch(/changed since signing/);
    const manifest = { name: 'restart', version: 1, scopes: [] };
    // Signed and unchanged is not enough: no signer trusted for this library, not openable.
    expect(openableReason(library, e(good, 's.md'), { kind: 'unknown', signers: ['alice@example.net'], manifest })).toMatch(
      /trust its signers first/,
    );
    expect(openableReason({ base: BASE, signedOnly: false }, e(RUNBOOK, 'u.md'), { kind: 'unsigned' })).toBeUndefined();
    // Opening checks again (not only the list).
    expect(await openLibraryRunbook(library, e(RUNBOOK, 'u.md'))).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/not signed/),
    });
    expect(await openLibraryRunbook(library, e(good, 'restart.md'))).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/trust/),
    });
    trustSigners(parseAllowedSigners(await allowedSignersLine(alice, 'alice@example.net'), SIGNATURE_NAMESPACE).signers, BASE);
    expect(await openLibraryRunbook(library, e(good, 'restart.md'))).toMatchObject({ kind: 'opened' });
  });

  it('an update that drops the signature, or comes from another signer, is flagged', async () => {
    const v1 = await signed(RUNBOOK, 'alice@example.net', alice);
    const e1: LibraryEntry = { path: 'r.md', fileName: 'r.md', folder: '', title: 'r', text: v1, hash: libraryHash(v1) };
    const r = await openLibraryRunbook({ base: BASE, signedOnly: false, entries: [e1] }, e1);
    if (r.kind !== 'opened') throw new Error(r.message);
    const copy = getRunbook(r.runbook.id)!;
    const unsignedV2 = RUNBOOK + '\nv2\n';
    expect(planUpdate(copy, { ...e1, text: unsignedV2, hash: libraryHash(unsignedV2) }, { kind: 'unsigned' }).warnings).toEqual([
      { kind: 'signature-dropped', was: 'alice@example.net' },
    ]);
    const bobV2 = await signed(RUNBOOK + '\nv2\n', 'bob@example.net', bob);
    expect(
      planUpdate(
        copy,
        { ...e1, text: bobV2, hash: libraryHash(bobV2) },
        { kind: 'unknown', signers: ['bob@example.net'], manifest: { name: 'restart', version: 1, scopes: [] } },
      ).warnings,
    ).toEqual([{ kind: 'other-signer', was: 'alice@example.net', now: 'bob@example.net' }]);
    // Same name, another key.
    const sameName = await signed(RUNBOOK + '\nv2\n', 'alice@example.net', bob);
    expect(
      planUpdate(
        copy,
        { ...e1, text: sameName, hash: libraryHash(sameName) },
        { kind: 'unknown', signers: ['alice@example.net'], manifest: { name: 'restart', version: 1, scopes: [] } },
      ).warnings,
    ).toEqual([{ kind: 'other-signer', was: 'alice@example.net', now: 'alice@example.net' }]);
    // Re-signed by alice: nothing to flag.
    const aliceV2 = await signed(RUNBOOK + '\nv2\n', 'alice@example.net', alice);
    expect(
      planUpdate(
        copy,
        { ...e1, text: aliceV2, hash: libraryHash(aliceV2) },
        { kind: 'unknown', signers: ['alice@example.net'], manifest: { name: 'restart', version: 1, scopes: [] } },
      ).warnings,
    ).toEqual([]);
  });
});

describe('the library the list shows', () => {
  it('refreshes from the library at the default or the set address, with a short cache', async () => {
    setLibraryUrl('https://runbooks.example.net/team');
    const seen: string[] = [];
    const fetcher = server(
      {
        'https://runbooks.example.net/team/index.json': JSON.stringify(['a.md']),
        'https://runbooks.example.net/team/a.md': RUNBOOK,
      },
      seen,
    );
    await refreshLibrary({ fetcher });
    expect(libraryState()).toMatchObject({ base: 'https://runbooks.example.net/team/', status: 'ready' });
    expect(libraryState().signatures).toEqual({ [libraryHash(RUNBOOK)]: { kind: 'unsigned' } });
    const n = seen.length;
    await refreshLibrary({ fetcher });
    expect(seen.length).toBe(n);
    await refreshLibrary({ fetcher, force: true });
    expect(seen.length).toBeGreaterThan(n);
  });

  it('offline after a read: the runbooks read before stay; a library that is gone leaves nothing', async () => {
    setLibraryUrl('https://runbooks.example.net/team/');
    await refreshLibrary({
      fetcher: server({ 'https://runbooks.example.net/team/index.json': '["a.md"]', 'https://runbooks.example.net/team/a.md': RUNBOOK }),
    });
    const offline = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await refreshLibrary({ fetcher: offline, force: true });
    expect(libraryState()).toMatchObject({ status: 'ready', error: 'Network request failed' });
    expect(libraryState().library?.entries).toHaveLength(1);
    await refreshLibrary({ fetcher: server({}), force: true });
    expect(libraryState()).toMatchObject({ status: 'none' });
  });
});

/**
 * Per-library trust in VS Code (src/libraryTrust.ts, docs/design/vscode-library-trust.md): the
 * files per library origin, which runbooks are a library's, withdrawn keys, and the two-file check
 * the Library view, run reports and Practice on a Host use.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runbookSignerCheck, sshSign } from '@md-runbook/core/node';
import { reportPlan, reportTrustProblem } from '@md-runbook/core/runReport';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { readLibrary, type ReadFetch } from '../src/libraryRead';
import {
  WITHDRAWN,
  alsoPublished,
  libraryCopyFile,
  libraryOriginOf,
  librarySignerFiles,
  librarySignersFile,
  noteWithdrawn,
  originOf,
  readLibrarySigners,
  runbookSignerFiles,
  signerFiles,
  signerOf,
  trustLibraryLines,
  withTrustedLines,
  withWithdrawn,
} from '../src/libraryTrust';
import { readSigners } from '../src/allowedSigners';
import type { SignerCheck } from '../src/signerCheck';

const A = 'https://a.example.net/runbooks/';
const B = 'https://b.example.net:8443/team/';
const KEY1 = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const KEY2 = 'AAAAC3NzaC1lZDI1NTE5AAAAIBwNRJcGxHWqaAzJ9YiCwJBC1H4nsMxJ5GyT/Ec8VdYr';
const line = (name: string, key: string): string => `${name} namespaces="md-runbook" ssh-ed25519 ${key}`;

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-libtrust-'));

describe('library trust: files and origins', () => {
  it("originOf: a library address's https://host[:port]", () => {
    assert.equal(originOf(A), 'https://a.example.net');
    assert.equal(originOf(B), 'https://b.example.net:8443');
    assert.equal(originOf('http://127.0.0.1:8080/runbooks/'), 'http://127.0.0.1:8080');
    assert.equal(originOf('file:///etc/x'), undefined);
    assert.equal(originOf('not a url'), undefined);
  });

  it('one file per origin, with origin.txt: listed by host', () => {
    const storage = tmp();
    try {
      assert.deepEqual(librarySignerFiles(storage), []);
      const a = trustLibraryLines(storage, 'https://a.example.net', [line('ana@example.net', KEY1)]);
      const b = trustLibraryLines(storage, 'https://b.example.net:8443', [line('bob@example.net', KEY2)]);
      assert.notEqual(a.file, b.file);
      assert.equal(a.file, librarySignersFile(storage, 'https://a.example.net'));
      assert.match(a.file.replace(/\\/g, '/'), /\/library-signers\/[0-9a-f]{64}\/allowed_signers$/);
      assert.equal(fs.readFileSync(path.join(path.dirname(a.file), 'origin.txt'), 'utf8').trim(), 'https://a.example.net');
      assert.match(fs.readFileSync(a.file, 'utf8'), /its runbooks only[\s\S]*ana@example\.net/);
      assert.deepEqual(
        librarySignerFiles(storage).map((f) => f.origin),
        ['https://a.example.net', 'https://b.example.net:8443'],
      );
      // An origin.txt that doesn't match its folder (copied, edited) is not listed.
      fs.writeFileSync(path.join(path.dirname(b.file), 'origin.txt'), 'https://a.example.net\n');
      assert.deepEqual(
        librarySignerFiles(storage).map((f) => f.origin),
        ['https://a.example.net'],
      );
      // Trusting it again: there already.
      assert.deepEqual(trustLibraryLines(storage, 'https://a.example.net', [line('ana@example.net', KEY1)]).already, 1);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it("libraryCopy writes origin.txt next to the copy; libraryOriginOf reads it only in a copy folder", () => {
    const storage = tmp();
    try {
      const copy = libraryCopyFile(storage, A, { path: 'db/restore.md', fileName: 'restore.md', text: '# Restore\n' });
      assert.match(copy.replace(/\\/g, '/'), /\/library\/[0-9a-f]{16}\/restore\.md$/);
      assert.equal(fs.readFileSync(copy, 'utf8'), '# Restore\n');
      assert.equal(libraryOriginOf(copy, storage), 'https://a.example.net');
      // A runbook it calls, in the same folder, is the library's too.
      const called = path.join(path.dirname(copy), 'called.md');
      fs.writeFileSync(called, '# Called\n');
      assert.equal(libraryOriginOf(called, storage), 'https://a.example.net');
      // Anywhere else: no library's, even next to an origin.txt.
      const elsewhere = path.join(storage, 'work', 'restore.md');
      fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
      fs.writeFileSync(elsewhere, '# Restore\n');
      fs.writeFileSync(path.join(path.dirname(elsewhere), 'origin.txt'), 'https://a.example.net\n');
      assert.equal(libraryOriginOf(elsewhere, storage), undefined);
      const nested = path.join(path.dirname(copy), 'sub', 'x.md');
      assert.equal(libraryOriginOf(nested, storage), undefined);
      assert.equal(libraryOriginOf(path.join(os.tmpdir(), 'x.md'), storage), undefined);
      // A copy from before origin.txt gets it when opened again.
      fs.rmSync(path.join(path.dirname(copy), 'origin.txt'));
      assert.equal(libraryOriginOf(copy, storage), undefined);
      assert.equal(libraryCopyFile(storage, A, { path: 'db/restore.md', fileName: 'restore.md', text: '# Restore\n' }), copy);
      assert.equal(libraryOriginOf(copy, storage), 'https://a.example.net');
      // Another library's copy: its own origin.
      const other = libraryCopyFile(storage, B, { path: 'db/restore.md', fileName: 'restore.md', text: '# Restore\n' });
      assert.notEqual(other, copy);
      assert.equal(libraryOriginOf(other, storage), 'https://b.example.net:8443');
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('signerFiles: yours first, then the origin’s when you trust keys from it', () => {
    const storage = tmp();
    try {
      const own = path.join(storage, 'allowed_signers');
      assert.deepEqual(signerFiles(own, storage, 'https://a.example.net'), [own], 'no keys trusted from it: yours only');
      const { file } = trustLibraryLines(storage, 'https://a.example.net', [line('ana@example.net', KEY1)]);
      assert.deepEqual(signerFiles(own, storage, 'https://a.example.net'), [own, file]);
      assert.deepEqual(signerFiles('', storage, 'https://a.example.net'), [file], 'no file of yours: the library’s');
      assert.deepEqual(signerFiles(own, storage, 'https://b.example.net:8443'), [own]);
      assert.deepEqual(signerFiles(own, storage, undefined), [own]);
      const copy = libraryCopyFile(storage, A, { path: 'x.md', fileName: 'x.md', text: '# X\n' });
      assert.deepEqual(runbookSignerFiles(own, storage, copy), [own, file]);
      assert.deepEqual(runbookSignerFiles(own, storage, path.join(storage, 'x.md')), [own]);
      assert.deepEqual(runbookSignerFiles('', storage, undefined), []);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('signerOf: two calls at most, the first signer wins, "can\'t check" stops', async () => {
    const asked: string[] = [];
    const answers: Record<string, SignerCheck> = { mine: {}, lib: { signer: 'ana@example.net' } };
    const check = async (_t: string, f: string): Promise<SignerCheck> => (asked.push(f), answers[f] ?? {});
    assert.deepEqual(await signerOf('t', ['mine', 'lib'], check), { signer: 'ana@example.net' });
    assert.deepEqual(asked, ['mine', 'lib']);
    answers.mine = { signer: 'me@example.net' };
    asked.length = 0;
    assert.deepEqual(await signerOf('t', ['mine', 'lib'], check), { signer: 'me@example.net' });
    assert.deepEqual(asked, ['mine']);
    answers.mine = { cantCheck: true };
    assert.deepEqual(await signerOf('t', ['mine', 'lib'], check), { cantCheck: true });
    assert.deepEqual(await signerOf('t', [], check), {});
  });
});

describe('library trust: withdrawn keys', () => {
  const header = '# header\n';
  const file = header + line('ana@example.net', KEY1) + '\n' + line('bob@example.net', KEY2) + '\n';

  it('a key the library no longer publishes becomes a # withdrawn line; published again, it counts again', () => {
    const gone = withWithdrawn(file, line('ana@example.net', KEY1) + '\n');
    assert.ok(gone);
    assert.equal(gone, header + line('ana@example.net', KEY1) + '\n' + WITHDRAWN + line('bob@example.net', KEY2) + '\n');
    // ssh-keygen skips comment lines: bob no longer counts.
    assert.deepEqual(
      readSigners(gone).signers.map((s) => s.principals[0]),
      ['ana@example.net'],
    );
    const shown = readLibrarySigners(gone).signers;
    assert.deepEqual(
      shown.map((s) => [s.principals[0], s.withdrawn ?? false]),
      [
        ['ana@example.net', false],
        ['bob@example.net', true],
      ],
    );
    assert.equal(withWithdrawn(gone, line('ana@example.net', KEY1) + '\n'), undefined, 'nothing changes: undefined');
    // Published again (the options may differ: the key and names count).
    assert.equal(withWithdrawn(gone, `ana@example.net ssh-ed25519 ${KEY1}\nbob@example.net ssh-ed25519 ${KEY2}\n`), file);
    // The library publishes none: every key is withdrawn.
    assert.equal(withWithdrawn(file, ''), header + WITHDRAWN + line('ana@example.net', KEY1) + '\n' + WITHDRAWN + line('bob@example.net', KEY2) + '\n');
    // The same key for another name is not the same signer.
    assert.match(withWithdrawn(file, line('eve@example.net', KEY1) + '\n' + line('bob@example.net', KEY2) + '\n') ?? '', /# withdrawn ana@example\.net/);
  });

  it('noteWithdrawn changes the file only when you trust keys from that library', () => {
    const storage = tmp();
    try {
      noteWithdrawn(storage, 'https://a.example.net', '');
      assert.equal(fs.existsSync(librarySignersFile(storage, 'https://a.example.net')), false);
      const { file: f } = trustLibraryLines(storage, 'https://a.example.net', [line('ana@example.net', KEY1)]);
      noteWithdrawn(storage, 'https://a.example.net', line('bob@example.net', KEY2));
      assert.match(fs.readFileSync(f, 'utf8'), /^# withdrawn ana@example\.net/m);
      noteWithdrawn(storage, 'https://a.example.net', line('ana@example.net', KEY1));
      assert.match(fs.readFileSync(f, 'utf8'), /^ana@example\.net/m);
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('trusting a withdrawn key again restores its line instead of adding one', () => {
    const gone = header + WITHDRAWN + line('ana@example.net', KEY1) + '\n';
    const r = withTrustedLines(gone, header, [line('ana@example.net', KEY1), line('bob@example.net', KEY2), line('bob@example.net', KEY2)]);
    assert.deepEqual(r.added, [0, 1]);
    assert.equal(r.already, 1);
    assert.equal(r.text, header + line('ana@example.net', KEY1) + '\n' + line('bob@example.net', KEY2) + '\n');
    assert.equal(withTrustedLines('', header, [line('ana@example.net', KEY1)]).text, header + line('ana@example.net', KEY1) + '\n');
  });

  it("keys an earlier version put in your file: marked when the library publishes them too", () => {
    const own = readSigners(`${line('ana@example.net', KEY1)}\n${line('me@example.net', KEY2)}\n`).signers;
    assert.deepEqual([...alsoPublished(own, `ana@example.net ssh-ed25519 ${KEY1}\n`)], [0]);
    assert.deepEqual([...alsoPublished(own, undefined)], []);
    assert.deepEqual([...alsoPublished(own, '')], []);
  });

  it("readLibrary: a library that publishes no allowed_signers gives '', one that can't be read none", async () => {
    const fetchOf = (signers: number | string, error = false): ReadFetch => async (url) => {
      if (error && url.endsWith('allowed_signers')) throw new Error('offline');
      const body = url.endsWith('index.json') ? JSON.stringify({ runbooks: [] }) : url.endsWith('allowed_signers') ? signers : 404;
      const status = typeof body === 'number' ? body : 200;
      return { status, ok: status === 200, url, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : '') };
    };
    const signersOf = async (f: ReadFetch): Promise<string | undefined> => {
      const r = await readLibrary(A, f);
      assert.equal(r.kind, 'ok');
      return r.kind === 'ok' ? r.library.allowedSigners : undefined;
    };
    assert.equal(await signersOf(fetchOf(404)), '');
    assert.equal(await signersOf(fetchOf(line('ana@example.net', KEY1))), line('ana@example.net', KEY1));
    assert.equal(await signersOf(fetchOf(500)), undefined);
    assert.equal(await signersOf(fetchOf(404, true)), undefined);
  });
});

describe('library trust: run reports and practice (ssh-keygen)', () => {
  let dir: string;
  let storage: string;
  let libKey: string;
  let ownKey: string;
  let own: string;
  const pub = (k: string): string => fs.readFileSync(k + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
  const TEXT = '---\nreport-runs: https://reports.example.net/runs\nreport-runs-required: true\n---\n\n# Restart\n\n```bash\nsystemctl restart api\n```\n';
  const signedBy = async (key: string, who: string): Promise<string> => {
    const r = buildManifest(TEXT, { name: 'restart', version: 2, scopes: [], patterns: {} });
    if ('errors' in r) throw new Error(r.errors.join('; '));
    const manifest = formatManifest(r.manifest);
    return withSignature(TEXT, { signer: who, signed: '2026-11-16', manifest, signature: await sshSign(manifest, key, { interactive: false }) });
  };
  /** What run reports and Practice on a Host decide for this text in this file. */
  const decide = async (text: string, file: string): Promise<{ signer?: string; required: boolean; practiceSigned: boolean }> => {
    const got = await signerOf(text, runbookSignerFiles(own, storage, file), (t, f) => runbookSignerCheck(t, f));
    return { ...(got.signer ? { signer: got.signer } : {}), required: reportPlan(text, got.signer)?.required ?? false, practiceSigned: reportTrustProblem(text, got.signer) === undefined };
  };

  before(() => {
    dir = tmp();
    storage = path.join(dir, 'storage');
    libKey = path.join(dir, 'lib');
    ownKey = path.join(dir, 'own');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ana@example.net', '-f', libKey]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'me@example.net', '-f', ownKey]);
    own = path.join(dir, 'allowed_signers');
    fs.writeFileSync(own, `me@example.net namespaces="md-runbook" ${pub(ownKey)}\n`);
    trustLibraryLines(storage, 'https://a.example.net', [`ana@example.net namespaces="md-runbook" ${pub(libKey)}`]);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a key trusted from library A counts for A's copies only; yours counts everywhere", async () => {
    const text = await signedBy(libKey, 'ana@example.net');
    const copyA = libraryCopyFile(storage, A, { path: 'restart.md', fileName: 'restart.md', text });
    const copyB = libraryCopyFile(storage, B, { path: 'restart.md', fileName: 'restart.md', text });
    const elsewhere = path.join(dir, 'restart.md');
    assert.deepEqual(await decide(text, copyA), { signer: 'ana@example.net', required: true, practiceSigned: true });
    assert.deepEqual(await decide(text, copyB), { required: false, practiceSigned: false });
    assert.deepEqual(await decide(text, elsewhere), { required: false, practiceSigned: false });

    const mine = await signedBy(ownKey, 'me@example.net');
    for (const f of [copyA, copyB, elsewhere]) assert.deepEqual(await decide(mine, f), { signer: 'me@example.net', required: true, practiceSigned: true });
  });

  it('a withdrawn key stops counting, and counts again once published again', async () => {
    const text = await signedBy(libKey, 'ana@example.net');
    const copyA = libraryCopyFile(storage, A, { path: 'restart.md', fileName: 'restart.md', text });
    noteWithdrawn(storage, 'https://a.example.net', '');
    assert.deepEqual(await decide(text, copyA), { required: false, practiceSigned: false });
    noteWithdrawn(storage, 'https://a.example.net', `ana@example.net ${pub(libKey)}\n`);
    assert.equal((await decide(text, copyA)).signer, 'ana@example.net');
  });
});

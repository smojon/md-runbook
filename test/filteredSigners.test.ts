/**
 * What ssh-keygen gets (src/filteredSigners.ts): only the lines md-runbook reads, canonical. The
 * review's crafted line shows one key and makes ssh-keygen trust another: with the filter it
 * counts nowhere (VS Code's checks, the command line), and the good lines still do.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runbookSignerCheck, sshSign } from '@md-runbook/core/node';
import { buildManifest, formatManifest, readSignature, withSignature } from '@md-runbook/core/signing';
import { cliSshVerify, cliTrustedRunbookSigner } from '../src/cli/allowedSignersFile';
import { filteredSigners, filteredSignersText } from '../src/filteredSigners';
import { SignerCache, checkSigner } from '../src/signerCheck';

describe('filtered allowed_signers (ssh-keygen)', () => {
  let dir: string;
  let k1: string;
  let k2: string;
  let file: string;
  const pub = (k: string): string => fs.readFileSync(k + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
  const TEXT = '# Restart\n\n```bash\nsystemctl restart api\n```\n';
  const signedBy = async (key: string, who: string): Promise<string> => {
    const r = buildManifest(TEXT, { name: 'restart', version: 2, scopes: [], patterns: {} });
    if ('errors' in r) throw new Error(r.errors.join('; '));
    const manifest = formatManifest(r.manifest);
    return withSignature(TEXT, { signer: who, signed: '2026-11-17', manifest, signature: await sshSign(manifest, key, { interactive: false }) });
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-filtered-'));
    k1 = path.join(dir, 'k1');
    k2 = path.join(dir, 'k2');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'k1', '-f', k1]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'k2', '-f', k2]);
    const key1 = pub(k1).split(' ')[1]!;
    const key2 = pub(k2).split(' ')[1]!;
    file = path.join(dir, 'allowed_signers');
    fs.writeFileSync(
      file,
      [
        '# your own file, with a line an earlier version could have written',
        `alice namespaces="md-runbook,\\" ssh-ed25519 ${key1} x" ssh-ed25519 ${key2}`,
        `bob namespaces="md-runbook" ssh-ed25519 ${key1} laptop`,
        `carol namespaces="git" ssh-ed25519 ${key2}`,
      ].join('\n') + '\n',
    );
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('as written, ssh-keygen trusts K2 for alice (the line shows K1)', async () => {
    assert.equal((await runbookSignerCheck(await signedBy(k2, 'alice'), file)).signer, 'alice');
  });

  it('VS Code: a K2 signature does not verify; the good line (K1) still does', async () => {
    const evil = await signedBy(k2, 'alice');
    const good = await signedBy(k1, 'bob');
    const cache = new SignerCache();
    assert.deepEqual(await cache.signer(evil, file), {});
    assert.deepEqual(await cache.signer(good, file), { signer: 'bob' });
    assert.deepEqual(await checkSigner(evil, file), {});
    assert.deepEqual(await checkSigner(good, file), { signer: 'bob' });
  });

  it('the command line: the same, with one warning per refused line, naming the file given', async () => {
    const warnings: string[] = [];
    const warn = (l: string): void => void warnings.push(l);
    const evil = await signedBy(k2, 'alice');
    const good = await signedBy(k1, 'bob');
    const sig = (t: string): string => readSignature(t)!.signature;
    const manifest = readSignature(good)!.manifest;
    assert.equal(await cliSshVerify(manifest, sig(good), file, undefined, warn), 'bob');
    await assert.rejects(cliSshVerify(manifest, sig(evil), file, undefined, warn), (e: Error) => e.message.includes(file));
    assert.equal(await cliTrustedRunbookSigner(evil, file, warn), undefined);
    assert.equal(await cliTrustedRunbookSigner(good, file, warn), 'bob');
    assert.equal(warnings.length, 1, 'once per file; other namespaces left out quietly');
    assert.match(warnings[0]!, /allowed_signers line 2 not used: a backslash/);
  });

  it('the copy: canonical lines only, private, made again only when the file changes', () => {
    const { text, refused } = filteredSignersText(fs.readFileSync(file, 'utf8'));
    assert.match(text, /^bob namespaces="md-runbook" ssh-ed25519 \S+\n$/);
    assert.deepEqual(
      refused.map((r) => r.line),
      [1, 3],
    );
    const a = filteredSigners(file);
    assert.equal(filteredSigners(file).file, a.file, 'unchanged: the same copy');
    if (process.platform !== 'win32') assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
    fs.appendFileSync(file, '# edited\n');
    assert.notEqual(filteredSigners(file).file, a.file, 'edited: a new copy');
    assert.equal(fs.readFileSync(filteredSigners(file).file, 'utf8'), text);
  });
});

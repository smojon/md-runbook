import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { runbookSignerCheck } from '@md-runbook/core/node';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { SignerCache, SignerCheck } from '../src/signerCheck';

const signedText = (): string => {
  const text = '# Restart\n\n```bash\nsystemctl restart api\n```\n';
  const built = buildManifest(text, { name: 'restart', version: 1, scopes: [], patterns: {} });
  assert.ok(!('errors' in built));
  return withSignature(text, { signer: 'ops@example.net', signed: '2026-11-16', manifest: formatManifest(built.manifest), signature: 'U1NIU0lH' });
};

describe('signer checks', () => {
  it('no ssh-keygen: cantCheck, not "no trusted signer"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-signer-'));
    try {
      const file = path.join(dir, 'allowed_signers');
      fs.writeFileSync(file, '');
      assert.deepEqual(await runbookSignerCheck(signedText(), file, path.join(dir, 'no-such-ssh-keygen')), { cantCheck: true });
      assert.deepEqual(await runbookSignerCheck('# not signed\n', file, path.join(dir, 'no-such-ssh-keygen')), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the cache asks again once the allowed_signers file changes, and never keeps "can\'t check"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-signer-'));
    try {
      const file = path.join(dir, 'allowed_signers');
      fs.writeFileSync(file, '# none yet\n');
      let calls = 0;
      let answer: SignerCheck = {};
      const cache = new SignerCache(async () => {
        calls++;
        return answer;
      });
      assert.deepEqual(await cache.signer('text', file), {});
      assert.deepEqual(await cache.signer('text', file), {});
      assert.equal(calls, 1, 'cached while the file is the same');
      // Trusted Signers… adds a line: the file's size and time change.
      fs.appendFileSync(file, 'ops@example.net namespaces="md-runbook" ssh-ed25519 AAAA\n');
      answer = { signer: 'ops@example.net' };
      assert.deepEqual(await cache.signer('text', file), { signer: 'ops@example.net' });
      assert.equal(calls, 2);
      answer = { cantCheck: true };
      assert.deepEqual(await cache.signer('other text', file), { cantCheck: true });
      assert.deepEqual(await cache.signer('other text', file), { cantCheck: true });
      assert.equal(calls, 4, "can't check is asked again each time");
      cache.clear();
      answer = {};
      assert.deepEqual(await cache.signer('text', file), {});
      assert.equal(calls, 5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

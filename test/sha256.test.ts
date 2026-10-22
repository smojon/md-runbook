import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { sha256Hex } from '@md-runbook/core/sha256';
import { codeHash } from '@md-runbook/core/policy';

const node = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256Hex (the app computes approval hashes without node:crypto)', () => {
  it('matches node:crypto on known vectors, every padding length, and Unicode', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (let n = 0; n < 200; n++) {
      const s = 'x'.repeat(n);
      assert.equal(sha256Hex(s), node(s), `length ${n}`);
    }
    for (const s of ['Grüße 🚀\r\nkubectl get pods', randomBytes(3000).toString('base64'), '\u0000￿']) assert.equal(sha256Hex(s), node(s));
  });

  it('so approval hashes are the same as before the move', () => {
    const code = 'kubectl get pods -n shop\r\n';
    assert.equal(codeHash(code), node(code.replace(/\r\n?/g, '\n')).slice(0, 32));
  });
});

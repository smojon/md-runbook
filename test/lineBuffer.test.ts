import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { LineBuffer } from '@md-runbook/core';

it('LineBuffer passes whole lines to the transform', () => {
  const seen: string[] = [];
  const b = new LineBuffer((t) => seen.push(t), (t) => t.replace(/secret=\S+/g, 'secret=X'));
  b.write('a secr');
  b.write('et=abc');
  b.write('def\nnext ');
  b.write('line');
  b.flush();
  assert.deepEqual(seen, ['a secret=X\n', 'next line']);
});

it('LineBuffer flushes very long partial lines', () => {
  const seen: string[] = [];
  const b = new LineBuffer((t) => seen.push(t), undefined, 4);
  b.write('abcdef');
  assert.deepEqual(seen, ['abcdef']);
});

it('LineBuffer holds a private-key block until its END line, so it is redacted whole', async () => {
  const { createRedactor, DEFAULT_PATTERNS } = await import('@md-runbook/core');
  const r = createRedactor(DEFAULT_PATTERNS);
  const seen: string[] = [];
  const b = new LineBuffer((t) => seen.push(t), (t) => r.redact(t));
  b.write('before\n-----BEGIN RSA PRIVATE KEY-----\nAAA\n');
  b.write('BBB\nCCC\n');
  b.write('-----END RSA PRIVATE KEY-----\nafter\n');
  b.flush();
  const all = seen.join('');
  assert.doesNotMatch(all, /AAA|BBB|CCC/);
  assert.match(all, /before\n-----BEGIN RSA PRIVATE KEY-----\[REDACTED\]-----END RSA PRIVATE KEY-----\nafter\n/);
});

it('LineBuffer cuts an over-long line at whitespace, not inside a token', () => {
  const seen: string[] = [];
  const b = new LineBuffer((t) => seen.push(t), (t) => t.replace(/password=\S+/g, 'password=X'), 20);
  b.write('aaaa bbbb password=secret-continued-value');
  b.flush();
  assert.equal(seen.join(''), 'aaaa bbbb password=X');
});

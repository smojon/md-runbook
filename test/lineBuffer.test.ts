import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { LineBuffer } from '../src/core';

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

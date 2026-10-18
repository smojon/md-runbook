import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { copyOrigin, setCopyOrigin } from '../src/copyOrigins';

describe('copy origins', () => {
  it('maps a copy made elsewhere to the original folder', () => {
    const copy = { toString: () => 'file:///w/runs/book.20261018-142000.md' };
    assert.equal(copyOrigin(copy), undefined);
    setCopyOrigin(copy, '/w');
    assert.equal(copyOrigin({ toString: () => 'file:///w/runs/book.20261018-142000.md' }), '/w');
    assert.equal(copyOrigin({ toString: () => 'file:///w/book.md' }), undefined);
  });
});

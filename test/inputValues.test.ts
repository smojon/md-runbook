/** VS Code's session inputs (src/inputValues.ts): a name once secret stays secret (security review, round 4). */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { InputValues } from '../src/inputValues';

describe('session inputs: the secret flag sticks to the name', () => {
  it('${input:DB:secret}, then ${input:DB}: still secret', () => {
    const v = new InputValues();
    v.set('DB', 'hunter2', true);
    v.set('DB', 'hunter2', false);
    assert.deepEqual([v.get('DB'), v.isSecret('DB')], ['hunter2', true]);
  });

  it('${input:DB} asked first, then used as a secret: secret from then on', () => {
    const v = new InputValues();
    v.set('DB', 'x', false);
    assert.equal(v.isSecret('DB'), false);
    v.markSecret('DB');
    assert.equal(v.isSecret('DB'), true);
    v.set('DB', 'y', false);
    assert.deepEqual([v.get('DB'), v.isSecret('DB')], ['y', true]);
  });

  it('other names and unknown names are not secret', () => {
    const v = new InputValues();
    v.set('A', '1', true);
    v.markSecret('NONE');
    assert.deepEqual([v.isSecret('B'), v.get('NONE'), v.isSecret('NONE')], [false, undefined, false]);
  });
});

/** Values from the test-only commands (src/testValues.ts): refused outside the test runner. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { testOnlyValues } from '../src/testValues';

describe('test-only values', () => {
  it('are refused outside test mode', () => {
    assert.throws(() => testOnlyValues({ ENV: 'prod' }, false), /only by the extension test runner/);
  });

  it('in test mode: names and string values only', () => {
    assert.deepEqual(testOnlyValues({ ENV: 'prod', 'bad name': 'x', N: 1 }, true), { ENV: 'prod' });
    assert.throws(() => testOnlyValues(['ENV=prod'], true), /expected/);
  });

  it('the public Set Parameters / Set Inputs commands pass no arguments on', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'secrets.ts'), 'utf8');
    assert.match(src, /registerCommand\('mdRunbook\.setParameters', \(\) => f\.setParameters\(\)\)/);
    assert.match(src, /registerCommand\('mdRunbook\.setInputs', \(\) => f\.setInputs\(\)\)/);
    assert.doesNotMatch(src, /async setParameters\(values|async setInputs\(values/);
  });
});

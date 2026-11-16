/** List settings a workspace may add to but not shorten (src/listSetting.ts). */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { joinedLevels } from '../src/listSetting';

const isString = (v: unknown): v is string => typeof v === 'string';

describe('list settings: yours and the workspace\'s', () => {
  it('a workspace setting [] does not drop the user\'s items', () => {
    assert.deepEqual(joinedLevels({ globalValue: ['acme', 'corp\\.example'], workspaceValue: [] }, isString), ['acme', 'corp\\.example']);
  });

  it('joins the levels in order, each item once, and skips what is not an item', () => {
    assert.deepEqual(
      joinedLevels({ globalValue: ['a', 'b'], workspaceValue: ['b', 'c', 3], workspaceFolderValue: ['d'] }, isString),
      ['a', 'b', 'c', 'd'],
    );
    assert.deepEqual(joinedLevels({ globalValue: 'not a list', workspaceValue: [{ pattern: 'x' }, { pattern: 'x' }] }, (v): v is object => typeof v === 'object' && v !== null), [{ pattern: 'x' }]);
    assert.deepEqual(joinedLevels(undefined, isString), []);
  });
});

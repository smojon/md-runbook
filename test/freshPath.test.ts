import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { expandWindowsVars, freshenPath, mergePath, parseRegQuery, registryPath } from '@md-runbook/core/node';

describe('fresh PATH on Windows', () => {
  it('reads the Path value of reg query, plain or expandable', () => {
    const machine = [
      '',
      'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files\\Git\\cmd',
      '',
    ].join('\r\n');
    assert.equal(parseRegQuery(machine), '%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd');
    assert.equal(parseRegQuery('    Path    REG_SZ    C:\\tools\r\n'), 'C:\\tools');
    assert.equal(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.'), '');
  });

  it('expands %NAME% case-insensitively and keeps unknown references', () => {
    const env = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' };
    assert.equal(expandWindowsVars('%SYSTEMROOT%\\system32;%userprofile%\\bin', env), 'C:\\Windows\\system32;C:\\Users\\me\\bin');
    assert.equal(expandWindowsVars('%NOPE%\\x', env), '%NOPE%\\x');
  });

  it('appends only new directories, keeping the inherited order', () => {
    const current = 'C:\\venv\\Scripts;C:\\Windows\\system32;C:\\Program Files\\Git\\cmd\\';
    const fresh = ['C:\\Windows\\System32', 'c:\\program files\\git\\cmd', 'C:\\Users\\me\\.local\\bin', 'C:\\Users\\me\\.local\\bin\\'];
    assert.equal(mergePath(current, fresh), current.replace(/;+$/, '') + ';C:\\Users\\me\\.local\\bin');
    assert.equal(mergePath(current, ['C:\\Windows\\system32']), current, 'unchanged when nothing is new');
    assert.equal(mergePath('', ['C:\\a']), 'C:\\a');
  });

  it('reads the registry once per few seconds, both keys together, and expands for each cell', async () => {
    const asked: string[] = [];
    const query = async (key: string): Promise<string> => {
      asked.push(key);
      return key.startsWith('HKLM') ? '    Path    REG_EXPAND_SZ    %SystemRoot%\\system32\r\n' : '    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin\r\n';
    };
    const t0 = 1_000_000;
    assert.deepEqual(await registryPath({ SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a' }, t0, query), ['C:\\Windows\\system32', 'C:\\Users\\a\\bin']);
    assert.equal(asked.length, 2, 'Machine and User, one query each');
    // Within the cache window: no new query, but expanded with this cell's environment.
    assert.deepEqual(await registryPath({ SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\b' }, t0 + 1000, query), ['C:\\Windows\\system32', 'C:\\Users\\b\\bin']);
    assert.equal(asked.length, 2);
    await registryPath({ SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\b' }, t0 + 3000, query);
    assert.equal(asked.length, 4, 'read again after the cache window');
  });

  it('updates the PATH key in whatever case the env object has, on Windows only', async () => {
    const read = async (): Promise<string[]> => ['C:\\new'];
    const win: NodeJS.ProcessEnv = { Path: 'C:\\old' };
    await freshenPath(win, 'win32', read);
    assert.deepEqual(win, { Path: 'C:\\old;C:\\new' });

    const linux: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    await freshenPath(linux, 'linux', read);
    assert.deepEqual(linux, { PATH: '/usr/bin' }, 'no registry outside Windows');
  });
});

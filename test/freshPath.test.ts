import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { expandWindowsVars, freshenPath, mergePath, parseRegQuery } from '@md-runbook/core/node';

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

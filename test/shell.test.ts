import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ShellEnv, resolveShell, shellKindForLanguage } from '../src/core';

function fakeEnv(platform: NodeJS.Platform, files: string[], env: Record<string, string> = {}, path: Record<string, string> = {}): ShellEnv {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform,
    env,
    exists: (f) => set.has(f.toLowerCase()),
    which: (c) => path[c],
  };
}

const WIN_ENV = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

describe('shellKindForLanguage', () => {
  it('maps fence languages and VS Code ids', () => {
    assert.equal(shellKindForLanguage('sh'), 'bash');
    assert.equal(shellKindForLanguage('bash'), 'bash');
    assert.equal(shellKindForLanguage('shellscript'), 'bash');
    assert.equal(shellKindForLanguage('pwsh'), 'pwsh');
    assert.equal(shellKindForLanguage('PowerShell'), 'pwsh');
    assert.equal(shellKindForLanguage('cmd'), 'cmd');
    assert.equal(shellKindForLanguage('bat'), 'cmd');
    assert.equal(shellKindForLanguage('python'), undefined);
  });
});

describe('PowerShell resolution', () => {
  it('prefers pwsh on PATH', () => {
    const r = resolveShell('pwsh', {}, fakeEnv('win32', [], WIN_ENV, { pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'powershell.exe': 'C:\\x\\powershell.exe' }));
    assert.ok(r.ok);
    assert.equal(r.shell.command, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    assert.equal(r.shell.label, 'pwsh');
    const args = r.shell.args('C:\\Temp\\it\'s\\cell.ps1');
    assert.deepEqual(args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    assert.match(args[6]!, /& 'C:\\Temp\\it''s\\cell\.ps1'/);
  });

  it('falls back to Windows PowerShell', () => {
    const builtin = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const r = resolveShell('pwsh', {}, fakeEnv('win32', [builtin], WIN_ENV));
    assert.ok(r.ok);
    assert.equal(r.shell.command, builtin);
    assert.equal(r.shell.label, 'powershell');
  });

  it('honours the configured path', () => {
    const r = resolveShell('pwsh', { pwshPath: 'D:\\tools\\pwsh.exe' }, fakeEnv('win32', [], WIN_ENV, { pwsh: 'C:\\other\\pwsh.exe' }));
    assert.ok(r.ok);
    assert.equal(r.shell.command, 'D:\\tools\\pwsh.exe');
  });

  it('no ExecutionPolicy flag off Windows; reports a missing shell', () => {
    const r = resolveShell('pwsh', {}, fakeEnv('linux', [], {}, { pwsh: '/usr/bin/pwsh' }));
    assert.ok(r.ok);
    assert.ok(!r.shell.args('/tmp/x.ps1').includes('-ExecutionPolicy'));
    const missing = resolveShell('pwsh', {}, fakeEnv('darwin', []));
    assert.ok(!missing.ok);
    assert.match(missing.error, /pwshPath/);
  });

  it('writes the script with a BOM and platform line endings', () => {
    const win = resolveShell('pwsh', {}, fakeEnv('win32', [], WIN_ENV, { pwsh: 'pwsh.exe' }));
    assert.ok(win.ok);
    assert.equal(win.shell.script('a\nb'), '\uFEFFa\r\nb\r\n');
  });
});

describe('cmd resolution', () => {
  it('uses ComSpec with verbatim quoting so paths with spaces work', () => {
    const r = resolveShell('cmd', {}, fakeEnv('win32', [], WIN_ENV));
    assert.ok(r.ok);
    assert.equal(r.shell.command, 'C:\\Windows\\system32\\cmd.exe');
    assert.equal(r.shell.windowsVerbatimArguments, true);
    assert.deepEqual(r.shell.args('C:\\Users\\A B\\cell.cmd'), ['/d', '/s', '/c', '""C:\\Users\\A B\\cell.cmd""']);
    assert.equal(r.shell.script('echo a\necho b'), '@echo off\r\n@chcp 65001 >nul\r\necho a\r\necho b\r\n');
  });

  it('is unavailable off Windows', () => {
    const r = resolveShell('cmd', {}, fakeEnv('linux', []));
    assert.ok(!r.ok);
  });
});

describe('bash resolution', () => {
  it('finds Git Bash under Program Files', () => {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const r = resolveShell('bash', {}, fakeEnv('win32', [gitBash], WIN_ENV));
    assert.ok(r.ok);
    assert.equal(r.shell.command, gitBash);
    assert.deepEqual(r.shell.args('C:\\Temp\\x\\cell.sh'), ['C:/Temp/x/cell.sh']);
  });

  it('finds Git Bash next to git.exe on PATH', () => {
    const gitBash = 'D:\\PortableGit\\bin\\bash.exe';
    const r = resolveShell('bash', {}, fakeEnv('win32', [gitBash], WIN_ENV, { 'git.exe': 'D:\\PortableGit\\cmd\\git.exe' }));
    assert.ok(r.ok);
    assert.equal(r.shell.command, gitBash);
  });

  it('never picks the WSL launcher', () => {
    const r = resolveShell('bash', {}, fakeEnv('win32', [], WIN_ENV, { 'bash.exe': 'C:\\Windows\\System32\\bash.exe' }));
    assert.ok(!r.ok);
    assert.match(r.error, /Git Bash not found/);
  });

  it('honours the configured path on Windows', () => {
    const r = resolveShell('bash', { bashPath: 'E:\\msys64\\usr\\bin\\bash.exe' }, fakeEnv('win32', [], WIN_ENV));
    assert.ok(r.ok);
    assert.equal(r.shell.command, 'E:\\msys64\\usr\\bin\\bash.exe');
  });

  it('uses bash, then sh, on Unix', () => {
    const r = resolveShell('bash', {}, fakeEnv('linux', [], {}, { bash: '/bin/bash', sh: '/bin/sh' }));
    assert.ok(r.ok);
    assert.equal(r.shell.command, '/bin/bash');
    const sh = resolveShell('bash', {}, fakeEnv('linux', [], {}, { sh: '/bin/sh' }));
    assert.ok(sh.ok);
    assert.equal(sh.shell.label, 'sh');
  });

  it('writes LF scripts even from CRLF source', () => {
    const r = resolveShell('bash', {}, fakeEnv('darwin', [], {}, { bash: '/bin/bash' }));
    assert.ok(r.ok);
    assert.equal(r.shell.script('a\r\nb'), 'a\nb\n');
  });
});

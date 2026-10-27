import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TerminalOutputFilter, quotePwsh, quoteSh, terminalCmdCommandLine, terminalCommandLine, terminalInlineCommandLine, terminalShowCommand, terminalShownText, terminalSignature } from '@md-runbook/core/terminalCommand';

it('quotes script paths for bash and PowerShell', () => {
  assert.equal(quoteSh("/tmp/it's here/cell.sh"), `'/tmp/it'\\''s here/cell.sh'`);
  assert.equal(quotePwsh("C:\\Temp\\it's\\cell.ps1"), "'C:\\Temp\\it''s\\cell.ps1'");
  // Typographic single quotes are quotes to PowerShell too.
  assert.equal(quotePwsh('x\u2019; calc; \u2018\u201A\u201B'), "'x\u2019\u2019; calc; \u2018\u2018\u201A\u201A\u201B\u201B'");
});

it('runs bash cells with the resolved bash, not the one on PATH', () => {
  assert.equal(
    terminalCommandLine('bash', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:/Users/A B/cell.sh', 'C:/T/status', 'win32'),
    "'C:/Program Files/Git/bin/bash.exe' 'C:/Users/A B/cell.sh'; printf '%s' $? > 'C:/T/status'; sleep 0.5",
  );
  assert.match(terminalCommandLine('bash', "/opt/my bash/it's/bash", '/tmp/c.sh', '/tmp/s', 'linux'), /^'\/opt\/my bash\/it'\\''s\/bash' '\/tmp\/c\.sh'; /);
});

it('runs PowerShell cells in a child process (no -NonInteractive; Bypass on Windows)', () => {
  const win = terminalCommandLine('pwsh', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', "C:\\Users\\A B\\it's\\cell.ps1", 'C:\\T\\status', 'win32');
  assert.match(win, /^\$global:LASTEXITCODE = 0; & 'C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe' -NoLogo -NoProfile -ExecutionPolicy Bypass -Command '/);
  // The script path is quoted twice: once inside the wrapper, once for the -Command argument.
  assert.ok(win.includes("& ''C:\\Users\\A B\\it''''s\\cell.ps1''"), win);
  assert.match(win, /Set-Content -NoNewline -Path 'C:\\T\\status'/);
  assert.doesNotMatch(win, /NonInteractive/);
  const linux = terminalCommandLine('pwsh', '/usr/bin/pwsh', '/tmp/c.ps1', '/tmp/s', 'linux');
  assert.doesNotMatch(linux, /ExecutionPolicy/);
  assert.doesNotMatch(linux, /\\"/);
});

it('descendants walks the process tree from ps output', async () => {
  const { descendants } = await import('@md-runbook/core/terminalCommand');
  const ps = '  1     0\n 10     1\n 11    10\n 12    10\n 13    11\n 20     1\n bad line\n';
  assert.deepEqual(descendants(ps, 10), [11, 12, 13]);
  assert.deepEqual(descendants(ps, 13), []);
});

it('terminal signature changes with cwd or env, not with key order', () => {
  const a = terminalSignature('bash', '/bin/bash', '/x', { A: '1', B: '2' });
  assert.equal(a, terminalSignature('bash', '/bin/bash', '/x', { B: '2', A: '1' }));
  assert.notEqual(a, terminalSignature('bash', '/bin/bash', '/y', { A: '1', B: '2' }));
  assert.notEqual(a, terminalSignature('bash', '/bin/bash', '/x', { A: '1', B: '3' }));
});

it('parses the terminal cell option', () => {
  assert.equal(parseCellOptions('bash terminal timeout=30').terminal, true);
  assert.equal(parseCellOptions('bash timeout=30').terminal, undefined);
});

it('TerminalOutputFilter drops the prompt/command echo and shell integration marks', async () => {
  const { TerminalOutputFilter } = await import('@md-runbook/core/terminalCommand');
  const f = new TerminalOutputFilter();
  const raw = "'\n\x1b]633;E;bash '/tmp/x.sh';nonce\x07\x1b]633;C\x07Name: bob\r\nhello bob\r\n\x1b]633;D;0\x07";
  // Split at awkward places, including inside the escape sequences.
  const chunks = [raw.slice(0, 10), raw.slice(10, 40), raw.slice(40, 47), raw.slice(47, 60), raw.slice(60)];
  const out = chunks.map((c) => f.push(c)).join('') + f.flush();
  assert.equal(out, 'Name: bob\r\nhello bob\r\n');
});

it('TerminalOutputFilter also drops window titles', async () => {
  const { TerminalOutputFilter } = await import('@md-runbook/core/terminalCommand');
  const f = new TerminalOutputFilter();
  const raw = '\x1b]633;C\x07PowerShell 5.1\r\n\x1b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x07done\r\n';
  const out = [raw.slice(0, 30), raw.slice(30, 50), raw.slice(50)].map((c) => f.push(c)).join('') + f.flush();
  assert.equal(out, 'PowerShell 5.1\r\ndone\r\n');
});

it('parseStatus reads the written exit code', async () => {
  const { parseStatus } = await import('@md-runbook/core/terminalCommand');
  assert.equal(parseStatus('3'), 3);
  assert.equal(parseStatus(' 0\r\n'), 0);
  assert.equal(parseStatus(''), undefined);
  assert.equal(parseStatus(undefined), undefined);
  assert.equal(parseStatus('x'), undefined);
});

describe('terminalInlineCommandLine', () => {
  it('bash sources the script in the terminal shell and records $?', () => {
    assert.equal(
      terminalInlineCommandLine('bash', "/tmp/it's.sh", '/tmp/status'),
      `. '/tmp/it'\\''s.sh'; printf '%s' $? > '/tmp/status'; sleep 0.5`,
    );
  });

  it('PowerShell dot-sources the text as a script block (no execution policy) and uses the normal exit rules', () => {
    const line = terminalInlineCommandLine('pwsh', '/t/cell.ps1', '/t/status');
    assert.ok(line.startsWith("$global:LASTEXITCODE = 0; . ([scriptblock]::Create([System.IO.File]::ReadAllText('/t/cell.ps1')));"), line);
    assert.ok(line.includes("Set-Content -NoNewline -Path '/t/status' -Value $(if ($LASTEXITCODE)"), line);
    assert.doesNotMatch(line, /-Command|-ExecutionPolicy/);
  });
});

it('runs cmd cells from a PowerShell terminal, in a cmd.exe of their own, and records the exit code', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdrb term it's "));
  try {
    const script = path.join(dir, 'cell.cmd');
    const status = path.join(dir, 'status');
    fs.writeFileSync(script, '@echo off\r\necho from cmd\r\nexit /b 3\r\n');
    const line = terminalCmdCommandLine(process.env.ComSpec ?? 'C:\Windows\System32\cmd.exe', script, status);
    assert.match(line, /^\$global:LASTEXITCODE = 0; & '.*cmd\.exe' \/d \/c '.*it''s .*cell\.cmd'; Set-Content -NoNewline -Path '/);
    // What a PowerShell terminal does with the typed line.
    const r = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', line], { encoding: 'utf8' });
    assert.match(r.stdout, /from cmd/);
    assert.equal(fs.readFileSync(status, 'utf8'), '3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('the cell shown in the terminal', () => {
  const C = '\x1b]633;C\x07';
  const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('shows each line at a prompt, continued lines at the continuation prompt, without control characters', async () => {
    const { terminalShownText } = await import('@md-runbook/core/terminalCommand');
    const bash = terminalShownText('echo one \\\n  two\necho ${secret:TOKEN}\x1b]0;x\x07\n\n', 'bash', 'n1');
    assert.ok(bash.startsWith('\x1b]633;P;MdRunbookShownStart=n1\x07'), bash);
    assert.ok(bash.endsWith('\x1b]633;P;MdRunbookShownEnd=n1\x07'), bash);
    const lines = plain(bash.replace(/\x1b\]633;P;[^\x07]*\x07/g, '')).split('\r\n');
    // The reference is shown, never a value; the stray OSC loses its ESC and BEL, so it can't act.
    assert.deepEqual(lines, ['$ echo one \\','>   two', '$ echo ${secret:TOKEN}]0;x', '']);
    assert.match(plain(terminalShownText('Write-Output a `\n  b', 'pwsh', 'n')), /PS> Write-Output a `\r\n>>   b\r\n/);
    assert.match(plain(terminalShownText('echo a', 'cmd', 'n')), /> echo a\r\n/);
  });

  it('TerminalOutputFilter drops the shown cell, also split across chunks, and keeps the output', async () => {
    const { TerminalOutputFilter, terminalShownText } = await import('@md-runbook/core/terminalCommand');
    const raw = `prompt$ cat shown; bash cell.sh\r\n${C}\x1b[?25l${terminalShownText('echo ready', 'bash', 'abc')}The service is ready\r\n`;
    for (const size of [1, 7, 64, raw.length]) {
      const f = new TerminalOutputFilter('abc');
      let out = '';
      for (let i = 0; i < raw.length; i += size) out += f.push(raw.slice(i, i + size));
      out += f.flush();
      assert.equal(out, 'The service is ready\r\n', `chunks of ${size}`);
    }
  });

  it('TerminalOutputFilter keeps the output when the shown cell never comes, or comes with another nonce', async () => {
    const { TerminalOutputFilter, terminalShownText } = await import('@md-runbook/core/terminalCommand');
    const short = new TerminalOutputFilter('abc');
    assert.equal(short.push(`${C}hello\r\n`) + short.flush(), 'hello\r\n');
    const long = new TerminalOutputFilter('abc');
    const big = 'x'.repeat(5000);
    assert.equal(long.push(`${C}${big}`), big, 'held back no longer than the first few KB');
    const other = new TerminalOutputFilter('abc');
    const out = other.push(`${C}${terminalShownText('echo hi', 'bash', 'zzz')}hi\r\n`) + other.flush();
    assert.match(out, /\$ .*echo hi/, 'a mark with another nonce is not this run');
  });

  it('bash prints the shown cell before the script runs; the filter leaves only the script output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdrb shown it's "));
    try {
      const shown = path.join(dir, 'shown');
      fs.writeFileSync(shown, terminalShownText('echo "The service is ready"', 'bash', 'n0nce'), 'utf8');
      const toArg = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
      const r = spawnSync('bash', ['-c', `${terminalShowCommand('bash', toArg(shown))}echo "The service is ready"`], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /\$ .*echo "The service is ready"/);
      const f = new TerminalOutputFilter('n0nce');
      assert.equal(f.push(C + r.stdout) + f.flush(), 'The service is ready\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PowerShell prints the shown cell before the script runs', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdrb shown it's "));
    try {
      const shown = path.join(dir, 'shown');
      fs.writeFileSync(shown, terminalShownText("Write-Output 'ready'", 'pwsh', 'n0nce'), 'utf8');
      const r = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-Command', `${terminalShowCommand('pwsh', shown)}Write-Output 'ready'`], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /PS> .*Write-Output 'ready'/);
      const f = new TerminalOutputFilter('n0nce');
      assert.equal((f.push(C + r.stdout) + f.flush()).trim(), 'ready');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

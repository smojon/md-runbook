import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { quotePwsh, quoteSh, terminalCommandLine, terminalInlineCommandLine, terminalSignature } from '@md-runbook/core/terminalCommand';

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

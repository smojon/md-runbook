import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { parseCellOptions } from '../src/core/cellOptions';
import { quotePwsh, quoteSh, terminalCommandLine, terminalSignature } from '../src/core/terminalCommand';

it('quotes script paths for bash and PowerShell', () => {
  assert.equal(quoteSh("/tmp/it's here/cell.sh"), `'/tmp/it'\\''s here/cell.sh'`);
  assert.equal(quotePwsh("C:\\Temp\\it's\\cell.ps1"), "'C:\\Temp\\it''s\\cell.ps1'");
  assert.equal(terminalCommandLine('bash', 'C:/Users/A B/cell.sh', 'C:/T/status'), "bash 'C:/Users/A B/cell.sh'; printf '%s' $? > 'C:/T/status'; sleep 0.5");
  assert.match(terminalCommandLine('pwsh', 'C:\\Users\\A B\\cell.ps1', 'C:\\T\\status'), /^\$global:LASTEXITCODE = 0; & 'C:\\Users\\A B\\cell\.ps1'; .*Set-Content -NoNewline -Path 'C:\\T\\status'/);
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
  const { TerminalOutputFilter } = await import('../src/core/terminalCommand');
  const f = new TerminalOutputFilter();
  const raw = "'\n\x1b]633;E;bash '/tmp/x.sh';nonce\x07\x1b]633;C\x07Name: bob\r\nhello bob\r\n\x1b]633;D;0\x07";
  // Split at awkward places, including inside the escape sequences.
  const chunks = [raw.slice(0, 10), raw.slice(10, 40), raw.slice(40, 47), raw.slice(47, 60), raw.slice(60)];
  const out = chunks.map((c) => f.push(c)).join('') + f.flush();
  assert.equal(out, 'Name: bob\r\nhello bob\r\n');
});

it('parseStatus reads the written exit code', async () => {
  const { parseStatus } = await import('../src/core/terminalCommand');
  assert.equal(parseStatus('3'), 3);
  assert.equal(parseStatus(' 0\r\n'), 0);
  assert.equal(parseStatus(''), undefined);
  assert.equal(parseStatus(undefined), undefined);
  assert.equal(parseStatus('x'), undefined);
});

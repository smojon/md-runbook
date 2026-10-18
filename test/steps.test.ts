import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { echoCommand, formatLineRange, splitSteps, stepAtLine } from '../src/core/steps';
import type { ShellKind } from '../src/core';

const texts = (src: string, kind: ShellKind): string[] => splitSteps(src, kind).map((s) => s.text);
const ranges = (src: string, kind: ShellKind): [number, number][] => splitSteps(src, kind).map((s) => [s.start, s.end]);

describe('splitSteps: bash', () => {
  it('one command per line, skipping blanks and comments', () => {
    assert.deepEqual(ranges('echo a\n\n# note\necho b  # trailing\n', 'bash'), [
      [0, 0],
      [3, 3],
    ]);
  });

  it('keeps continuations, trailing pipes and && with their line', () => {
    const src = 'kubectl get pods \\\n  -n kube-system\nls |\n  wc -l\ntrue &&\n  echo ok\necho done';
    assert.deepEqual(texts(src, 'bash'), ['kubectl get pods \\\n  -n kube-system', 'ls |\n  wc -l', 'true &&\n  echo ok', 'echo done']);
  });

  it('keeps blocks together', () => {
    const src = [
      'for i in 1 2; do',
      '  echo "$i"',
      'done',
      'if [ -f x ]',
      'then',
      '  echo yes',
      'else',
      '  echo no',
      'fi',
      'case "$1" in',
      '  a) echo a ;;',
      '  (b) echo b ;;',
      'esac',
      'f() {',
      '  echo in f',
      '}',
      'while read -r l; do echo "$l"; done < file',
      'echo done',
    ].join('\n');
    assert.deepEqual(ranges(src, 'bash'), [
      [0, 2],
      [3, 8],
      [9, 12],
      [13, 15],
      [16, 16],
      [17, 17],
    ]);
  });

  it('keeps multi-line quotes and here-docs together', () => {
    const src = "echo 'one\ntwo'\ncat <<EOF\n$HOME\necho not a command\nEOF\ncat <<-'END' | wc -l\n\tx\n\tEND\necho \"a\nb\"\necho last";
    assert.deepEqual(ranges(src, 'bash'), [
      [0, 1],
      [2, 5],
      [6, 8],
      [9, 10],
      [11, 11],
    ]);
  });

  it('does not treat words that look like keywords as keywords', () => {
    assert.deepEqual(ranges('echo done\necho if\ngrep -c fi file\necho $#\necho {a,b}', 'bash'), [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
  });

  it('an unclosed command runs to the end, without trailing blank lines', () => {
    assert.deepEqual(ranges('echo a\nif true; then\n  echo b\n\n', 'bash'), [
      [0, 0],
      [1, 2],
    ]);
  });

  it('keeps CRLF inside a command and drops the final line ending', () => {
    assert.deepEqual(texts('ls \\\r\n  -la\r\necho x\r\n', 'bash'), ['ls \\\r\n  -la', 'echo x']);
  });
});

describe('splitSteps: PowerShell', () => {
  it('backtick continuations, pipes and leading pipes', () => {
    const src = 'Get-ChildItem `\n  -Recurse\nGet-Process |\n  Select-Object -First 3\nGet-Service\n  | Where-Object Status -eq Running\nGet-Date';
    assert.deepEqual(ranges(src, 'pwsh'), [
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 6],
    ]);
  });

  it('script blocks, hashtables and else on the next line', () => {
    const src = [
      'foreach ($i in 1..2) {',
      '  "item $i"',
      '}',
      'if ($x) {',
      '  1',
      '}',
      'else {',
      '  2',
      '}',
      '$h = @{',
      '  a = 1',
      '}',
      'try { throw "x" }',
      'catch { "caught" }',
      '$v =',
      '  42',
    ].join('\n');
    assert.deepEqual(ranges(src, 'pwsh'), [
      [0, 2],
      [3, 8],
      [9, 11],
      [12, 13],
      [14, 15],
    ]);
  });

  it('here-strings, comments and block comments', () => {
    const src = "# comment\n<#\n  block\n#>\n$s = @'\nnot { a block\n'@\nWrite-Output 'it''s ( fine'\n\"a `\" ( b\"";
    assert.deepEqual(ranges(src, 'pwsh'), [
      [4, 6],
      [7, 7],
      [8, 8],
    ]);
  });
});

describe('splitSteps: cmd', () => {
  it('caret continuations, parenthesized blocks, rem and labels', () => {
    const src = 'rem setup\n@echo off\ndir ^\n  /b\nif exist x (\n  echo yes\n) else (\n  echo no\n)\n:: note\n:label\necho "(" done';
    assert.deepEqual(ranges(src, 'cmd'), [
      [1, 1],
      [2, 3],
      [4, 8],
      [11, 11],
    ]);
  });
});

describe('step helpers', () => {
  it('stepAtLine finds the command a line belongs to', () => {
    const steps = splitSteps('echo a\nfor i in 1; do\n  echo $i\ndone\n\n# c', 'bash');
    assert.equal(stepAtLine(steps, 2)?.start, 1);
    assert.equal(stepAtLine(steps, 0)?.text, 'echo a');
    assert.equal(stepAtLine(steps, 4), undefined);
    assert.equal(stepAtLine(steps, 5), undefined);
  });

  it('formatLineRange is 1-based', () => {
    assert.equal(formatLineRange(2, 2), '3');
    assert.equal(formatLineRange(0, 4), '1-5');
  });

  it('echoCommand shows a prompt and indents continuation lines', () => {
    assert.equal(echoCommand('bash', 'ls \\\n  -la'), '$ ls \\\n    -la\n');
    assert.equal(echoCommand('pwsh', 'Get-Date'), 'PS> Get-Date\n');
    assert.equal(echoCommand('cmd', 'dir'), '> dir\n');
  });
});

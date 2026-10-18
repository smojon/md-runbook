import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parse } from '../src/core';
import { listFixtures, readFixture, roundTrip, roundTripBytes, show } from './helpers';

describe('byte-identical round trip of fixtures', () => {
  const fixtures = listFixtures();
  it('has fixtures', () => assert.ok(fixtures.length >= 15));
  for (const name of fixtures) {
    it(name, () => {
      const input = readFixture(name);
      const output = roundTripBytes(input);
      assert.ok(Buffer.from(output).equals(Buffer.from(input)), `${name} changed:\n${show(Buffer.from(output).toString())}`);
    });
  }
});

describe('round trip of inline edge cases', () => {
  const cases: Record<string, string> = {
    'empty': '',
    'single newline': '\n',
    'only CRLF': '\r\n\r\n',
    'lone CR text': 'a\rb\r',
    'fence at EOF, no newline after close': '```sh\necho\n```',
    'empty code block': '```sh\n```\n',
    'empty code block CRLF': '```sh\r\n```\r\n',
    'code then output at EOF no newline': '```sh\nx\n```\n<!-- md-runbook:output start exit=0 -->\n```text\n```\n<!-- md-runbook:output end -->',
    'trailing spaces on fences': '```sh   \necho\n```   \n',
    'close fence longer than open': '```sh\necho\n`````\n',
    'indented closing fence': '```sh\necho\n   ```\n',
    'info with braces': '```bash {cmd=true}\necho\n```\n',
    'pandoc style is not runnable': '```{.bash}\necho\n```\n',
    'heading right before fence': '# H\n```sh\necho\n```\n# H2\n',
    'two outputs in a row (second is markdown)':
      '```sh\na\n```\n<!-- md-runbook:output start -->\n```text\n```\n<!-- md-runbook:output end -->\n<!-- md-runbook:output start -->\n```text\n```\n<!-- md-runbook:output end -->\n',
    'start marker without fence': '```sh\na\n```\n<!-- md-runbook:output start -->\ntext\n',
    'unclosed output fence': '```sh\na\n```\n<!-- md-runbook:output start -->\n```text\nno close\n',
    'whitespace lines with tabs and spaces': ' \t \n```sh\n \t\n```\n\t\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => assert.equal(roundTrip(text), text));
  }
});

describe('cell structure', () => {
  const decode = (name: string) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(readFixture(name));

  it('basic.md: shell fences become code cells, json stays markdown', () => {
    const doc = parse(decode('basic.md'));
    const code = doc.cells.filter((c) => c.kind === 'code');
    assert.deepEqual(
      code.map((c) => c.languageId),
      ['shellscript', 'powershell', 'bat', 'shellscript'],
    );
    assert.equal(code[0]!.value, 'oc whoami\noc get pods -n iam');
    const markup = doc.cells.filter((c) => c.kind === 'markup');
    assert.ok(markup.some((c) => c.value.includes('```json')));
    // Leading/trailing blank lines are not part of a markup cell's value.
    for (const c of markup) assert.ok(!/^\n|\n$/.test(c.value), show(c.value));
  });

  it('outputs.md: output blocks become outputs, not cells', () => {
    const doc = parse(decode('outputs.md'));
    const code = doc.cells.filter((c) => c.kind === 'code');
    assert.equal(code.length, 5);
    assert.deepEqual(code[0]!.output, { text: 'hello', attrs: { exit: '0', ran: '2026-10-18T14:20:00+02:00' } });
    assert.deepEqual(code[1]!.output, { text: '', attrs: { exit: '1', ran: '2026-10-18T14:21:00+02:00' } });
    assert.equal(code[2]!.output!.text, '```\ncode\n```\n<!-- md-runbook:output end -->');
    assert.equal(code[2]!.output!.attrs.ran, '2026-10-18T14:22:00+02:00');
    assert.equal(code[2]!.output!.attrs.shell, 'bash');
    assert.equal(code[3]!.value, "Write-Output 'in a list'");
    assert.equal(code[3]!.output!.text, 'in a list');
    assert.equal(code[4]!.value, 'echo broken');
    assert.equal(code[4]!.output, undefined);
    assert.ok(doc.cells.every((c) => c.kind === 'code' || !c.value.startsWith('<!-- md-runbook:output start exit=0 ran=2026-10-18T14:20')));
    const orphan = doc.cells.find((c) => c.kind === 'markup' && c.value.includes('orphan'));
    assert.ok(orphan, 'orphan output block stays in markdown');
  });

  it('nested-fences.md: fences inside other fences are not cells', () => {
    const doc = parse(decode('nested-fences.md'));
    const code = doc.cells.filter((c) => c.kind === 'code');
    assert.equal(code.length, 2);
    assert.ok(code[0]!.value.includes('```sh\necho nested\n```'));
    assert.equal(code[1]!.value, "echo 'tilde inside backticks:'\necho '~~~'");
  });

  it('tilde-and-info.md: tilde fences, annotations, case-insensitive language', () => {
    const doc = parse(decode('tilde-and-info.md'));
    const code = doc.cells.filter((c) => c.kind === 'code');
    assert.deepEqual(
      code.map((c) => c.languageId),
      ['shellscript', 'shellscript', 'powershell', 'shellscript', 'bat'],
    );
  });

  it('list-indented.md: fence indentation is stripped from the value', () => {
    const doc = parse(decode('list-indented.md'));
    const code = doc.cells.filter((c) => c.kind === 'code');
    assert.deepEqual(
      code.map((c) => c.value),
      ['oc login --server=https://api.example.com:6443', 'oc get nodes\n  indented more\nless', 'echo tab'],
    );
  });

  it('unclosed-fence.md: everything after an unclosed fence is markdown', () => {
    const doc = parse(decode('unclosed-fence.md'));
    assert.equal(doc.cells.filter((c) => c.kind === 'code').length, 1);
  });

  it('crlf: values use LF, doc remembers CRLF', () => {
    const doc = parse(decode('crlf-basic.md'));
    assert.equal(doc.meta.eol, '\r\n');
    assert.ok(doc.cells.every((c) => !c.value.includes('\r')));
  });

  it('bom-crlf.md: BOM is remembered and not part of the first cell', () => {
    const doc = parse(decode('bom-crlf.md'));
    assert.equal(doc.meta.bom, true);
    assert.equal(doc.cells[0]!.value, '# BOM + CRLF');
  });

  it('leading-and-adjacent.md: blank lines attach to cells, no empty cells', () => {
    const doc = parse(decode('leading-and-adjacent.md'));
    assert.deepEqual(
      doc.cells.map((c) => c.kind),
      ['code', 'code', 'code', 'markup'],
    );
  });

  it('empty file has no cells', () => {
    assert.equal(parse('').cells.length, 0);
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_WRITE_OPTIONS, locateCodeCells, minimalChange, outputSummary, parse, setCellOutput } from '@md-runbook/core';
import { listFixtures, readFixture } from './helpers';

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

describe('locateCodeCells', () => {
  it('finds the opening fence line of every code cell, past output blocks', () => {
    const src =
      '# T\n\n```sh\necho a\n```\n<!-- md-runbook:output start exit=0 -->\n```text\na\n```\n<!-- md-runbook:output end -->\n\n' +
      'Text\n\n   ```pwsh\n   Get-Date\n   x\n   ```\n';
    const locs = locateCodeCells(parse(src));
    assert.deepEqual(
      locs.map((l) => [l.cellIndex, l.line, l.closeLine, l.language, l.source]),
      [
        [1, 2, 4, 'sh', 'echo a'],
        [3, 13, 16, 'pwsh', 'Get-Date\nx'],
      ],
    );
    assert.deepEqual(locs[0]!.outputAttrs, { exit: '0' });
    assert.equal(locs[1]!.outputAttrs, undefined);
  });

  it('agrees with the actual fence lines in every fixture (CRLF, BOM, mixed EOL)', () => {
    for (const name of listFixtures()) {
      const text = decoder.decode(readFixture(name));
      const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
      for (const loc of locateCodeCells(parse(text))) {
        assert.match(lines[loc.line]!, /^\s*(```|~~~)/, `${name}: line ${loc.line}`);
        assert.match(lines[loc.closeLine]!, /^\s*(`{3,}|~{3,})\s*$/, `${name}: close ${loc.closeLine}`);
      }
    }
  });
});

describe('setCellOutput', () => {
  const out = { kind: 'new' as const, text: 'hi\n', attrs: { exit: '0', ran: 'R' } };

  it('adds an output block to one cell and keeps the rest byte for byte', () => {
    const src = '# T\r\n\r\n```sh\r\necho hi\r\n```\r\n\r\nAfter\r\n';
    assert.equal(
      setCellOutput(src, 1, out, DEFAULT_WRITE_OPTIONS),
      '# T\r\n\r\n```sh\r\necho hi\r\n```\r\n<!-- md-runbook:output start exit=0 ran=R -->\r\n```text\r\nhi\r\n```\r\n<!-- md-runbook:output end -->\r\n\r\nAfter\r\n',
    );
  });

  it('replaces an existing block and refuses markup cells', () => {
    const src = '```sh\necho a\n```\n<!-- md-runbook:output start exit=1 -->\n```text\nold\n```\n<!-- md-runbook:output end -->\n';
    assert.equal(setCellOutput(src, 0, out, DEFAULT_WRITE_OPTIONS), '```sh\necho a\n```\n<!-- md-runbook:output start exit=0 ran=R -->\n```text\nhi\n```\n<!-- md-runbook:output end -->\n');
    assert.equal(setCellOutput('text\n', 0, out, DEFAULT_WRITE_OPTIONS), undefined);
    assert.equal(setCellOutput(src, 5, out, DEFAULT_WRITE_OPTIONS), undefined);
  });
});

describe('minimalChange', () => {
  const apply = (a: string, c: { start: number; end: number; text: string }): string => a.slice(0, c.start) + c.text + a.slice(c.end);

  it('replaces only the differing middle', () => {
    const c = minimalChange('abcXYZdef', 'abc123def');
    assert.deepEqual(c, { start: 3, end: 6, text: '123' });
    assert.deepEqual(minimalChange('same', 'same'), { start: 4, end: 4, text: '' });
  });

  it('never splits CRLF or surrogate pairs', () => {
    for (const [a, b] of [
      ['a\r\nb', 'a\r\r\nb'],
      ['x\r\n', 'x\r\ny\r\n'],
      ['😀a', '😃a'],
      ['a😀', 'a😃'],
    ] as const) {
      const c = minimalChange(a, b);
      assert.equal(apply(a, c), b);
      for (const s of [a, b]) {
        for (const i of [c.start, s === a ? c.end : c.start + c.text.length]) {
          assert.ok(!(s[i - 1] === '\r' && s[i] === '\n'), `splits CRLF in ${JSON.stringify(s)} at ${i}`);
          assert.ok(!/[\ud800-\udbff]/.test(s[i - 1] ?? ''), `splits surrogate in ${JSON.stringify(s)} at ${i}`);
        }
      }
    }
  });
});

describe('outputSummary', () => {
  const now = new Date('2026-10-18T12:10:00Z');
  it('shows exit, duration and age', () => {
    assert.equal(outputSummary({ exit: '0', ended: '2026-10-18T14:05:00+02:00', duration: '1.234s' }, now), '✓ exit 0 · 1.2s · 5m ago');
    assert.equal(outputSummary({ exit: '1', ran: '2026-10-18T12:09:50Z' }, now), '✗ exit 1 · just now');
    assert.equal(outputSummary({ exit: 'timeout', duration: '90.000s' }, now), '✗ timeout · 1m30s');
    assert.equal(outputSummary({}, now), '✗ ?');
  });
});

describe('locateCodeCells with history', () => {
  it('counts the lines of a history block after an output', () => {
    const md = [
      '```sh', 'echo a', '```',
      '<!-- md-runbook:output start exit=0 -->', '```text', 'a', '```', '<!-- md-runbook:output end -->',
      '<details><summary>md-runbook: 1 previous run</summary>', '',
      '<!-- md-runbook:output start exit=1 -->', '```text', 'old', '```', '<!-- md-runbook:output end -->', '',
      '</details>', '',
      '```sh', 'echo b', '```', '',
    ].join('\n');
    const locs = locateCodeCells(parse(md));
    assert.equal(locs.length, 2);
    assert.equal(md.split('\n')[locs[1]!.line], '```sh');
    assert.equal(locs[1]!.line, 18);
  });
});

describe('outputSummary step states', () => {
  it('marks pending and manual states without a failure cross', () => {
    assert.match(outputSummary({ exit: 'declined' }), /^– declined/);
    assert.match(outputSummary({ exit: 'proposed' }), /^– proposed/);
    assert.match(outputSummary({ exit: 'done' }), /^✓ done/);
    assert.match(outputSummary({ exit: '2' }), /^✗ exit 2/);
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  CellInput,
  CodeMeta,
  DEFAULT_WRITE_OPTIONS,
  HistoryEntry,
  clearOutputBlocks,
  copyFileName,
  isCodeMeta,
  isCopyFileName,
  loadedOutputEntry,
  nextHistory,
  parse,
  serialize,
  withRunHistory,
} from '../src/core';
import { roundTrip, untouched } from './helpers';

const block = (text: string, exit = '0', indent = '', eol = '\n'): string =>
  [`<!-- md-runbook:output start exit=${exit} ran=r${exit} -->`, '```text', ...(text ? text.split('\n') : []), '```', '<!-- md-runbook:output end -->']
    .map((l) => (l ? indent + l : l))
    .join(eol) + eol;

const history = (entries: string[], indent = '', eol = '\n'): string =>
  `${indent}<details><summary>md-runbook: ${entries.length} previous run${entries.length === 1 ? '' : 's'}</summary>${eol}` +
  entries.map((e) => eol + e).join('') +
  `${eol}${indent}</details>${eol}`;

const DOC = '# T\n\n```sh\necho\n```\n' + block('three', '3') + history([block('two', '2'), block('one', '1')]) + '\nAfter.\n';

/** Simulate a re-run of code cell `idx` the way the extension does: previous = loaded block. */
function rerun(src: string, idx: number, text: string, size: number): string {
  const doc = parse(src);
  const cells = untouched(doc);
  const meta = doc.cells[idx]!.meta as CodeMeta;
  const previous = loadedOutputEntry(meta);
  const run: CellInput['output'] = { kind: 'new', text, attrs: { exit: '0', ran: 'now' } };
  cells[idx]!.output = withRunHistory(run, { previous, history: nextHistory(previous, meta.history?.entries ?? [], size) });
  return serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
}

describe('history blocks', () => {
  it('are parsed into CodeMeta, not cells', () => {
    const doc = parse(DOC);
    assert.deepEqual(
      doc.cells.map((c) => c.kind),
      ['markup', 'code', 'markup'],
    );
    const code = doc.cells[1]!;
    assert.equal(code.output!.text, 'three');
    const meta = code.meta as CodeMeta;
    assert.ok(isCodeMeta(JSON.parse(JSON.stringify(meta))));
    assert.deepEqual(
      meta.history!.entries.map((e) => [e.text, e.attrs.exit]),
      [
        ['two', '2'],
        ['one', '1'],
      ],
    );
    assert.equal(meta.history!.entries[0]!.raw, block('two', '2'));
  });

  const cases: Record<string, string> = {
    'LF': DOC,
    'CRLF': DOC.replace(/\n/g, '\r\n'),
    'mixed EOLs': DOC.replace('</details>\n', '</details>\r\n').replace('```text\ntwo', '```text\r\ntwo'),
    'indented list': '1. Step\n\n   ```sh\n   echo\n   ```\n' + block('b', '0', '   ') + history([block('a', '1', '   ')], '   ') + '2. Next\n',
    'gap before details and no EOF newline': '```sh\nx\n```\n' + block('b') + '\n' + history([block('a')]).replace(/\n$/, ''),
    'details without entries': '```sh\nx\n```\n' + block('b') + '<details><summary>md-runbook: 0 previous runs</summary>\n\n</details>\n',
    'details with other content': '```sh\nx\n```\n' + block('b') + '<details><summary>md-runbook: 1 previous run</summary>\n\ntext\n' + block('a') + '</details>\n',
    'unclosed details': '```sh\nx\n```\n' + block('b') + '<details><summary>md-runbook: 1 previous run</summary>\n\n' + block('a'),
    'details without an output block': '```sh\nx\n```\n' + history([block('a')]),
    'foreign details': '```sh\nx\n```\n' + block('b') + '<details><summary>Other</summary>\n\n' + block('a') + '</details>\n',
  };
  for (const [name, src] of Object.entries(cases)) {
    it(`round-trip byte for byte: ${name}`, () => assert.equal(roundTrip(src), src));
  }

  it('are only recognized directly after an output block', () => {
    for (const name of ['details without entries', 'details with other content', 'unclosed details', 'details without an output block', 'foreign details']) {
      const doc = parse(cases[name]!);
      assert.equal((doc.cells[0]!.meta as CodeMeta).history, undefined, name);
      assert.ok(doc.cells.some((c) => c.kind === 'markup' && c.value.includes('<details>')), name);
    }
  });

  it('re-run: previous output becomes the newest entry, trimmed to the size', () => {
    const out = rerun(DOC, 1, 'four\n', 2);
    assert.equal(
      out,
      '# T\n\n```sh\necho\n```\n' +
        '<!-- md-runbook:output start exit=0 ran=now changed=yes -->\n```text\nfour\n```\n<!-- md-runbook:output end -->\n' +
        history([block('three', '3'), block('two', '2')]) +
        '\nAfter.\n',
    );
    assert.equal(roundTrip(out), out);
    const meta = parse(out).cells[1]!.meta as CodeMeta;
    assert.deepEqual(
      meta.history!.entries.map((e) => e.text),
      ['three', 'two'],
    );
  });

  it('re-run grows the history up to the size', () => {
    const out = rerun(DOC, 1, 'four', 5);
    assert.deepEqual(
      (parse(out).cells[1]!.meta as CodeMeta).history!.entries.map((e) => e.text),
      ['three', 'two', 'one'],
    );
    assert.match(out, /md-runbook: 3 previous runs/);
  });

  it('size 0 drops the history but still marks changed', () => {
    const out = rerun(DOC, 1, 'three', 0);
    assert.doesNotMatch(out, /details/);
    assert.match(out, /changed=no/);
  });

  it('first run: no changed attribute and no history', () => {
    const out = rerun('```sh\nx\n```\n', 0, 'a', 3);
    assert.equal(out, '```sh\nx\n```\n<!-- md-runbook:output start exit=0 ran=now -->\n```text\na\n```\n<!-- md-runbook:output end -->\n');
  });

  it('CRLF file: rebuilt history uses CRLF and keeps entry bytes', () => {
    const src = DOC.replace(/\n/g, '\r\n');
    const out = rerun(src, 1, 'four', 2);
    assert.doesNotMatch(out.replace(/\r\n/g, ''), /\n/);
    assert.ok(out.includes(block('three', '3', '', '\r\n') + '\r\n' + block('two', '2', '', '\r\n')));
    assert.equal(roundTrip(out), out);
  });

  it('indented list: history is indented like the code block', () => {
    const src = cases['indented list']!;
    const out = rerun(src, 1, 'c', 3);
    assert.ok(out.includes('   ```\n   <!-- md-runbook:output start exit=0 ran=now changed=yes -->\n'));
    assert.ok(out.includes(history([block('b', '0', '   '), block('a', '1', '   ')], '   ')));
    assert.equal((parse(out).cells[1]!.meta as CodeMeta).history!.entries.length, 2);
  });

  it('an output block at EOF without newline becomes a proper entry', () => {
    const src = '```sh\nx\n```\n' + block('a').replace(/\n$/, '');
    const out = rerun(src, 0, 'b', 2);
    assert.ok(out.endsWith(history([block('a')])));
    assert.equal((parse(out).cells[0]!.meta as CodeMeta).history!.entries[0]!.text, 'a');
  });

  it('entries without raw bytes (from runs in this session) are formatted', () => {
    const doc = parse('```sh\nx\n```\n');
    const cells = untouched(doc);
    const prev: HistoryEntry = { text: 'p ```', attrs: { exit: '1' } };
    cells[0]!.output = { kind: 'new', text: 'n', attrs: { exit: '0' }, previous: prev, history: [prev] };
    const out = serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
    const meta = parse(out).cells[0]!.meta as CodeMeta;
    assert.deepEqual(meta.history!.entries.map((e) => [e.text, e.attrs]), [['p ```', { exit: '1' }]]);
  });

  it('Clear All Outputs removes history too', () => {
    assert.equal(clearOutputBlocks(DOC), '# T\n\n```sh\necho\n```\n\nAfter.\n');
    const crlf = DOC.replace(/\n/g, '\r\n');
    assert.equal(clearOutputBlocks(crlf), '# T\r\n\r\n```sh\r\necho\r\n```\r\n\r\nAfter.\r\n');
  });

  it('preserved outputs keep their history; new outputs without history drop it', () => {
    const doc = parse(DOC);
    const cells = untouched(doc);
    cells[1]!.value = 'echo edited';
    assert.ok(serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS).includes(history([block('two', '2'), block('one', '1')])));
    cells[1]!.output = { kind: 'new', text: 'x', attrs: {} };
    assert.doesNotMatch(serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS), /details/);
  });
});

describe('history metadata', () => {
  it('old metadata without history still validates; malformed history does not', () => {
    const meta = parse('```sh\nx\n```\n' + block('a')).cells[0]!.meta as CodeMeta;
    assert.ok(isCodeMeta(meta));
    assert.ok(!isCodeMeta({ ...meta, history: { raw: '', gap: '', entries: [{ text: 1 }] } }));
  });

  it('withRunHistory only applies to new outputs and valid values', () => {
    const run = { kind: 'new' as const, text: 't', attrs: {} };
    assert.deepEqual(withRunHistory({ kind: 'preserved' }, { history: [] }), { kind: 'preserved' });
    assert.equal(withRunHistory(undefined, { history: [] }), undefined);
    assert.deepEqual(withRunHistory(run, { history: 'x' }), run);
    assert.deepEqual(withRunHistory(run, undefined), run);
    const prev = { text: 'p', attrs: { exit: '0' } };
    assert.deepEqual(withRunHistory(run, { previous: prev, history: [prev] }), { ...run, previous: prev, history: [prev] });
  });

  it('nextHistory', () => {
    const e = (text: string): HistoryEntry => ({ text, attrs: {} });
    assert.deepEqual(nextHistory(undefined, [e('a')], 3), []);
    assert.deepEqual(nextHistory(e('p'), [e('a'), e('b')], 0), []);
    assert.deepEqual(nextHistory(e('p'), [e('a'), e('b')], 2), [e('p'), e('a')]);
  });
});

describe('run copies', () => {
  it('copyFileName / isCopyFileName', () => {
    const d = new Date(2026, 9, 8, 7, 6, 5);
    assert.equal(copyFileName('deploy.md', d), 'deploy.20261008-070605.md');
    assert.equal(copyFileName('a.runbook.MD', d), 'a.runbook.20261008-070605.md');
    assert.ok(isCopyFileName('deploy.20261008-070605.md'));
    assert.ok(isCopyFileName('deploy.20261008-070605-2.md'));
    assert.ok(!isCopyFileName('deploy.md'));
  });
});

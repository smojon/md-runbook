import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { checkNextItem, checklist, computeProgress, formatProgress, outputBlockAttrs, parse, stepState } from '../src/core';

describe('step state', () => {
  it('maps exit attributes', () => {
    assert.equal(stepState(undefined), 'pending');
    assert.equal(stepState('running'), 'pending');
    assert.equal(stepState('0'), 'done');
    assert.equal(stepState('done'), 'done');
    assert.equal(stepState('skipped'), 'skipped');
    for (const e of ['1', '127', 'timeout', 'cancelled', 'error', 'SIGTERM']) assert.equal(stepState(e), 'failed', e);
  });
});

describe('progress', () => {
  it('counts code cells and checklist items in order', () => {
    const p = computeProgress([
      { kind: 'markup', tasks: [true, false] }, // steps 1, 2
      { kind: 'code', exit: '0' }, // 3
      { kind: 'code', exit: 'skipped' }, // 4
      { kind: 'markup', tasks: [] },
      { kind: 'code', exit: '2' }, // 5
      { kind: 'code' }, // 6
      { kind: 'code', exit: 'done' }, // 7
    ]);
    assert.deepEqual(
      { ...p },
      {
        total: 7,
        done: 3,
        failed: 1,
        skipped: 1,
        pending: 2,
        firstFailed: { cell: 4, step: 5 },
        firstPending: { cell: 0, step: 2 },
        resume: [4, 5],
      },
    );
    assert.equal(formatProgress(p), '$(checklist) 4/7 · ✗ step 5');
  });

  it('resume starts at the first pending code cell when nothing failed', () => {
    const p = computeProgress([{ kind: 'code', exit: '0' }, { kind: 'code' }, { kind: 'code', exit: 'skipped' }, { kind: 'code' }]);
    assert.deepEqual(p.resume, [1, 3]);
    assert.equal(p.firstFailed, undefined);
    assert.equal(formatProgress(p), '$(checklist) 2/4');
  });

  it('shows a pass icon when complete', () => {
    const p = computeProgress([{ kind: 'code', exit: '0' }, { kind: 'markup', tasks: [true] }]);
    assert.deepEqual(p.resume, []);
    assert.equal(formatProgress(p), '$(pass) 2/2');
    assert.equal(computeProgress([]).total, 0);
  });
});

describe('checklist', () => {
  it('finds task-list items, skipping fenced code', () => {
    const md = '# Steps\n\n- [x] one\n* [ ] two\n  + [X] nested\n1. [ ] three\n- [] not\n- [ ]no space\n```md\n- [ ] in code\n```\n[ ] bare\n';
    assert.deepEqual(checklist(md), [true, false, true, false]);
  });

  it('checks the first unchecked item only', () => {
    assert.equal(checkNextItem('- [x] a\n- [ ] b\n- [ ] c'), '- [x] a\n- [x] b\n- [ ] c');
    assert.equal(checkNextItem('- [x] a'), undefined);
    assert.equal(checkNextItem('no list'), undefined);
  });

  it('keeps CRLF and skips tilde fences', () => {
    const md = '~~~\r\n- [ ] code\r\n~~~\r\n- [ ] real\r\n';
    assert.equal(checkNextItem(md), '~~~\r\n- [ ] code\r\n~~~\r\n- [x] real\r\n');
  });
});

describe('output block attributes', () => {
  it('reads the marker of a parsed block, including manual marks', () => {
    const doc = parse('```sh\necho a\n```\n\n<!-- md-runbook:output start exit=done ran=2026-10-18T14:20:00+02:00 by="Jane Doe" -->\n```text\nx\n```\n<!-- md-runbook:output end -->\n');
    const meta = doc.cells[0]!.meta;
    assert.ok(meta.kind === 'code' && meta.output);
    assert.deepEqual(outputBlockAttrs(meta.output.raw), { exit: 'done', ran: '2026-10-18T14:20:00+02:00', by: 'Jane Doe' });
    assert.equal(outputBlockAttrs('nothing'), undefined);
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeProgress, outputSummary, renderReport, stepState } from '../src/core';

describe('partial line runs (lines=)', () => {
  it('a partial run that passed is not done; one that failed is failed', () => {
    assert.equal(stepState('0', true), 'pending');
    assert.equal(stepState('0', false), 'done');
    assert.equal(stepState('2', true), 'failed');
    const p = computeProgress([
      { kind: 'code', exit: '0', partial: true },
      { kind: 'code', exit: '0' },
    ]);
    assert.equal(p.done, 1);
    assert.deepEqual(p.resume, [0]);
  });

  it('the CodeLens summary names the lines', () => {
    assert.equal(outputSummary({ exit: '0', lines: '2-3' }), '✓ exit 0 · lines 2-3');
  });

  it('the report shows a partial step as not complete', () => {
    const html = renderReport('```sh\necho a\necho b\n```\n<!-- md-runbook:output start exit=0 lines=2 -->\n```text\nb\n```\n<!-- md-runbook:output end -->\n', {
      generatedAt: new Date('2026-10-18T12:00:00Z'),
    });
    assert.match(html, /– lines 2 ran/);
    assert.match(html, /1 not run/);
    assert.doesNotMatch(html, /1 passed/);
  });
});

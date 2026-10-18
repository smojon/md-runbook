import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeProgress, outputSummary, renderReport, stepState } from '../src/core';
import { findRefs } from '../src/core/secrets';
import { evaluateChecks, parseCapture, parseInterval, parseMatcher } from '../src/core/checks';
import { parseCellOptions } from '../src/core/cellOptions';

describe('cell options: expect, retry, capture', () => {
  it('parses checks and retries', () => {
    const o = parseCellOptions('bash expect="pod Running" expect-not=/error/i expect-exit=1 retry=10 every=15s capture=POD:/^(web-\\S+)/m capture-secret=TOKEN');
    assert.deepEqual(o.errors, []);
    assert.deepEqual(o.checks?.expect, { kind: 'text', text: 'pod Running' });
    assert.equal(o.checks?.expectNot?.kind, 'regex');
    assert.equal(o.checks?.expectExit, 1);
    assert.deepEqual(o.retry, { attempts: 10, everyMs: 15_000 });
    assert.deepEqual(
      o.checks?.captures.map((c) => [c.name, c.pattern?.source, c.secret]),
      [
        ['POD', '^(web-\\S+)', false],
        ['TOKEN', undefined, true],
      ],
    );
  });

  it('retry waits 5 s by default; no options means no checks', () => {
    assert.deepEqual(parseCellOptions('bash retry=3').retry, { attempts: 3, everyMs: 5000 });
    assert.equal(parseCellOptions('bash timeout=3').checks, undefined);
  });

  it('reports invalid values', () => {
    const o = parseCellOptions('bash retry=0 every=soon expect-exit=x expect=/(/ capture=1X capture=A:plain');
    assert.equal(o.errors.length, 6, o.errors.join('\n'));
  });
});

describe('matchers and intervals', () => {
  it('text or /regex/flags', () => {
    assert.deepEqual(parseMatcher('a.b'), { kind: 'text', text: 'a.b' });
    const m = parseMatcher('/^ok$/im');
    assert.equal(m.kind === 'regex' && m.re.flags, 'im');
    assert.throws(() => parseMatcher('/(/'));
  });

  it('intervals', () => {
    assert.equal(parseInterval('15'), 15_000);
    assert.equal(parseInterval('15s'), 15_000);
    assert.equal(parseInterval('500ms'), 500);
    assert.equal(parseInterval('2m'), 120_000);
    assert.equal(parseInterval('soon'), undefined);
  });

  it('capture specs', () => {
    assert.deepEqual(parseCapture('POD', false), { name: 'POD', secret: false });
    assert.throws(() => parseCapture('POD:text', false), /NAME:\/regex\//);
  });
});

describe('evaluateChecks', () => {
  const checks = (opts: string) => parseCellOptions(`bash ${opts}`).checks!;

  it('exit code alone, and expect-exit', () => {
    assert.equal(evaluateChecks(checks('expect=x'), 1, 'x', 'x').ok, false);
    const r = evaluateChecks(checks('expect-exit=2'), 2, '', '');
    assert.equal(r.ok, true);
    assert.deepEqual(evaluateChecks(checks('expect-exit=2'), 0, '', '').failures, ['exit code 0, expected 2']);
  });

  it('expect and expect-not on stdout and stderr, ignoring colours and CRLF', () => {
    assert.equal(evaluateChecks(checks('expect="pod Running"'), 0, 'x\r\n\x1b[32mpod Running\x1b[0m\r\n', '').ok, true);
    assert.equal(evaluateChecks(checks('expect=/^ready$/m'), 0, 'a\r\nready\r\n', '').ok, true);
    const r = evaluateChecks(checks('expect=done expect-not=ERROR'), 0, 'ERROR: x', '');
    assert.deepEqual(r.failures, ['the output does not contain "done"', 'the output contains "ERROR"']);
  });

  it('captures from stdout only, when everything else passed', () => {
    // A value with a space is quoted, like any option value.
    const c = checks('capture="POD:/name: (\\S+)/" capture=ALL');
    const r = evaluateChecks(c, 0, 'name: web-1\nnoise\n', 'name: web-1\n');
    assert.deepEqual(r.captured, [
      { name: 'POD', value: 'web-1', secret: false },
      { name: 'ALL', value: 'name: web-1', secret: false },
    ]);
    const miss = evaluateChecks(c, 0, 'name: web-1', 'other');
    assert.equal(miss.ok, false);
    assert.deepEqual(miss.captured, []);
    assert.match(miss.failures[0]!, /capture POD: nothing in the output matches/);
    assert.deepEqual(evaluateChecks(c, 1, 'name: web-1', 'name: web-1').captured, []);
  });
});

describe('check= in progress, CodeLens and report', () => {
  it('a passed check counts as done even with a non-zero exit; a failed one as failed', () => {
    assert.equal(stepState('1', false, 'ok'), 'done');
    assert.equal(stepState('0', false, 'failed'), 'failed');
    assert.equal(stepState('0', true, 'ok'), 'pending');
    assert.equal(computeProgress([{ kind: 'code', exit: '0', check: 'failed' }]).failed, 1);
  });

  it('CodeLens summary', () => {
    assert.equal(outputSummary({ exit: '0', check: 'failed', attempts: '3' }), '✗ exit 0 · check failed · 3 attempts');
    assert.equal(outputSummary({ exit: '1', check: 'ok' }), '✓ exit 1');
  });

  it('report badges', () => {
    const block = (attrs: string): string => `\`\`\`sh\necho\n\`\`\`\n<!-- md-runbook:output start ${attrs} -->\n\`\`\`text\nx\n\`\`\`\n<!-- md-runbook:output end -->\n`;
    const html = (attrs: string): string => renderReport(block(attrs), { generatedAt: new Date('2026-10-18T12:00:00Z') });
    assert.match(html('exit=0 check=failed'), /✗ check failed/);
    assert.match(html('exit=1 check=ok'), /1 passed/);
  });

  it('${out:NAME} is a reference like the others', () => {
    assert.deepEqual(findRefs('echo ${out:POD} ${param:HOST}'), [
      { kind: 'out', name: 'POD', secret: false },
      { kind: 'param', name: 'HOST', secret: false },
    ]);
  });
});

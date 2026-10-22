import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_WRITE_OPTIONS,
  colorizeAnsi,
  colorizeSaved,
  formatLineSet,
  levelSpans,
  markStderr,
  parse,
  parseLineSet,
  setCellOutput,
  splitStderrMarks,
} from '@md-runbook/core';

/** The coloured words of a line, as `level:word`. */
const words = (line: string): string[] => levelSpans(line).flatMap((s) => (s.level ? [`${s.level}:${s.text}`] : []));

describe('output colours: level words', () => {
  it('Grafana, syslog and VS Code level words, in capitals or Capitalized', () => {
    assert.deepEqual(words('2026-10-22 12:00:01 ERROR db: connection refused'), ['error:ERROR']);
    assert.deepEqual(words('FATAL: out of memory; CRITICAL; EMERGENCY; ALERT; PANIC'), ['critical:FATAL', 'critical:CRITICAL', 'critical:EMERGENCY', 'critical:ALERT', 'critical:PANIC']);
    assert.deepEqual(words('WARN disk 91% · Warning: retrying'), ['warning:WARN', 'warning:Warning']);
    assert.deepEqual(words('INFO started · NOTICE · INFORMATIONAL'), ['info:INFO', 'info:NOTICE', 'info:INFORMATIONAL']);
    assert.deepEqual(words('DEBUG x · TRACE y · VERBOSE z'), ['debug:DEBUG', 'trace:TRACE', 'trace:VERBOSE']);
    assert.deepEqual(words('Error opening file · Fatal'), ['error:Error', 'critical:Fatal']);
  });

  it('lower case only before a colon, or in brackets', () => {
    assert.deepEqual(words('error: pathspec did not match · fatal: not a git repository'), ['error:error', 'critical:fatal']);
    assert.deepEqual(words('[warn] slow · [INF] up · [e] down · [dbg] x'), ['warning:[warn]', 'info:[INF]', 'error:[e]', 'debug:[dbg]']);
    // Prose and names stay plain.
    assert.deepEqual(words('0 errors, 2 warnings; error_count=0; ERROR_CODE=3; the info we need'), []);
    assert.deepEqual(words('Notice that the Pass is OK'), ['success:OK']);
  });

  it('Nevis (5-NOTICE, 7-DEBUG_LOW), klog prefixes and exception names', () => {
    assert.deepEqual(words('2019 02 01 11:53:37.600 3.14.0.0 IW4Esau4Co 30371 5-NOTICE: Esauth4ConnectorServlet'), ['info:NOTICE']);
    assert.deepEqual(words('… 3-ERROR: backend down · 7-DEBUG_LOW: enter · DBG_HIGH'), ['error:ERROR', 'debug:DEBUG_LOW', 'debug:DBG_HIGH']);
    assert.deepEqual(words('E1022 12:00:00.123456   12 kubelet.go:1] pod failed to start'), ['error:E1022 12:00:00.123456']);
    assert.deepEqual(words('W1022 12:00:00 x'), ['warning:W1022 12:00:00']);
    assert.deepEqual(words('java.lang.NullPointerException at Main'), ['error:java.lang.NullPointerException']);
  });

  it('success words and check marks in green', () => {
    assert.deepEqual(words('Tests PASSED ✓ · SUCCESS · Succeeded · DONE · 200 OK'), ['success:PASSED', 'success:✓', 'success:SUCCESS', 'success:Succeeded', 'success:DONE', 'success:OK']);
    assert.deepEqual(words('✗ 2 FAILED'), ['error:✗', 'error:FAILED']);
  });

  it('a line with its own ANSI colours keeps them', () => {
    assert.deepEqual(levelSpans('\u001b[32mok\u001b[0m ERROR'), [{ text: '\u001b[32mok\u001b[0m ERROR' }]);
  });
});

describe('output colours: ANSI for VS Code', () => {
  it('level words get their colour; stderr lines are red, their words keep their colour', () => {
    assert.equal(colorizeAnsi('INFO up\nplain', { levels: true, stderr: false }), '\u001b[34mINFO\u001b[0m up\nplain');
    assert.equal(colorizeAnsi('boom ERROR x', { levels: true, stderr: true }), '\u001b[31mboom \u001b[31mERROR\u001b[0;31m x\u001b[0m');
    assert.equal(colorizeAnsi('WARN', { levels: false, stderr: true }), '\u001b[31mWARN\u001b[0m');
    assert.equal(colorizeAnsi('INFO', { levels: false, stderr: false }), 'INFO');
  });
});

describe('output colours: which saved lines came from stderr', () => {
  it('marks stderr lines and finds them again, also after \\r rewrites', () => {
    const t = 'out 1\n' + markStderr('err 2\n10%\r100%\n') + 'out 4';
    assert.deepEqual(splitStderrMarks(t), { text: 'out 1\nerr 2\n10%\r100%\nout 4', stderr: [1, 2] });
  });

  it('line sets: 0-based in, 1-based ranges out, and back', () => {
    assert.equal(formatLineSet([0, 2, 3, 4, 7]), '1,3-5,8');
    assert.deepEqual([...parseLineSet('1,3-5,8')], [0, 2, 3, 4, 7]);
    assert.deepEqual([...parseLineSet('bad;x')], []);
  });

  it('the written output block says which lines came from stderr; reopened, they are red', () => {
    const doc = '```bash\necho\n```\n';
    const text = 'out 1\n' + markStderr('\u001b[1merr\u001b[0m 2\n') + 'out 3\n';
    const out = setCellOutput(doc, 0, { kind: 'new', text, attrs: { exit: '0' } }, DEFAULT_WRITE_OPTIONS)!;
    assert.match(out, /<!-- md-runbook:output start exit=0 stderr=2 -->\n```text\nout 1\nerr 2\nout 3\n```/);
    const saved = parse(out).cells[0]!.output!;
    assert.equal(saved.attrs.stderr, '2');
    assert.equal(colorizeSaved(saved.text, saved.attrs.stderr, true, true), 'out 1\n\u001b[31merr 2\u001b[0m\nout 3');
    // No stderr: no attribute.
    assert.doesNotMatch(setCellOutput(doc, 0, { kind: 'new', text: 'ok\n', attrs: { exit: '0' } }, DEFAULT_WRITE_OPTIONS)!, /stderr=/);
  });
});

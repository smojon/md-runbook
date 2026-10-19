import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { formatProblem, lintRunbook } from '@md-runbook/core/lint';
import { lint } from '../src/cli/main';

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';
const messages = (md: string): string[] => lintRunbook(md).map((p) => `${p.line + 1} ${p.severity}: ${p.message}`);

describe('lintRunbook', () => {
  it('a clean runbook has no problems (proposal options and env.* are known)', () => {
    const md =
      '---\nmode: session\ntimeout: 60\nparams:\n- HOST: x\n---\n\n' +
      fence('bash capture=POD retry=3 every=1s env.A=1 name="x"', 'echo ${param:HOST}') +
      fence('bash proposed by=claude reason="check"', 'echo ${out:POD}') +
      fence('json', '{ "not": "a shell block", "x": "${out:NOPE}" }');
    assert.deepEqual(messages(md), []);
  });

  it('reports invalid and unknown options, every= without retry=', () => {
    assert.deepEqual(messages(fence('bash timeout=x retires=3 every=1s', 'echo')), [
      '1 error: invalid cell option timeout=x: expected seconds (0 = none)',
      '1 warning: unknown cell option "retires" (ignored)',
      '1 warning: every= has no effect without retry=',
    ]);
  });

  it('reports ${out:} before its capture and undeclared ${param:}, on the line that uses them', () => {
    const md = '# T\n\n' + fence('bash', 'echo a\necho ${out:POD} ${param:B}') + fence('bash capture=POD', 'echo pod');
    const ps = lintRunbook(md);
    assert.deepEqual(
      ps.map((p) => [p.line, p.severity, p.cell]),
      [
        [4, 'error', { index: 1, sourceLine: 1 }],
        [4, 'warning', { index: 1, sourceLine: 1 }],
      ],
    );
    assert.match(ps[0]!.message, /\$\{out:POD\} is not captured by an earlier block/);
  });

  it('reports a name used as two kinds, and ignored front matter values', () => {
    const md = '---\nmode: sometimes\ntimeout: soon\n---\n\n' + fence('bash', 'echo ${input:X} ${param:X}');
    assert.deepEqual(
      lintRunbook(md).map((p) => [p.line + 1, p.severity]),
      [
        [2, 'warning'],
        [3, 'warning'],
        [6, 'error'],
      ],
    );
  });

  it('formats problems as file:line: severity: message', () => {
    assert.equal(formatProblem('r.md', { severity: 'error', message: 'boom', line: 4 }), 'r.md:5: error: boom');
  });
});

describe('md-runbook lint', () => {
  const file = (content: string): string => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-lint-')), 'r.md');
    fs.writeFileSync(f, content);
    return f;
  };

  it('exits 1 on errors, 0 on warnings unless --strict', () => {
    const lines: string[] = [];
    assert.equal(lint([file(fence('bash', 'echo ${out:X}'))], (l) => lines.push(l)), 1);
    assert.match(lines.join('\n'), /r\.md:2: error: \$\{out:X\}/);
    const warn = file(fence('bash every=1s', 'echo'));
    assert.equal(lint([warn], () => undefined), 0);
    assert.equal(lint([warn, '--strict'], () => undefined), 1);
    assert.equal(lint([file(fence('bash', 'echo ok'))], () => undefined), 0);
  });
});

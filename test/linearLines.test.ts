/**
 * Core's line readers stay linear on hostile lines: a long run of backticks, blanks or `#`s that
 * ends in U+2028 (which `.` doesn't match, so a `^…(.*)$` pattern can't reach `$`) or in a letter.
 * Before 0.29.0 these took quadratic or cubic time: 80,000 backticks and U+2028 took 7 s in
 * matchFenceOpen, 4,000 blanks after `#` took 40 s in runbookTitle. U+2028 and U+2029 are now
 * ordinary characters inside a line, as in CommonMark.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { extractFencedBlocks } from '@md-runbook/core/aiContext';
import { extractProposals } from '@md-runbook/core/aiPrompt';
import { matchFenceOpen } from '@md-runbook/core/fence';
import { beforeComment, isBlank, valueAndHash } from '@md-runbook/core/lineText';
import { lintRunbook } from '@md-runbook/core/lint';
import { renderMarkdown } from '@md-runbook/core/markdown';
import { parse } from '@md-runbook/core/parser';
import { parseProbeOutput } from '@md-runbook/core/probe';
import { measureProse } from '@md-runbook/core/prose';
import { parseDotenv, parseFrontMatter } from '@md-runbook/core/secrets';
import { sectionHeadings } from '@md-runbook/core/sections';
import { reportSigningErrors } from '@md-runbook/core/signing';
import { splitSteps } from '@md-runbook/core/steps';
import { atxHeading, headingsOf, runbookTitle } from '@md-runbook/core/title';
import { lastHeading } from '@md-runbook/core/transcript';

const N = 100_000;
const LS = '\u2028';
const PS = '\u2029';
/** Each call well under the time a quadratic reading of N characters takes (tens of seconds). */
const LIMIT_MS = 2_000;

function fast(name: string, run: () => unknown): void {
  const t0 = performance.now();
  run();
  const ms = performance.now() - t0;
  assert.ok(ms < LIMIT_MS, `${name}: ${Math.round(ms)} ms`);
}

const blanks = ' '.repeat(N);
const hostileEnds = [LS, PS, 'b', '#' + LS];

describe('linear line readers', () => {
  it('fences: a run of backticks or tildes ending in U+2028', () => {
    for (const run of ['`'.repeat(N), '~'.repeat(N), '   ' + '`'.repeat(N)]) {
      for (const end of [LS, PS]) {
        const line = run + end;
        fast('matchFenceOpen', () => matchFenceOpen(line));
        fast('parse', () => parse(line));
        fast('extractFencedBlocks', () => extractFencedBlocks(line));
        fast('extractProposals', () => extractProposals(line));
      }
    }
  });

  it('headings: blanks after `#`, before a closing `#`, ending in U+2028 or a letter', () => {
    for (const end of hostileEnds) {
      for (const line of ['#' + blanks + end, '# a' + blanks + end, '# a' + blanks + '#' + blanks + end, '#' + '\t'.repeat(N) + end]) {
        fast('runbookTitle', () => runbookTitle(line));
        fast('headingsOf', () => headingsOf(line));
        fast('renderMarkdown', () => renderMarkdown(line));
        fast('sectionHeadings', () => sectionHeadings(line));
        fast('lastHeading', () => lastHeading(line));
        fast('measureProse', () => measureProse(line));
      }
    }
  });

  it('Markdown lists and quotes, prose comments, probe lines, shell comments', () => {
    for (const end of hostileEnds) {
      fast('list', () => renderMarkdown('-' + blanks + end));
      fast('ordered list', () => renderMarkdown('1.' + blanks + end));
      fast('quote', () => renderMarkdown('>' + blanks + end));
      fast('table separator', () => renderMarkdown('| a |\n|-' + blanks + end));
      fast('probe', () => parseProbeOutput('OK  a' + blanks + end));
      fast('steps', () => splitSteps('f()' + blanks + end, 'bash'));
    }
    fast('prose comments', () => measureProse('Text ' + '<!--'.repeat(N / 4) + ' end.'));
  });

  it('front matter: values, comments, env entries and params with long blank runs', () => {
    const lines = [
      'cwd: a' + blanks + 'b',
      'shell: a' + ' #'.repeat(N / 2) + LS,
      'incident: a' + blanks + 'b',
      'kube-context: a' + blanks + '#' + LS,
      'report-runs: https://a' + blanks + 'b',
      'report-runs-token: a' + blanks + 'b',
      'mode: a' + blanks + 'b',
      'env:\n  A: a' + blanks + 'b\n  B:' + blanks + LS,
      'params:\n  - a: b' + blanks + 'b\n  - c' + blanks + '#' + LS + '\n  - d' + blanks + 'x',
    ];
    for (const line of lines) {
      const text = `---\n${line}\n---\n# T\n`;
      fast('parseFrontMatter', () => parseFrontMatter(text));
      fast('lintRunbook', () => lintRunbook(text));
      fast('reportSigningErrors', () => reportSigningErrors(text));
    }
    fast('parseDotenv', () => parseDotenv('A=a' + blanks + 'b\nB=a' + ' #'.repeat(N / 2)));
  });
});

describe('the readers that replaced the patterns', () => {
  it('U+2028 and U+2029 are text inside a line', () => {
    assert.equal(matchFenceOpen('```bash' + LS + 'x')?.info, 'bash' + LS + 'x');
    assert.equal(runbookTitle('# A' + LS + 'B ##\n'), 'A' + LS + 'B');
    assert.equal(parseFrontMatter('---\ncwd: /a' + PS + 'b # c\n---\n')?.cwd, '/a' + PS + 'b');
  });

  it('atxHeading: levels, closing sequences, blanks', () => {
    assert.deepEqual(atxHeading('## Step ##  '), { level: 2, text: 'Step', blank: true });
    assert.deepEqual(atxHeading('   # C#'), { level: 1, text: 'C#', blank: true });
    assert.deepEqual(atxHeading('# ##'), { level: 1, text: '##', blank: true });
    assert.deepEqual(atxHeading('#'), { level: 1, text: '', blank: false });
    assert.deepEqual(atxHeading('# a #', false), { level: 1, text: 'a #', blank: true });
    for (const no of ['####### seven', '#no', '    # four spaces', '\t# tab', 'text']) assert.equal(atxHeading(no), undefined);
    assert.deepEqual(
      sectionHeadings('# A ##\n## ## #\n### ##\n').map((h) => h.text),
      ['A', '##', ''],
    );
  });

  it('table separator rows', () => {
    const table = (sep: string): boolean => renderMarkdown(`| a | b |\n${sep}\n| 1 | 2 |\n`).includes('<table');
    for (const yes of ['|---|---|', '| :-- | --: |', '---|---', '  |-|-|  ', '-']) assert.ok(table(yes), yes);
    for (const no of ['|---||', '| - | x |', '|', '| : |']) assert.ok(!table(no), no);
  });

  it('comments and values', () => {
    assert.equal(beforeComment('a  # c'), 'a');
    assert.equal(beforeComment('a#b # c'), 'a#b');
    assert.equal(beforeComment('# c'), '# c');
    assert.equal(beforeComment('# c', undefined, true), '');
    assert.equal(beforeComment('a\u00a0# c', isBlank), 'a\u00a0# c');
    assert.deepEqual(valueAndHash('zsh, pwsh  # mine  '), { value: 'zsh, pwsh', hash: '# mine  ' });
    assert.deepEqual(valueAndHash('zsh#x'), { value: 'zsh', hash: '#x' });
    assert.deepEqual(valueAndHash('  '), { value: '' });
    const fm = parseFrontMatter('---\nenv:\n  A: x # c\n  B:\n  C:y\nparams:\n  - p: "d" # Desc\n  - q # Other\n  - r:x\n---\n');
    assert.deepEqual({ ...fm?.env }, { A: 'x', B: '' });
    assert.deepEqual(
      fm?.params.map((p) => [p.name, p.default, p.description]),
      [
        ['p', 'd', 'Desc'],
        ['q', undefined, 'Other'],
      ],
    );
  });
});

/** estimate=: the option, the sums per section and in all, and the progress against it. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  blockBar,
  blockProgress,
  estimateRunbook,
  formatBlockProgress,
  formatEstimate,
  formatFinish,
  formatLeft,
  formatRunbookEstimate,
  formatTimeLeft,
  isOverEstimate,
  overEstimate,
  progressBar,
  remaining,
  runbookEstimate,
  stepLabel,
  suggestedEstimate,
  terminalBarWidth,
  textEstimateSteps,
} from '@md-runbook/core/estimate';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { parseInterval } from '@md-runbook/core/checks';
import { lintRunbook } from '@md-runbook/core/lint';
import { ShellSettings, renderReport } from '@md-runbook/core';
import { nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { estimate } from '../src/cli/main';
import { StepResult, junitReport, markdownSummary, runRunbook } from '../src/cli/run';

const settings: ShellSettings = { bashPath: process.env.MD_RUNBOOK_BASH };
const hasBash = resolveShell('bash', settings, nodeShellEnv()).ok;

const fence = (info: string, body = 'echo hi'): string => '```' + info + '\n' + body + '\n```\n\n';

describe('estimate=', () => {
  it('takes the durations timeout= and every= take, and plain seconds', () => {
    assert.equal(parseCellOptions('bash estimate=2m30s').estimateSeconds, 150);
    assert.equal(parseCellOptions('bash estimate=90').estimateSeconds, 90);
    assert.equal(parseCellOptions('bash estimate=45s').estimateSeconds, 45);
    assert.equal(parseCellOptions('bash estimate=1h5m').estimateSeconds, 3900);
    assert.equal(parseCellOptions('bash estimate=500ms').estimateSeconds, 0.5);
    assert.equal(parseCellOptions('bash estimate="2m 30s"').estimateSeconds, undefined);
    assert.equal(parseCellOptions('bash expect=ok').estimateSeconds, undefined);
  });

  it('an invalid value is an option error, so lint reports it and a run refuses the block', () => {
    for (const v of ['soon', '30s2m', '1m1m', '', '-5', '2m30']) {
      const o = parseCellOptions(`bash estimate=${v}`);
      assert.equal(o.estimateSeconds, undefined, v);
      assert.match(o.errors[0] ?? '', /^estimate=.*expected a duration/, v);
    }
    const problems = lintRunbook(fence('bash estimate=soon') + fence('bash estimate=2m'));
    assert.deepEqual(
      problems.map((p) => `${p.line + 1} ${p.severity}`),
      ['1 error'],
    );
    assert.match(problems[0]!.message, /estimate=soon/);
  });

  it('lint does not ask for an estimate, and knows its typo', () => {
    assert.deepEqual(lintRunbook(fence('bash')), []);
    const p = lintRunbook(fence('bash estimat=2m'));
    assert.equal(p[0]?.fix?.to, 'estimate');
  });

  it('parseInterval reads units from the largest down', () => {
    assert.equal(parseInterval('2m30s'), 150_000);
    assert.equal(parseInterval('1h'), 3_600_000);
    assert.equal(parseInterval('1m500ms'), 60_500);
    assert.equal(parseInterval('1.5m'), 90_000);
    assert.equal(parseInterval('30s2m'), undefined);
    assert.equal(parseInterval('2 m'), undefined);
  });
});

describe('formatting', () => {
  it('formatEstimate is the shortest form parseInterval reads back', () => {
    for (const [s, text] of [
      [150, '2m30s'],
      [45, '45s'],
      [0, '0s'],
      [3600, '1h'],
      [3905, '1h5m5s'],
      [0.5, '0.5s'],
      [59.6, '1m'],
    ] as const) {
      assert.equal(formatEstimate(s), text);
      assert.equal(parseInterval(text)! / 1000, s < 1 ? s : Math.round(s));
    }
  });

  it('formatLeft is rough', () => {
    assert.equal(formatLeft(20), 'under a minute');
    assert.equal(formatLeft(6 * 60 + 10), 'about 6 min');
    assert.equal(formatLeft(70 * 60), 'about 1 h 10 min');
    assert.equal(formatLeft(120 * 60), 'about 2 h');
  });

  it('progressBar is clamped', () => {
    assert.equal(progressBar(0.4), '[####......]');
    assert.equal(progressBar(0), '[..........]');
    assert.equal(progressBar(1.7), '[##########]');
    assert.equal(progressBar(Number.NaN), '[..........]');
    assert.equal(progressBar(0.5, 4), '[##..]');
  });
});

describe('a running block', () => {
  it('is full at its estimate and overdue after it, never past full', () => {
    assert.deepEqual(blockProgress(60, 150), { fraction: 0.4, overSeconds: 0 });
    assert.deepEqual(blockProgress(150, 150), { fraction: 1, overSeconds: 0 });
    assert.deepEqual(blockProgress(230, 150), { fraction: 1, overSeconds: 80 });
    assert.equal(formatBlockProgress(60, 150), '[####......] 1m of 2m30s');
    assert.equal(formatBlockProgress(230, 150), '[##########] +1m20s over 2m30s');
  });

  it('warns only when more than twice its estimate and more than a minute over', () => {
    assert.equal(isOverEstimate(12, 5), false); // twice, but 7 s over
    assert.equal(isOverEstimate(200, 150), false); // a minute over, not twice
    assert.equal(isOverEstimate(301, 150), true);
    assert.equal(isOverEstimate(70, 5), true);
    assert.equal(isOverEstimate(65, 5), false); // exactly a minute over
    assert.equal(isOverEstimate(60, 0), false);
  });
});

describe('the runbook', () => {
  it('done over the total by estimates; the running block counts its time so far', () => {
    const e = runbookEstimate([
      { estimateSeconds: 120, state: 'done' },
      { estimateSeconds: 180, state: 'running', elapsedSeconds: 60 },
      { estimateSeconds: 300, state: 'pending' },
      { state: 'pending' },
      { state: 'done' },
    ]);
    assert.equal(e.totalSeconds, 600);
    assert.equal(e.doneSeconds, 120);
    assert.equal(e.fraction, 0.3, 'the 60 s the running block has run count');
    assert.equal(e.leftSeconds, 120 + 300);
    assert.equal(e.unestimated, 2);
    assert.equal(e.unestimatedLeft, 1);
    assert.equal(formatRunbookEstimate(e), '[###.......] 30% · 7 min left · 1 block without an estimate');
  });

  it('a running block past its estimate leaves nothing of it, never less', () => {
    const e = runbookEstimate([{ estimateSeconds: 60, state: 'running', elapsedSeconds: 200 }]);
    assert.equal(e.leftSeconds, 0);
    assert.equal(formatRunbookEstimate(e), '[##########] 100% · nothing left');
  });

  it('no estimate at all: no fraction, no line', () => {
    const e = runbookEstimate([{ state: 'pending' }]);
    assert.equal(e.fraction, undefined);
    assert.equal(formatRunbookEstimate(e), undefined);
  });
});

describe('estimateRunbook', () => {
  it('sums per # and ## section and in all; ### stays in its section; skip does not count', () => {
    const md =
      '---\n# a comment in the front matter\ntimeout: 10\n---\n\n' +
      fence('bash estimate=10s') +
      '# Title\n\n' +
      fence('bash estimate=1m') +
      '## 1. Start\n\n' +
      fence('bash estimate=2m30s') +
      '### 1.1 More\n\n' +
      fence('bash') +
      fence('bash estimate=1h skip') +
      '## 2. End\n\n' +
      '```yaml\n# not a heading\n```\n\n' +
      fence('pwsh estimate=30');
    const s = estimateRunbook(md);
    assert.deepEqual(
      s.sections.map((x) => [x.heading, x.level, x.seconds, x.blocks, x.unestimated]),
      [
        [undefined, 0, 10, 1, 0],
        ['Title', 1, 60, 1, 0],
        ['1. Start', 2, 150, 2, 1],
        ['2. End', 2, 30, 1, 0],
      ],
    );
    assert.equal(s.totalSeconds, 250);
    assert.equal(s.blocks, 5);
    assert.equal(s.unestimated, 1);
    assert.deepEqual(s.counts.filter(Boolean).length, 5);
  });

  it('os= alternatives are one block: the one for this system, else the longest', () => {
    const md = '# T\n\n' + fence('bash os=linux,macos estimate=1m') + fence('pwsh os=windows estimate=3m') + fence('bash estimate=10s');
    assert.equal(estimateRunbook(md, 'linux').totalSeconds, 70);
    assert.equal(estimateRunbook(md, 'windows').totalSeconds, 190);
    assert.equal(estimateRunbook(md, 'linux').blocks, 2);
    const noneHere = '# T\n\n' + fence('bash os=linux estimate=1m') + fence('pwsh os=windows estimate=3m');
    assert.equal(estimateRunbook(noneHere, 'macos').totalSeconds, 180);
  });

  it('an invalid estimate counts as none', () => {
    const s = estimateRunbook('# T\n\n' + fence('bash estimate=soon'));
    assert.equal(s.unestimated, 1);
    assert.equal(s.totalSeconds, 0);
  });
});

describe('textEstimateSteps (the app)', () => {
  const out = (exit: string): string => `<!-- md-runbook:output start exit=${exit} -->\n\`\`\`text\nx\n\`\`\`\n<!-- md-runbook:output end -->\n\n`;
  it('done by the outputs, the running cell, skip and other systems left out, host= counted', () => {
    const md =
      '# T\n\n' +
      fence('bash estimate=1m').trimEnd() + '\n' + out('0') +
      fence('bash estimate=2m').trimEnd() + '\n' + out('1') +
      fence('bash estimate=3m host=web') +
      fence('bash estimate=4m skip') +
      fence('pwsh os=windows estimate=5m') +
      fence('bash os=linux estimate=6m');
    const steps = textEstimateSteps(md, { cellIndex: 3, elapsedSeconds: 30 });
    assert.deepEqual(
      steps.map((s) => [s.cell, s.estimateSeconds, s.state, s.elapsedSeconds]),
      [
        [1, 60, 'done', undefined],
        [2, 120, 'pending', undefined],
        [3, 180, 'running', 30],
        [6, 360, 'pending', undefined],
      ],
    );
    const e = runbookEstimate(steps);
    assert.equal(e.leftSeconds, 120 + 150 + 360);
    assert.equal(textEstimateSteps(md, undefined, 'windows').find((s) => s.estimateSeconds === 300)?.cell, 5);
  });
});

describe('estimate= in the reports and the command line', () => {
  const steps: StepResult[] = [
    { step: 1, line: 3, language: 'bash', title: 'echo a', status: 'passed', exit: '0', durationMs: 1200, estimateSeconds: 150, output: 'a' },
    { step: 2, line: 7, language: 'bash', title: 'echo b', status: 'passed', exit: '0', durationMs: 10, output: 'b' },
  ];

  it('JUnit: a property of the test case; the Markdown summary: beside the time', () => {
    const x = junitReport('r.md', steps);
    assert.match(x, /time="1.200"><properties><property name="estimate" value="150"\/><\/properties><\/testcase>/);
    assert.match(x, /name="Step 2: echo b" time="0.010"><\/testcase>/);
    const md = markdownSummary('r.md', steps);
    assert.match(md, /\| 1\.2s \(est\. 2m30s\) \|/);
    assert.match(md, /\| 0\.0s \| +\|/);
  });

  it('the HTML report shows it with the duration', () => {
    const html = renderReport('# T\n\n```bash estimate=2m30s\necho a\n```\n<!-- md-runbook:output start exit=0 duration=1.200s -->\n```text\na\n```\n<!-- md-runbook:output end -->\n', {
      generatedAt: new Date(0),
    });
    assert.match(html, /<td>1\.200s · est\. 2m30s<\/td>/);
    assert.match(html, /1\.200s · est\. 2m30s<\/div>/);
  });

  it('md-runbook estimate: one line per section, the blocks without one, the total', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-est-'));
    try {
      const file = path.join(dir, 'g.md');
      fs.writeFileSync(file, '# Guide\n\n## 1. Start\n\n' + fence('bash estimate=2m') + fence('bash') + '## 2. Wait\n\n' + fence('bash estimate=1m30s') + '## 3. Read\n\ntext\n\n## 4. Unknown\n\n' + fence('bash'));
      const lines: string[] = [];
      assert.equal(estimate([file], (l) => void lines.push(l)), 0);
      assert.deepEqual(lines, [
        file,
        '  # Guide        –',
        '  ## 1. Start    2m (1 block without an estimate)',
        '  ## 2. Wait     1m30s',
        '  ## 3. Read     –',
        '  ## 4. Unknown  ? (1 block without an estimate)',
        '  Total: 3m30s (2 blocks without an estimate) for 4 blocks',
      ]);
      const missing: string[] = [];
      assert.equal(estimate([path.join(dir, 'nope.md')], (l) => void missing.push(l)), 1);
      assert.match(missing[0]!, /no such file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('estimate= in a run', { skip: !hasBash && 'bash not installed' }, () => {
  const run = async (md: string, progress: boolean) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-est-'));
    const file = path.join(dir, 'r.md');
    fs.writeFileSync(file, md);
    const lines: string[] = [];
    try {
      const r = await runRunbook(
        { file, write: false, params: {}, inputs: {}, yes: false, keepGoing: false, shell: settings, env: process.env, progress },
        { out: (t) => lines.push(t), log: (l) => lines.push(l + '\n') },
      );
      return { ...r, printed: lines.join('') };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  const md = '# T\n\n' + fence('bash estimate=2m30s', 'echo one') + fence('bash', 'echo two') + fence('bash estimate=1m', 'echo three');

  it('the step line names it, the results carry it, and the progress follows the estimates', async () => {
    const r = await run(md, true);
    assert.equal(r.ok, true, r.printed);
    assert.match(r.printed, /▶ Step 1 · r\.md:3 · bash · est\. 2m30s\n/);
    assert.match(r.printed, /▶ Step 2 · r\.md:7 · bash\n/);
    assert.deepEqual(
      r.steps.map((s) => s.estimateSeconds),
      [150, undefined, 60],
    );
    assert.ok(!('estimateSeconds' in r.steps[1]!));
    const progress = r.printed.split('\n').filter((l) => l.startsWith('  ['));
    assert.deepEqual(progress, [
      '  [##############......] 71% · 1m left · 1 block without an estimate',
      '  [##############......] 71% · 1m left',
      '  [####################] 100% · nothing left',
    ]);
    assert.doesNotMatch(r.printed, /more than twice its estimate/);
  });

  it('no progress lines when not asked (not a terminal)', async () => {
    const r = await run(md, false);
    assert.doesNotMatch(r.printed, /^ {2}\[/m);
  });
});

describe('status line helpers', () => {
  it('time left moves in seconds under two minutes', () => {
    assert.equal(formatTimeLeft(0), '0s');
    assert.equal(formatTimeLeft(45.4), '45s');
    assert.equal(formatTimeLeft(100), '1m 40s');
    assert.equal(formatTimeLeft(60), '1m');
    assert.equal(formatTimeLeft(150), '3 min');
    assert.equal(formatTimeLeft(3600 + 600), '1 h 10 min');
  });

  it('never 100% or nothing left while a step is open', () => {
    assert.deepEqual(remaining({ fraction: 1, leftSeconds: 0 }, 1), { percent: 99, left: '1 step left' });
    assert.deepEqual(remaining({ fraction: 1, leftSeconds: 0 }, 0), { percent: 100, left: 'nothing left' });
    assert.deepEqual(remaining({ fraction: 0.41, leftSeconds: 210 }, 3), { percent: 41, left: '4 min left' });
    assert.deepEqual(remaining({ leftSeconds: 0 }, 2), { left: '2 steps left' });
  });

  it('finish time is local HH:MM', () => {
    const now = new Date(2026, 10, 14, 14, 30, 0).getTime();
    assert.equal(formatFinish(125, now), '14:32');
    assert.equal(formatFinish(-5, now), '14:30');
  });

  it('a finished run over its estimate is shown from a quarter and 10 s over', () => {
    assert.equal(overEstimate(7, 5), undefined, 'noise');
    assert.equal(overEstimate(190, 150), 40);
    assert.equal(overEstimate(160, 150), undefined, 'under a quarter');
    assert.equal(overEstimate(16.5, 3), 13.5);
  });

  it('suggests a round estimate from a run', () => {
    assert.equal(suggestedEstimate(47), 50);
    assert.equal(suggestedEstimate(190), 195);
    assert.equal(suggestedEstimate(16.5), 20);
    assert.equal(suggestedEstimate(3700), 3900);
  });

  it('block bar: thick, fixed width, clamped', () => {
    assert.equal(blockBar(0, 4), '░░░░');
    assert.equal(blockBar(1, 4), '████');
    assert.equal(blockBar(2, 4), '████');
    assert.equal(blockBar(0.5, 4), '██░░');
    assert.equal(blockBar(0.6, 4), '██░░');
    for (const f of [0, 0.01, 0.33, 0.5, 0.99, 1]) assert.equal([...blockBar(f, 20)].length, 20, String(f));
  });

  it('terminal bar width fits the line', () => {
    assert.equal(terminalBarWidth(undefined, 90), 20);
    assert.equal(terminalBarWidth(80, 90), 10);
    assert.equal(terminalBarWidth(200, 90), 30);
    assert.equal(terminalBarWidth(120, 90), 26);
  });

  it('step label: name=, then a call section, then the first line', () => {
    assert.equal(stepLabel('bash name="Push image"', 'docker push x', 'bash'), 'Push image');
    assert.equal(stepLabel('bash', '\n  kubectl rollout status deploy/api --timeout=10m --watch\n', 'bash'), 'kubectl rollout status deploy/api --tim…');
    assert.equal(stepLabel('runbook src=../lab.md section="Start the lab"', '', 'runbook'), 'Start the lab');
  });
});

/**
 * Setup and teardown (core/parts.ts): the `setup`, `teardown` and `ready` options, their lint,
 * the estimates in three parts, and `md-runbook run` with a ready check, a setup call to a
 * resource runbook and the teardown flags (real bash; the runs are skipped without it).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ShellSettings, locateCodeCells, parse } from '@md-runbook/core';
import { nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { estimateRunbook, formatParts, formatRunbookEstimate, runbookEstimate, textPartStates } from '@md-runbook/core/estimate';
import { lintRunbook } from '@md-runbook/core/lint';
import { partProblems } from '@md-runbook/core/parts';
import { CliOptions, RunSummary, runRunbook } from '../src/cli/run';
import { estimate, parseArgs } from '../src/cli/main';

const settings: ShellSettings = { bashPath: process.env.MD_RUNBOOK_BASH };
const hasBash = resolveShell('bash', settings, nodeShellEnv()).ok;

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';

/** A guide with its own ready check: lab.up next to it is "the lab". */
const GUIDE = [
  '# Guide',
  '',
  fence('bash ready name="the lab"', 'test -f lab.up'),
  '## 1. Start',
  '',
  fence('bash setup estimate=19m', 'touch lab.up'),
  '## 2. Work',
  '',
  fence('bash estimate=55m', 'echo work'),
  '## 3. Stop',
  '',
  fence('bash teardown estimate=2m', 'rm lab.up'),
].join('\n');

/** The resource runbook: the lab, defined once. */
const LAB = [
  '# The lab (ka4)',
  '',
  fence('bash ready name="Lab answers"', 'test -f lab.up'),
  '## Start the lab',
  '',
  fence('bash estimate=18m', 'touch lab.up'),
  '## Stop the lab (its data is kept)',
  '',
  fence('bash estimate=2m', 'rm -f lab.up'),
].join('\n');

const CALLER = [
  '# Guide 3',
  '',
  fence('runbook src=lab/ka4.md section="Start the lab" setup', ''),
  fence('bash estimate=55m', 'echo work'),
  fence('runbook src=lab/ka4.md section="Stop the lab" teardown', ''),
].join('\n');

function tmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-parts-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text, 'utf8');
  }
  return dir;
}

async function run(file: string, more: Partial<CliOptions> = {}): Promise<{ summary: RunSummary; log: string[] }> {
  const log: string[] = [];
  const summary = await runRunbook(
    { file, write: true, params: {}, inputs: {}, yes: false, keepGoing: false, shell: settings, env: process.env, ...more },
    { out: () => undefined, log: (l) => log.push(l) },
  );
  fs.writeFileSync(file, summary.text, 'utf8');
  return { summary, log };
}

const statuses = (s: RunSummary): string[] => s.steps.map((x) => `${x.part ?? '-'}:${x.status}`);

describe('setup and teardown: options and lint', () => {
  it('reads setup, teardown and ready; a block is only one of them', () => {
    assert.equal(parseCellOptions('bash setup').part, 'setup');
    assert.equal(parseCellOptions('runbook src=x.md teardown').part, 'teardown');
    assert.equal(parseCellOptions('bash ready').part, 'ready');
    const both = parseCellOptions('bash setup teardown');
    assert.equal(both.part, 'setup');
    assert.match(both.errors[0]!, /only one of setup, teardown and ready/);
  });

  it('accepts the parts in order', () => {
    assert.deepEqual(partProblems(locateCodeCells(parse(GUIDE))), []);
    assert.deepEqual(partProblems(locateCodeCells(parse(CALLER))), []);
    assert.deepEqual(
      lintRunbook(GUIDE).map((p) => p.message),
      [],
    );
  });

  it('reports setup after the body, a step after the teardown, two ready checks, a late or called ready check', () => {
    const doc = [
      fence('bash', 'echo body'),
      fence('bash setup', 'echo late setup'),
      fence('bash teardown', 'echo down'),
      fence('bash', 'echo after'),
      fence('bash ready', 'true'),
      fence('runbook src=x.md ready', ''),
    ].join('\n');
    const messages = lintRunbook(doc).filter((p) => p.severity === 'error').map((p) => p.message);
    assert.ok(messages.some((m) => /setup steps come before the runbook's own steps \(one is on line 1\)/.test(m)), messages.join('\n'));
    assert.ok(messages.some((m) => /a step after the teardown/.test(m)));
    assert.ok(messages.some((m) => /ready check comes before the setup steps/.test(m)));
    assert.ok(messages.some((m) => /not a runbook call/.test(m)));
    const twice = lintRunbook([fence('bash ready', 'true'), fence('bash ready', 'true')].join('\n')).map((p) => p.message);
    assert.ok(twice.some((m) => /one ready check \(the first one is on line 1\)/.test(m)));
  });
});

describe('setup and teardown: estimates', () => {
  const steps = [
    { estimateSeconds: 19 * 60, state: 'pending' as const, part: 'setup' as const },
    { estimateSeconds: 55 * 60, state: 'pending' as const },
    { estimateSeconds: 2 * 60, state: 'pending' as const, part: 'teardown' as const },
  ];

  it('counts the setup unless unchecked or up, the teardown only once chosen', () => {
    assert.equal(runbookEstimate(steps).leftSeconds, (19 + 55) * 60);
    assert.equal(runbookEstimate(steps, { setup: 'unchecked' }).leftSeconds, 55 * 60);
    assert.equal(runbookEstimate(steps, { setup: 'up' }).leftSeconds, 55 * 60);
    assert.equal(runbookEstimate(steps, { setup: 'up', teardown: 'chosen' }).leftSeconds, 57 * 60);
    const e = runbookEstimate(steps, { setup: 'unchecked' });
    assert.equal(e.parts?.setup.totalSeconds, 19 * 60);
    assert.equal(e.parts?.body.totalSeconds, 55 * 60);
    assert.equal(e.parts?.teardown.totalSeconds, 2 * 60);
    assert.equal(formatParts(e), '+19m if the setup runs · teardown 2m, offered');
    assert.equal(formatParts(runbookEstimate(steps, { setup: 'up' })), 'setup ✓ already up · teardown 2m, offered');
    assert.match(formatRunbookEstimate(runbookEstimate(steps, { setup: 'up' }))!, /0% · about 55 min left · setup ✓ already up · teardown 2m, offered$/);
  });

  it('leaves a runbook without parts as it was', () => {
    const plain = [{ estimateSeconds: 60, state: 'done' as const }, { estimateSeconds: 120, state: 'pending' as const }];
    const e = runbookEstimate(plain, { setup: 'up' });
    assert.equal(e.parts, undefined);
    assert.equal(e.totalSeconds, 180);
    assert.equal(formatParts(e), undefined);
  });

  it('sums the parts of a runbook; the ready check takes no time', () => {
    const s = estimateRunbook(GUIDE);
    assert.equal(s.totalSeconds, (19 + 55 + 2) * 60);
    assert.equal(s.blocks, 3);
    assert.equal(s.unestimated, 0);
    assert.deepEqual(s.parts.setup, { seconds: 19 * 60, blocks: 1, unestimated: 0 });
    assert.deepEqual(s.parts.teardown, { seconds: 2 * 60, blocks: 1, unestimated: 0 });
    assert.equal(s.guarded, true);
    assert.equal(estimateRunbook(CALLER).guarded, true);
  });

  it('reads how the parts stand from the outputs', () => {
    assert.deepEqual(textPartStates(GUIDE), { setup: 'unchecked', teardown: 'offered' });
    const out = (attrs: string): string => `<!-- md-runbook:output start ${attrs} -->\n\`\`\`text\nx\n\`\`\`\n<!-- md-runbook:output end -->\n`;
    const up = GUIDE.replace('touch lab.up\n```\n', `touch lab.up\n\`\`\`\n${out('exit=skipped ready=up')}`);
    assert.deepEqual(textPartStates(up), { setup: 'up', teardown: 'offered' });
    const ran = GUIDE.replace('touch lab.up\n```\n', `touch lab.up\n\`\`\`\n${out('exit=0')}`).replace('rm lab.up\n```\n', `rm lab.up\n\`\`\`\n${out('exit=0')}`);
    assert.deepEqual(textPartStates(ran), { setup: 'run', teardown: 'chosen' });
    // Without a ready check nothing can skip the setup.
    assert.deepEqual(textPartStates(fence('bash setup', 'x')), { setup: 'run', teardown: 'offered' });
  });

  it('md-runbook estimate prints the parts', () => {
    const dir = tmp({ 'guide.md': GUIDE });
    const lines: string[] = [];
    assert.equal(estimate([path.join(dir, 'guide.md')], (l) => lines.push(l)), 0);
    assert.ok(lines.includes('  Parts: setup 19m (skipped when already up) · runbook 55m · teardown 2m (offered)'), lines.join('\n'));
  });
});

describe('setup and teardown: command-line flags', () => {
  it('parses --teardown, --teardown=always, --setup, --setup-always and --no-setup', () => {
    const o = (args: string[]): ReturnType<typeof parseArgs> => parseArgs(['run', 'x.md', ...args]);
    const opts = (args: string[]) => {
      const p = o(args);
      assert.ok(typeof p === 'object');
      return p.options;
    };
    assert.equal(opts(['--teardown']).teardown, 'success');
    assert.equal(opts(['--teardown=always']).teardown, 'always');
    assert.equal(opts(['--setup']).addSetup, true);
    assert.equal(opts(['--setup-always']).setup, 'always');
    assert.equal(opts(['--no-setup']).setup, 'never');
    assert.throws(() => o(['--no-setup', '--setup-always']), /exclude each other/);
  });
});

describe('setup and teardown: md-runbook run', { skip: !hasBash && 'no bash' }, () => {
  it('runs the setup when the ready check says down, skips it when up, and only offers the teardown', async () => {
    const dir = tmp({ 'guide.md': GUIDE });
    const file = path.join(dir, 'guide.md');

    const cold = await run(file);
    assert.equal(cold.summary.ok, true);
    assert.deepEqual(statuses(cold.summary), ['ready:passed', 'setup:passed', 'body:passed', 'teardown:skipped']);
    assert.equal(cold.summary.setup?.ready, false);
    assert.ok(cold.log.some((l) => l === 'Setup: the lab is not up - about 19 min to set it up'), cold.log.join('\n'));
    assert.ok(cold.log.some((l) => /Step 4 \[teardown\] .*teardown, not run \(--teardown runs it\)/.test(l)));
    assert.ok(fs.existsSync(path.join(dir, 'lab.up')));
    assert.match(fs.readFileSync(file, 'utf8'), /exit=1 [^>]*check=ok [^>]*ready=down/);

    const warm = await run(file);
    assert.equal(warm.summary.ok, true);
    assert.deepEqual(statuses(warm.summary), ['ready:passed', 'setup:skipped', 'body:passed', 'teardown:skipped']);
    assert.equal(warm.summary.setup?.ready, true);
    assert.ok(warm.log.includes('Setup: the lab is already up - setup skipped'));
    assert.match(fs.readFileSync(file, 'utf8'), /exit=skipped ready=up/);
    assert.deepEqual(textPartStates(fs.readFileSync(file, 'utf8')), { setup: 'up', teardown: 'offered' });

    const down = await run(file, { teardown: 'success' });
    assert.deepEqual(statuses(down.summary), ['ready:passed', 'setup:skipped', 'body:passed', 'teardown:passed']);
    assert.equal(fs.existsSync(path.join(dir, 'lab.up')), false);
  });

  it('--setup-always runs the setup anyway, --no-setup runs neither it nor the check', async () => {
    const dir = tmp({ 'guide.md': GUIDE, 'lab.up': '' });
    const file = path.join(dir, 'guide.md');
    const always = await run(file, { setup: 'always' });
    assert.deepEqual(statuses(always.summary), ['ready:skipped', 'setup:passed', 'body:passed', 'teardown:skipped']);
    fs.rmSync(path.join(dir, 'lab.up'));
    const never = await run(file, { setup: 'never' });
    assert.deepEqual(statuses(never.summary), ['ready:skipped', 'setup:skipped', 'body:passed', 'teardown:skipped']);
    assert.equal(fs.existsSync(path.join(dir, 'lab.up')), false);
  });

  it('--from N --setup brings the setup back when it is down, and leaves it when up', async () => {
    const dir = tmp({ 'guide.md': GUIDE });
    const file = path.join(dir, 'guide.md');
    const resumed = await run(file, { from: 3, addSetup: true });
    assert.deepEqual(statuses(resumed.summary), ['ready:passed', 'setup:passed', 'body:passed', 'teardown:skipped']);
    assert.ok(fs.existsSync(path.join(dir, 'lab.up')));
    const plain = await run(file, { from: 3 });
    assert.deepEqual(statuses(plain.summary), ['ready:skipped', 'setup:skipped', 'body:passed', 'teardown:skipped']);
  });

  it('runs the teardown after a failure only with --teardown=always', async () => {
    const failing = GUIDE.replace('echo work', 'exit 3');
    for (const [mode, expected] of [
      ['success', 'teardown:not run'],
      ['always', 'teardown:passed'],
    ] as const) {
      const dir = tmp({ 'guide.md': failing });
      const r = await run(path.join(dir, 'guide.md'), { teardown: mode });
      assert.equal(r.summary.ok, false);
      assert.equal(statuses(r.summary)[3], expected, mode);
      assert.equal(fs.existsSync(path.join(dir, 'lab.up')), mode !== 'always');
    }
  });

  it('a setup call runs the resource runbook\'s ready check first; up, it is skipped', async () => {
    const dir = tmp({ 'guide.md': CALLER, 'lab/ka4.md': LAB });
    const file = path.join(dir, 'guide.md');
    const flag = path.join(dir, 'lab', 'lab.up');

    const cold = await run(file, { copyFolder: '.' });
    assert.equal(cold.summary.ok, true, cold.log.join('\n'));
    assert.deepEqual(statuses(cold.summary), ['setup:passed', 'body:passed', 'teardown:skipped']);
    assert.equal(cold.summary.setup?.ready, false);
    assert.ok(cold.log.some((l) => /Setup: The lab \(ka4\) is not up - about 18 min to set it up/.test(l)), cold.log.join('\n'));
    assert.ok(fs.existsSync(flag));

    const warm = await run(file, { copyFolder: '.' });
    assert.deepEqual(statuses(warm.summary), ['setup:skipped', 'body:passed', 'teardown:skipped']);
    assert.equal(warm.summary.setup?.ready, true);
    assert.equal(warm.summary.steps[0]!.message, 'already up');
    assert.ok(warm.log.some((l) => /Setup: The lab \(ka4\) is already up - setup skipped/.test(l)), warm.log.join('\n'));
    assert.match(fs.readFileSync(file, 'utf8'), /exit=skipped ready=up/);

    const down = await run(file, { copyFolder: '.', teardown: 'success' });
    assert.deepEqual(statuses(down.summary), ['setup:skipped', 'body:passed', 'teardown:passed']);
    assert.equal(fs.existsSync(flag), false);
  });
});

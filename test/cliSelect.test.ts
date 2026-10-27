/**
 * Part of a runbook from the command line (--from, --to, --section), and what `md-runbook run`
 * refuses before the first step: a bad selection, a capture left out.
 * The runs use real bash (skipped without it).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ShellSettings, locateCodeCells, parse } from '@md-runbook/core';
import { nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { stepNumbers } from '@md-runbook/core/os';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { parseArgs } from '../src/cli/main';
import { CliOptions, RunSummary, runRunbook } from '../src/cli/run';
import { RunUsageError, Selection, formatSteps, headingsOf, selectSteps } from '../src/cli/select';

const settings: ShellSettings = { bashPath: process.env.MD_RUNBOOK_BASH };
const hasBash = resolveShell('bash', settings, nodeShellEnv()).ok;

// Steps: 1 one, 2 two (captures X), 3 three (os= alternatives), 4 four (uses X), 5 five, 6 six.
const RUNBOOK = [
  '---',
  'params:',
  '- A: 1',
  '---',
  '',
  '# Runbook',
  '',
  '```yaml',
  '# Fake heading in a YAML block',
  '```',
  '',
  '## 1. Prepare',
  '',
  '```bash',
  'echo one',
  '```',
  '',
  '### 1.1 Details ###',
  '',
  '```bash capture=X',
  'echo two',
  '```',
  '',
  '## 2. Work',
  '',
  '```bash os=windows',
  'echo three',
  '```',
  '',
  '```bash os=linux,macos',
  'echo three',
  '```',
  '',
  '```bash',
  'echo "four ${out:X}"',
  '```',
  '',
  '### 2.1 Notes',
  '',
  'Nothing to run here.',
  '',
  '## 20. Not two',
  '',
  '```bash',
  'echo five',
  '```',
  '',
  '# Appendix',
  '',
  '```bash',
  'echo six',
  '```',
  '',
].join('\n');

/** The selection as runRunbook makes it. */
const select = (text: string, s: Selection): number[] | undefined => {
  const doc = parse(text);
  const locs = locateCodeCells(doc);
  const numbers = stepNumbers(doc.cells.map((c) => (c.kind === 'code' ? { kind: 'code' as const, os: parseCellOptions(c.meta.kind === 'code' ? c.meta.info : '').os } : { kind: 'markup' as const })));
  const selected = selectSteps(text, locs, locs.map((l) => numbers[l.cellIndex]!), s);
  return selected && [...selected].sort((a, b) => a - b);
};

describe('cli: --from, --to and --section arguments', () => {
  it('parses them', () => {
    const p = parseArgs(['run', 'x.md', '--from', '3', '--to', '12', '--section', '3.', '--section', 'Rollback']);
    assert.ok(typeof p === 'object');
    assert.equal(p.options.from, 3);
    assert.equal(p.options.to, 12);
    assert.deepEqual(p.options.sections, ['3.', 'Rollback']);
  });

  it('refuses what is not a step number, an empty section and a backwards range', () => {
    assert.throws(() => parseArgs(['run', 'x.md', '--from', '0']), /--from expects a step number/);
    assert.throws(() => parseArgs(['run', 'x.md', '--to', '2a']), /--to expects a step number/);
    assert.throws(() => parseArgs(['run', 'x.md', '--from', '-1']), /--from needs a value|--from expects/);
    assert.throws(() => parseArgs(['run', 'x.md', '--section', ' ']), /--section needs/);
    assert.throws(() => parseArgs(['run', 'x.md', '--from', '4', '--to', '3']), /--from 4 is after --to 3/);
  });
});

describe('cli: selecting steps', () => {
  it('finds ATX headings, not in the front matter or in fenced blocks', () => {
    assert.deepEqual(
      headingsOf(RUNBOOK).map((h) => `${h.level} ${h.text}`),
      ['1 Runbook', '2 1. Prepare', '3 1.1 Details', '2 2. Work', '3 2.1 Notes', '2 20. Not two', '1 Appendix'],
    );
    assert.deepEqual(headingsOf('#nope\n    # indented code\n  ## Yes  \n#\n').map((h) => h.text), ['Yes', '']);
  });

  it('--from/--to select by the run’s step numbers (os= alternatives are one step)', () => {
    assert.equal(select(RUNBOOK, {}), undefined);
    assert.deepEqual(select(RUNBOOK, { from: 5 }), [5, 6]);
    assert.deepEqual(select(RUNBOOK, { to: 2 }), [1, 2]);
    assert.deepEqual(select(RUNBOOK, { from: 3, to: 3 }), [3]);
  });

  it('--section matches the start of a heading, with its sub-headings, until the next one of its level', () => {
    assert.deepEqual(select(RUNBOOK, { sections: ['1.'] }), [1, 2]);
    assert.deepEqual(select(RUNBOOK, { sections: ['2.'] }), [3, 4], '"20. Not two" does not start with "2."');
    assert.deepEqual(select(RUNBOOK, { sections: ['2'] }), [3, 4, 5]);
    assert.deepEqual(select(RUNBOOK, { sections: ['1.1'] }), [2]);
    assert.deepEqual(select(RUNBOOK, { sections: ['Runbook'] }), [1, 2, 3, 4, 5]);
    assert.deepEqual(select(RUNBOOK, { sections: ['Appendix', '1.'] }), [1, 2, 6]);
    assert.deepEqual(select(RUNBOOK, { sections: ['2.', 'Appendix'], from: 4 }), [4, 6], 'both must hold');
  });

  it('a range outside the runbook, a section without a heading or an empty selection is a usage error', () => {
    assert.throws(() => select(RUNBOOK, { from: 7 }), (e: Error) => e instanceof RunUsageError && /--from 7 is outside the runbook: it has steps 1 to 6/.test(e.message));
    assert.throws(() => select(RUNBOOK, { to: 0 }), /--to 0 is outside the runbook/);
    assert.throws(() => select(RUNBOOK, { from: 4, to: 3 }), /--from 4 is after --to 3/);
    assert.throws(() => select('# T\n', { from: 1 }), /it has no steps/);
    assert.throws(() => select(RUNBOOK, { sections: ['1.', 'Fake', 'appendix'] }), /no heading starts with "Fake", "appendix"/);
    assert.throws(() => select(RUNBOOK, { sections: ['2.1'] }), /--section "2.1" selects no step/);
    assert.throws(() => select(RUNBOOK, { sections: ['1.'], from: 3 }), /--from 3 --section "1." selects no step/);
  });

  it('formats step lists', () => {
    assert.equal(formatSteps([7, 1, 2, 3, 5, 8]), '1–3, 5, 7–8');
  });
});

describe('cli: running part of a runbook', { skip: !hasBash && 'bash not installed' }, () => {
  const tmp = (md: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-sel-'));
    fs.writeFileSync(path.join(dir, 'r.md'), md);
    return dir;
  };
  type Ran = Partial<RunSummary> & { error?: Error; printed: string };
  const run = async (md: string, extra: Partial<CliOptions> = {}): Promise<Ran> => {
    const dir = tmp(md);
    const lines: string[] = [];
    try {
      const r = await runRunbook(
        { file: path.join(dir, 'r.md'), write: true, params: {}, inputs: {}, yes: false, keepGoing: false, shell: settings, env: process.env, ...extra },
        { out: (t) => lines.push(t), log: (l) => lines.push(l + '\n') },
      );
      return { ...r, printed: lines.join('') };
    } catch (e) {
      return { error: e as Error, printed: lines.join('') };
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
  const statuses = (r: Ran) => r.steps?.map((s) => s.status);

  it('--from keeps the numbers of a full run; the others are skipped, not failed, and keep their outputs', async () => {
    const full = await run(RUNBOOK);
    const part = await run(full.text!, { from: 5 });
    assert.equal(part.ok, true, part.printed);
    assert.deepEqual(part.steps!.map((s) => s.step), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(statuses(part), ['skipped', 'skipped', 'skipped', 'skipped', 'passed', 'passed']);
    assert.equal(part.steps![4]!.title, full.steps![4]!.title);
    assert.match(part.steps![0]!.message ?? '', /^not selected \(--from 5\)$/);
    assert.match(part.printed, /^Steps 5–6 of 6 \(--from 5\)\n▶ Step 5 · r\.md:\d+ · bash\n/);
    assert.doesNotMatch(part.printed, /▶ Step [1-4] /);
    // The outputs of steps 1-4 are those of the full run.
    const outputs = (t: string) => t.match(/<!-- md-runbook:output start[^\n]*/g) ?? [];
    assert.deepEqual(outputs(part.text!).slice(0, 4), outputs(full.text!).slice(0, 4));
  });

  it('--from/--to with a capture inside the range, and --section with --to', async () => {
    const r = await run(RUNBOOK, { from: 2, to: 4 });
    assert.deepEqual(statuses(r), ['skipped', 'passed', 'passed', 'passed', 'skipped', 'skipped'], r.printed);
    assert.match(r.printed, /four two/);
    const s = await run(RUNBOOK, { sections: ['20', 'Appendix'], to: 5 });
    assert.deepEqual(statuses(s), ['skipped', 'skipped', 'skipped', 'skipped', 'passed', 'skipped'], s.printed);
    assert.equal(s.steps![5]!.message, 'not selected (--to 5 --section "20" --section "Appendix")');
  });

  it('a step whose ${out:} capture is left out of the selection stops the run before it starts', async () => {
    const r = await run(RUNBOOK, { from: 3 });
    assert.ok(r.error instanceof RunUsageError, r.printed);
    assert.match(r.error.message, /^step 4 \(r\.md:\d+\) uses \$\{out:X\}, captured by step 2 \(r\.md:\d+\), which is not selected\n/);
    assert.match(r.error.message, /nothing ran$/);
    assert.equal(r.printed, '');
  });
});

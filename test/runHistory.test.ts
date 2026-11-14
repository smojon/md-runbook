import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RunSummary, ago, formatWhen, lastGreenOf, lastGreenText, originalName, ranSteps, runItem, transcriptLine, withRun } from '../src/runHistory';

const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime();
const at = (day: number, h: number, m: number, s = 0): number => new Date(2026, 10, day, h, m, s).getTime();

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  started: at(14, 14, 32),
  ended: at(14, 14, 35, 10),
  uri: 'file:///w/deploy.md',
  by: 'smojon',
  cells: [1, 2],
  steps: ['text:1', 'text:2'],
  passed: 2,
  failed: 0,
  skipped: 0,
  total: 6,
  complete: 6,
  green: true,
  ...over,
});

describe('run history', () => {
  it('keeps the last runs of each runbook and the most recently run runbooks', () => {
    let all = withRun(undefined, 'a', run({ started: 1 }), 3, 2);
    for (let i = 2; i <= 5; i++) all = withRun(all, 'a', run({ started: i }), 3, 2);
    assert.deepEqual(all.a!.map((r) => r.started), [3, 4, 5], 'the oldest runs go');
    const before = all;
    all = withRun(all, 'b', run(), 3, 2);
    assert.deepEqual(Object.keys(all), ['a', 'b']);
    assert.equal(before.b, undefined, 'the store passed in is not changed');
    // A third runbook drops the one run least recently; running one again moves it last.
    all = withRun(all, 'a', run({ started: 6 }), 3, 2);
    assert.deepEqual(Object.keys(all), ['b', 'a']);
    all = withRun(all, 'c', run(), 3, 2);
    assert.deepEqual(Object.keys(all), ['a', 'c']);
  });

  it('a run copy counts for the runbook it was copied from', () => {
    assert.equal(originalName('deploy.20261114-142000.md'), 'deploy.md');
    assert.equal(originalName('deploy.runbook.20261114-142000-2.MD'), 'deploy.runbook.md');
    assert.equal(originalName('deploy.md'), undefined);
    assert.equal(originalName('notes-20261114.md'), undefined);
  });

  it('last ran green: the last run after which every step was done', () => {
    assert.equal(lastGreenOf(undefined), undefined);
    assert.equal(lastGreenOf([run({ green: false })]), undefined);
    const runs = [run({ ended: 10, by: 'ann' }), run({ ended: 20, by: 'bob' }), run({ ended: 30, green: false })];
    assert.deepEqual(lastGreenOf(runs), { at: 20, by: 'bob' });
    const { by: _, ...nobody } = run({ ended: 40 });
    assert.deepEqual(lastGreenOf([nobody]), { at: 40 });
    assert.equal(lastGreenText(undefined, NOW), 'Never ran green');
    assert.equal(lastGreenText({ at: NOW - 3 * 86_400_000 - 5000, by: 'smojon' }, NOW), 'Last ran green: 3 days ago (by smojon)');
    assert.equal(lastGreenText({ at: NOW - 20_000 }, NOW), 'Last ran green: just now');
  });

  it('how long ago, roughly', () => {
    assert.equal(ago(NOW - 59_000, NOW), 'just now');
    assert.equal(ago(NOW - 60_000, NOW), '1 minute ago');
    assert.equal(ago(NOW - 5 * 60_000, NOW), '5 minutes ago');
    assert.equal(ago(NOW - 2 * 3_600_000, NOW), '2 hours ago');
    assert.equal(ago(NOW - 86_400_000, NOW), '1 day ago');
    assert.equal(ago(NOW - 90 * 86_400_000, NOW), '3 months ago');
    assert.equal(ago(NOW - 800 * 86_400_000, NOW), '2 years ago');
    assert.equal(ago(NOW + 5000, NOW), 'just now', 'a clock set back');
  });

  it('Show Runs labels: done, failed, stopped, one step, part of the runbook', () => {
    assert.equal(formatWhen(at(14, 9, 5), NOW), '14 Nov 09:05');
    assert.equal(formatWhen(new Date(2025, 0, 2, 8, 0).getTime(), NOW), '2 Jan 2025 08:00');
    assert.deepEqual(runItem(run({ cells: [0, 1, 2, 3, 4, 5], passed: 6 }), NOW), { label: '✓ Done · 6 of 6 · 14 Nov 14:32 · 3m10s', detail: 'by smojon · 6 passed' });
    const failed = run({ green: false, complete: 3, passed: 3, failed: 1, firstFailed: { cell: 7, step: 4, label: 'Push image' } });
    assert.deepEqual(runItem(failed, NOW), { label: '✗ Step 4 of 6 failed — Push image · 14 Nov 14:32 · 3m10s', detail: 'by smojon · 3 passed, 1 failed' });
    assert.equal(runItem({ ...failed, stopped: true }, NOW).label, '■ Stopped at step 4 of 6 — Push image · 14 Nov 14:32 · 3m10s');
    assert.equal(runItem({ ...failed, firstFailed: { cell: 0, label: 'Ready?' } }, NOW).label, '✗ Cell 1 failed — Ready? · 14 Nov 14:32 · 3m10s');
    const one = run({ green: false, complete: 2, passed: 1, cells: [3], single: { cell: 3, step: 2, label: 'Build' }, ended: at(14, 14, 32, 4) });
    assert.equal(runItem(one, NOW).label, '○ Step 2 of 6 passed — Build · 14 Nov 14:32 · 4s');
    assert.equal(runItem({ ...one, passed: 0, skipped: 1 }, NOW).detail, 'by smojon · 0 passed, 1 skipped');
    assert.equal(runItem(run({ green: false, complete: 4, cells: [1, 2, 3] }), NOW).label, '○ 4 of 6 done · 14 Nov 14:32 · 3m10s');
    // A run copy says which one.
    assert.equal(runItem(run({ uri: 'file:///w/runs/deploy.20261114-143200.md' }), NOW).detail, 'by smojon · 2 passed · in deploy.20261114-143200.md');
  });

  it('the steps that ran in any recorded run', () => {
    assert.deepEqual([...ranSteps([run({ steps: ['a', 'b'] }), run({ steps: ['b', 'c'] })])].sort(), ['a', 'b', 'c']);
    assert.equal(ranSteps(undefined).size, 0);
  });

  it("finds a run's first entry in the transcript", () => {
    const iso = (t: number): string => {
      const d = new Date(t);
      const pad = (n: number): string => String(Math.abs(n)).padStart(2, '0');
      const off = -d.getTimezoneOffset();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
    };
    const text = [
      `===== ${iso(at(13, 9, 0))} · deploy.md · Step 1 · Build`,
      '$ make',
      '===== exit=0 · 1.0s',
      '',
      `===== ${iso(at(14, 14, 32))} · deploy.md · Step 1 · Build`,
      '| ===== 2026-11-14T14:33:00+00:00 · not a header',
      '===== exit=0 · 1.0s',
      '',
      `===== ${iso(at(14, 14, 40))} · deploy.md · Step 2 · Push`,
    ].join('\n');
    assert.equal(transcriptLine(text, at(13, 9, 0, 0) + 300, at(13, 9, 1)), 0, 'started part way into the second of the header');
    assert.equal(transcriptLine(text, at(14, 14, 31, 59), at(14, 14, 35)), 4);
    assert.equal(transcriptLine(text, at(14, 14, 39), at(14, 14, 41)), 8);
    assert.equal(transcriptLine(text, at(14, 16, 0), at(14, 16, 5)), undefined, 'not in the transcript');
    assert.equal(transcriptLine(text.replace(/\n/g, '\r\n'), at(14, 14, 31, 59), at(14, 14, 35)), 4);
  });
});

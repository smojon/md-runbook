/** The words of a run's progress, shared by the CLI, VS Code and the app (core/runStatus.ts). */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cellRunStatus, runProgressLine, spokenSteps, stepFailed, stepOfTotal } from '@md-runbook/core/runStatus';
import { runbookEstimate } from '@md-runbook/core/estimate';

describe('cellRunStatus (a running cell)', () => {
  it('against an estimate: the time so far of about the estimate, and the bar', () => {
    const s = cellRunStatus({ elapsedSeconds: 12.7, estimateSeconds: 30 });
    assert.equal(s.text, 'running · 12s of about 30s');
    assert.equal(s.line, 'running · 12s of about 30s');
    assert.ok(Math.abs(s.fraction! - 12.7 / 30) < 1e-9);
    assert.equal(s.over, false);
    assert.equal(s.attempt, undefined);
  });

  it('past the estimate: by how much, the bar full and in the warning colour', () => {
    const s = cellRunStatus({ elapsedSeconds: 45, estimateSeconds: 30 });
    assert.equal(s.text, 'running · 45s · 15s over about 30s');
    assert.equal(s.fraction, 1);
    assert.equal(s.over, true);
    assert.equal(cellRunStatus({ elapsedSeconds: 150, estimateSeconds: 90 }).text, 'running · 2m30s · 1m over about 1m30s');
  });

  it('without an estimate: a counter and no bar', () => {
    const s = cellRunStatus({ elapsedSeconds: 12 });
    assert.equal(s.text, 'running · 12s');
    assert.equal(s.fraction, undefined);
    assert.equal(s.over, false);
    assert.equal(cellRunStatus({ elapsedSeconds: 0.4 }).text, 'running · 0s', 'whole seconds');
    assert.equal(cellRunStatus({ elapsedSeconds: -3 }).text, 'running · 0s');
    assert.equal(cellRunStatus({ elapsedSeconds: 5, estimateSeconds: 0 }).text, 'running · 5s', 'estimate=0 is none');
  });

  it('retry=: the attempt, beside the time', () => {
    const s = cellRunStatus({ elapsedSeconds: 12, estimateSeconds: 30, attempt: 2, attempts: 5 });
    assert.equal(s.attempt, 'attempt 2/5');
    assert.equal(s.line, 'running · 12s of about 30s · attempt 2/5');
    assert.equal(cellRunStatus({ elapsedSeconds: 1, attempt: 1, attempts: 1 }).attempt, undefined, 'no retry=: no attempt');
  });
});

describe('runProgressLine (where the run is)', () => {
  const steps = (done: number, todo: number, each = 30) => [
    ...Array.from({ length: done }, () => ({ estimateSeconds: each, state: 'done' as const })),
    ...Array.from({ length: todo }, () => ({ estimateSeconds: each, state: 'pending' as const })),
  ];

  it('the step, the share by the estimates and the time left', () => {
    const e = runbookEstimate(steps(3, 4, 30));
    const r = runProgressLine({ step: 4, total: 7, estimate: e, open: 4, percent: true });
    assert.equal(r.text, 'Step 4/7 · 42% · 2 min left');
    assert.ok(Math.abs(r.fraction - 3 / 7) < 1e-9);
  });

  it('a label, and no share unless asked (the status bar)', () => {
    const e = runbookEstimate(steps(1, 1, 100));
    assert.equal(runProgressLine({ step: 2, total: 2, label: 'Push image', estimate: e, open: 1 }).text, 'Step 2/2 · Push image · 1m 40s left');
    assert.equal(runProgressLine({ where: 'Ready check', total: 2, label: 'Is it up', estimate: e, open: 1 }).text, 'Ready check · Is it up · 1m 40s left');
  });

  it('steps without an estimate: no share, the time left as a floor', () => {
    const e = runbookEstimate([...steps(1, 1, 120), { state: 'pending' }]);
    assert.equal(runProgressLine({ step: 2, total: 3, estimate: e, open: 2, percent: true }).text, 'Step 2/3 · at least 2 min left');
  });

  it('no estimates at all: only the step; the bar by the steps done', () => {
    const e = runbookEstimate([{ state: 'done' }, { state: 'pending' }, { state: 'pending' }, { state: 'pending' }]);
    const r = runProgressLine({ step: 2, total: 4, estimate: e, open: 3, percent: true, stepsDone: 1 / 4 });
    assert.equal(r.text, 'Step 2/4');
    assert.equal(r.fraction, 0.25);
  });

  it('never 100% while a step is open', () => {
    const e = runbookEstimate([{ estimateSeconds: 60, state: 'done' }, { state: 'pending' }]);
    const r = runProgressLine({ step: 2, total: 2, estimate: { ...e, unestimatedLeft: 0 }, open: 1, percent: true });
    assert.equal(r.text, 'Step 2/2 · 99%');
    assert.equal(r.fraction, 0.99);
  });
});

describe('step words', () => {
  it('Step N/M, failed, and as a screen reader says it', () => {
    assert.equal(stepOfTotal(3, 7), 'Step 3/7');
    assert.equal(stepFailed(4, 7), 'Step 4/7 failed');
    assert.equal(spokenSteps('Step 4/7 failed · Done · 6/6'), 'Step 4 of 7 failed · Done · 6 of 6');
  });
});

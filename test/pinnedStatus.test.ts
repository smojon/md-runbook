/**
 * A running cell's status in VS Code (src/pinnedStatus.ts): kept last while new outputs come in,
 * changed only when its data does, emptied when the run ends. A fake cell stands in for the
 * notebook API. The renderer's words (renderer/runningView.ts) are tested at the end.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isRunningData, msToNextSecond, runningView } from '../renderer/runningView';
import { OutputSink, PinnedStatus, RunningData } from '../src/pinnedStatus';

interface Out {
  name: string;
  items: RunningData[];
}

/** A cell's outputs, as VS Code keeps them: append, replace the items of one (it must be there). */
class FakeCell implements OutputSink<Out, RunningData> {
  outputs: Out[] = [];
  replaced = 0;
  constructor(private readonly clock: { t: number } = { t: 0 }) {}
  async appendOutput(out: readonly Out[]): Promise<void> {
    this.outputs.push(...out);
  }
  async replaceOutputItems(items: readonly RunningData[], output: Out): Promise<void> {
    this.replaced++;
    if (!this.outputs.includes(output)) throw new Error('no such output');
    output.items = [...items];
  }
  /** What shows: the outputs with items, last the status as the renderer draws it now. */
  shown(): string[] {
    return this.outputs.filter((o) => o.items.length > 0).map((o) => (o.name === 'status' ? `[${runningView(o.items[0]!, this.clock.t).line}]` : o.name));
  }
}

const live = (name: string): Out => ({ name, items: [{ startedAt: 0 }] });

const pinned = (cell: FakeCell, estimate?: number, attempts = 1) =>
  new PinnedStatus<Out, RunningData>(cell, { output: (s) => ({ name: 'status', items: [s] }), item: (s) => s }, 0, estimate, attempts);

describe('the running status under a cell (VS Code)', () => {
  it('stays last while the output grows and switches streams, and goes at the end', async () => {
    const clock = { t: 0 };
    const cell = new FakeCell(clock);
    await cell.appendOutput([live('stdout 1')]);
    const s = pinned(cell, 30);
    await s.start();
    assert.deepEqual(cell.shown(), ['stdout 1', '[running · 0s of about 30s]']);
    clock.t = 12_000;
    await s.append([live('stderr 1')]);
    assert.deepEqual(cell.shown(), ['stdout 1', 'stderr 1', '[running · 12s of about 30s]']);
    await s.append([live('stdout 2')]);
    assert.equal(cell.shown().at(-1), '[running · 12s of about 30s]', 'still last');
    assert.equal(cell.outputs.filter((o) => o.name === 'status' && o.items.length > 0).length, 1, 'one status shows');
    clock.t = 45_000;
    await s.end();
    assert.deepEqual(cell.shown(), ['stdout 1', 'stderr 1', 'stdout 2'], 'gone: the status line of the run follows');
    // After the end (a secret captured redraws the output): no status comes back.
    await s.append([live('redrawn')]);
    assert.deepEqual(cell.shown(), ['stdout 1', 'stderr 1', 'stdout 2', 'redrawn']);
    await s.end();
  });

  it('never changes the notebook as time goes by: the renderer counts the seconds', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
    const cell = new FakeCell();
    const s = pinned(cell, 30);
    await s.start();
    const outputs = cell.outputs.length;
    t.mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(cell.replaced, 0, 'no replaceOutputItems while it runs');
    assert.equal(cell.outputs.length, outputs);
    await s.end();
    assert.equal(cell.replaced, 1, 'emptied once at the end');
  });

  it('retry=: the attempt, and a new status after the outputs were cleared for it', async () => {
    const clock = { t: 3_000 };
    const cell = new FakeCell(clock);
    const s = pinned(cell, undefined, 5);
    await s.start();
    assert.deepEqual(cell.shown(), ['[running · 3s · attempt 1/5]']);
    // The controller clears the outputs and appends the new attempt's.
    cell.outputs = [];
    s.setAttempt(2);
    await s.append([live('attempt 2 output')]);
    assert.deepEqual(cell.shown(), ['attempt 2 output', '[running · 3s · attempt 2/5]']);
    // A new attempt with the status still there: its items change, once.
    const before = cell.replaced;
    s.setAttempt(3);
    s.setAttempt(3);
    await s.append([]);
    assert.equal(cell.replaced - before, 2, 'one change for attempt 3, one to move the status below the next output');
    assert.deepEqual(cell.shown(), ['attempt 2 output', '[running · 3s · attempt 3/5]']);
    await s.end();
    assert.deepEqual(cell.shown(), ['attempt 2 output']);
  });

  it('sends when it started, the estimate in ms and the attempt; nothing that changes by itself', () => {
    const cell = new FakeCell();
    const make = { output: () => live('x'), item: (s: RunningData) => s };
    assert.deepEqual(new PinnedStatus(cell, make, 1_700_000_000_000, 30, 1).data(), { startedAt: 1_700_000_000_000, estimateMs: 30_000 });
    assert.deepEqual(new PinnedStatus(cell, make, 5, undefined, 3).data(), { startedAt: 5, attempt: 1, attempts: 3 });
  });
});

describe('the running status as the renderer draws it (renderer/runningView.ts)', () => {
  it('counts the seconds from the start, against the estimate', () => {
    const d = { startedAt: 1_000_000, estimateMs: 30_000 };
    assert.deepEqual(runningView(d, 1_012_400), { line: 'running · 12s of about 30s', fraction: 12.4 / 30, over: false });
    assert.deepEqual(runningView(d, 1_045_000), { line: 'running · 45s · 15s over about 30s', fraction: 1, over: true });
    assert.deepEqual(runningView({ startedAt: 1_000_000 }, 1_007_900), { line: 'running · 7s', over: false });
    assert.deepEqual(runningView({ startedAt: 0, attempt: 2, attempts: 5 }, 3_000), { line: 'running · 3s · attempt 2/5', over: false });
    // A remote extension host's clock ahead of the window's: 0s, not a negative time.
    assert.equal(runningView(d, 999_000).line, 'running · 0s of about 30s');
  });

  it('redraws when the words change: at the next whole second since the start', () => {
    assert.equal(msToNextSecond({ startedAt: 1_000 }, 13_250), 750);
    assert.equal(msToNextSecond({ startedAt: 1_000 }, 13_000), 1000);
    assert.equal(msToNextSecond({ startedAt: 5_000 }, 1_000), 1000);
  });

  it('draws only data it understands', () => {
    assert.equal(isRunningData({ startedAt: 1 }), true);
    assert.equal(isRunningData({ startedAt: 1, estimateMs: 2, attempt: 1, attempts: 2 }), true);
    for (const bad of [null, 'x', {}, { startedAt: '1' }, { startedAt: 1, estimateMs: 'x' }, { startedAt: Number.NaN }]) assert.equal(isRunningData(bad), false, JSON.stringify(bad));
  });
});

/**
 * A running cell's status in VS Code (src/pinnedStatus.ts): kept last while new outputs come in,
 * redrawn in place, emptied when the run ends. A fake cell stands in for the notebook API.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { OutputSink, PinnedStatus, RunningState } from '../src/pinnedStatus';

interface Out {
  name: string;
  items: RunningState[];
}

/** A cell's outputs, as VS Code keeps them: append, replace the items of one (it must be there). */
class FakeCell implements OutputSink<Out, RunningState> {
  outputs: Out[] = [];
  async appendOutput(out: readonly Out[]): Promise<void> {
    this.outputs.push(...out);
  }
  async replaceOutputItems(items: readonly RunningState[], output: Out): Promise<void> {
    if (!this.outputs.includes(output)) throw new Error('no such output');
    output.items = [...items];
  }
  /** What shows: the outputs with items, last the status's words. */
  shown(): string[] {
    return this.outputs.filter((o) => o.items.length > 0).map((o) => (o.name === 'status' ? `[${o.items[0]!.text}${o.items[0]!.attempt ? ` · ${o.items[0]!.attempt}` : ''}]` : o.name));
  }
}

const live = (name: string): Out => ({ name, items: [{ text: name, over: false }] });

const pinned = (cell: FakeCell, clock: { t: number }, estimate?: number, attempts = 1) =>
  new PinnedStatus<Out, RunningState>(cell, { output: (s) => ({ name: 'status', items: [s] }), item: (s) => s }, 0, estimate, attempts, () => clock.t, 1e9);

describe('the running status under a cell (VS Code)', () => {
  it('stays last while the output grows and switches streams, and goes at the end', async () => {
    const cell = new FakeCell();
    const clock = { t: 0 };
    await cell.appendOutput([live('stdout 1')]);
    const s = pinned(cell, clock, 30);
    await s.start();
    assert.deepEqual(cell.shown(), ['stdout 1', '[running · 0s of about 30s]']);
    clock.t = 12_000;
    s.tick();
    await s.append([live('stderr 1')]);
    assert.deepEqual(cell.shown(), ['stdout 1', 'stderr 1', '[running · 12s of about 30s]']);
    await s.append([live('stdout 2')]);
    assert.equal(cell.shown().at(-1), '[running · 12s of about 30s]', 'still last');
    assert.equal(cell.outputs.filter((o) => o.name === 'status' && o.items.length > 0).length, 1, 'one status shows');
    clock.t = 45_000;
    s.tick();
    await s.end();
    assert.deepEqual(cell.shown(), ['stdout 1', 'stderr 1', 'stdout 2'], 'gone: the status line of the run follows');
    // After the end (a secret captured redraws the output): no status comes back.
    await s.append([live('redrawn')]);
    assert.deepEqual(cell.shown(), ['stdout 1', 'stderr 1', 'stdout 2', 'redrawn']);
    await s.end();
  });

  it('retry=: the attempt, and a new status after the outputs were cleared for it', async () => {
    const cell = new FakeCell();
    const clock = { t: 3_000 };
    const s = pinned(cell, clock, undefined, 5);
    await s.start();
    assert.deepEqual(cell.shown(), ['[running · 3s · attempt 1/5]']);
    // The controller clears the outputs and appends the new attempt's.
    cell.outputs = [];
    s.setAttempt(2);
    await s.append([live('attempt 2 output')]);
    assert.deepEqual(cell.shown(), ['attempt 2 output', '[running · 3s · attempt 2/5]']);
    await s.end();
    assert.deepEqual(cell.shown(), ['attempt 2 output']);
  });

  it('past the estimate: the words say by how much, the bar is full and marked over', async () => {
    const cell = new FakeCell();
    const clock = { t: 45_000 };
    const s = pinned(cell, clock, 30);
    assert.deepEqual(s.state(), { text: 'running · 45s · 15s over about 30s', fraction: 1, over: true });
    clock.t = 10_000;
    assert.deepEqual(s.state(), { text: 'running · 10s of about 30s', fraction: 1 / 3, over: false });
    await s.end();
  });
});

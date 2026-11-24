/**
 * A running cell's status in VS Code (src/pinnedStatus.ts): kept last while new outputs come in,
 * changed only when its data does, ended when the run ends. A fake cell stands in for the
 * notebook API. The renderer's words (renderer/runningView.ts) are tested at the end.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ElapsedAsk, EndedData, elapsedMs, firstCount, hostCount, isElapsedAnswer, isEndedData, isRunningData, msToNextSecond, runningView } from '../renderer/runningView';
import { OutputSink, PinnedStatus, RunningData, appendGroups, elapsedAnswer } from '../src/pinnedStatus';

type Item = RunningData | EndedData;

interface Out {
  name: string;
  items: Item[];
}

/** Drawn: an output with an item that isn't the ended one (the renderer draws that as nothing). */
const drawn = (o: Out): boolean => o.items.length > 0 && !isEndedData(o.items[0]);

/** A cell's outputs, as VS Code keeps them: append, replace the items of one (it must be there). */
class FakeCell implements OutputSink<Out, Item> {
  outputs: Out[] = [];
  replaced = 0;
  appended = 0;
  /** Replaced by no items at all: VS Code then leaves the old drawing, its timer counting. */
  noItems = 0;
  constructor(readonly clock: { t: number } = { t: 0 }) {}
  async appendOutput(out: readonly Out[]): Promise<void> {
    this.appended++;
    this.outputs.push(...out);
  }
  async replaceOutputItems(items: readonly Item[], output: Out): Promise<void> {
    this.replaced++;
    if (items.length === 0) this.noItems++;
    if (!this.outputs.includes(output)) throw new Error('no such output');
    output.items = [...items];
  }
  /** What shows: the outputs with items, last the status as the renderer draws it now. */
  shown(): string[] {
    return this.outputs.filter(drawn).map((o) => {
      const d = o.items[0] as RunningData;
      return o.name === 'status' ? `[${runningView(d, this.clock.t, firstCount(d, d.sentAt)).line}]` : o.name;
    });
  }
}

const live = (name: string): Out => ({ name, items: [{ startedAt: 0, sentAt: 0 }] });

const pinned = (cell: FakeCell, estimate?: number, attempts = 1) =>
  new PinnedStatus<Out, Item>(cell, { output: (s) => ({ name: 'status', items: [s] }), item: (s) => s, ended: (e) => e }, 0, estimate, attempts, () => cell.clock.t);

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
    assert.equal(cell.outputs.filter((o) => o.name === 'status' && drawn(o)).length, 1, 'one status shows');
    clock.t = 45_000;
    await s.end();
    assert.deepEqual(cell.shown(), ['stdout 1', 'stderr 1', 'stdout 2'], 'gone: the status line of the run follows');
    // Every status that went was given the ended item, never no items (VS Code left those drawn).
    assert.equal(cell.noItems, 0);
    assert.deepEqual(
      cell.outputs.filter((o) => o.name === 'status').map((o) => o.items),
      [[{ ended: true }], [{ ended: true }], [{ ended: true }]],
    );
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
    assert.equal(cell.replaced, 1, 'ended once at the end');
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

  it('sends when it started and when it sent, the estimate in ms and the attempt; nothing that changes by itself', () => {
    const cell = new FakeCell();
    const make = { output: () => live('x'), item: (s: Item) => s, ended: (e: Item) => e };
    const host = { t: 1_700_000_004_000 };
    const s = new PinnedStatus(cell, make, 1_700_000_000_000, 30, 1, () => host.t);
    assert.deepEqual(s.data(), { startedAt: 1_700_000_000_000, sentAt: 1_700_000_004_000, estimateMs: 30_000 });
    host.t += 9_000;
    assert.equal(s.data().sentAt, 1_700_000_013_000, 'sentAt is read again for each new output or item');
    assert.deepEqual(new PinnedStatus(cell, make, 5, undefined, 3, () => 7).data(), { startedAt: 5, sentAt: 7, attempt: 1, attempts: 3 });
    // By default, the extension host's clock.
    const before = Date.now();
    const sent = new PinnedStatus(cell, make, 5, undefined, 1).data().sentAt;
    assert.ok(sent >= before && sent <= Date.now());
  });

  it('one change of the notebook per flush, however often stdout and stderr alternate', async () => {
    type Stream = 'stdout' | 'stderr';
    const cell = new FakeCell();
    const first = live('live 0');
    await cell.appendOutput([first]);
    const s = pinned(cell, 30);
    await s.start();
    const [appended, replaced] = [cell.appended, cell.replaced];
    let n = 0;
    const itemsAdded: string[] = [];
    const ops = {
      item: (): RunningData => ({ startedAt: 0, sentAt: 0 }),
      output: (items: RunningData[]): Out => ({ name: `live ${++n}`, items }),
      appendItems: async (items: RunningData[], o: Out) => void itemsAdded.push(`${items.length} to ${o.name}`),
      appendOutputs: (outs: Out[]) => s.append(outs),
    };
    // 10 switches of stream in one flush, the first group in the live output's stream.
    const groups = Array.from({ length: 11 }, (_, i) => ({ stream: (i % 2 === 0 ? 'stdout' : 'stderr') as Stream }));
    const after = await appendGroups(groups, { output: first, stream: 'stdout' as Stream }, ops);
    assert.deepEqual(itemsAdded, ['1 to live 0'], 'the first group goes into the live output');
    assert.equal(cell.appended - appended, 1, 'the 10 new outputs and the status in one append');
    assert.equal(cell.replaced - replaced, 1, 'the old status ended once');
    assert.equal(cell.outputs.filter((o) => !drawn(o)).length, 1, 'one ended output, not one per switch');
    assert.equal(cell.shown().length, 12);
    assert.equal(cell.shown().at(-1), '[running · 0s of about 30s]', 'the status stays last');
    assert.deepEqual(after, { output: cell.outputs.at(-2), stream: 'stdout' });
    // The next flush, same stream: into the live output, nothing appended.
    const next = await appendGroups([{ stream: 'stdout' as Stream }], after, ops);
    assert.equal(itemsAdded.at(-1), '1 to live 10');
    assert.equal(next.output, after.output);
    assert.equal(cell.appended - appended, 1);
    // A first flush (no stream yet): into the empty live output, whatever the stream.
    const fresh = await appendGroups([{ stream: 'stderr' as Stream }], { output: first, stream: undefined as Stream | undefined }, ops);
    assert.deepEqual([itemsAdded.at(-1), fresh.stream], ['1 to live 0', 'stderr']);
    await s.end();
  });
});

describe('how long a cell has run, asked by a renderer drawing its status late', () => {
  const ask = (startedAt: number, id = 'item-1'): ElapsedAsk => ({ type: 'elapsed?', id, startedAt });

  it("the host answers with the time since the start by its own clock; the notebook doesn't change", () => {
    assert.deepEqual(elapsedAnswer(ask(1_000_000), 1_180_000), { type: 'elapsed', id: 'item-1', elapsedMs: 180_000 });
    assert.equal(elapsedAnswer(ask(2_000), 1_000)?.elapsedMs, 0, 'never below 0');
    for (const bad of [
      null,
      'x',
      {},
      { type: 'toggleTask' },
      { type: 'elapsed?', id: 1, startedAt: 1 },
      { type: 'elapsed?', id: 'x' },
      { type: 'elapsed?', id: 'x', startedAt: Number.NaN },
      { type: 'elapsed?', id: 'x'.repeat(201), startedAt: 1 },
    ])
      assert.equal(elapsedAnswer(bad, 5), undefined, JSON.stringify(bad));
  });

  it('the renderer counts from the answer: drawn 3 min late, it says 3m, not 0s', () => {
    const d: RunningData = { startedAt: 0, sentAt: 0, estimateMs: 300_000 };
    // Before the answer: at least the time since the start by the window's clock.
    const before = firstCount(d, 180_000);
    assert.equal(elapsedMs(before, 180_000), 180_000);
    assert.doesNotMatch(runningView(d, 180_000, before).line, / 0s /);
    // Drawn as it was sent: the time to the send (a later sentAt: a new attempt's data).
    assert.equal(elapsedMs(firstCount({ ...d, sentAt: 4_000 }, 1_000), 1_000), 4_000);
    // The answer, then the window's own clock.
    const answer = elapsedAnswer(ask(d.startedAt), 180_500)!;
    assert.ok(isElapsedAnswer(answer));
    const c = hostCount(answer.elapsedMs, 181_000);
    assert.equal(elapsedMs(c, 191_000), 190_500);
    assert.equal(msToNextSecond(c, 191_000), 500);
    for (const bad of [null, {}, { type: 'elapsed', id: 'x' }, { type: 'elapsed', id: 'x', elapsedMs: 'x' }, { type: 'elapsed?', id: 'x', elapsedMs: 1 }])
      assert.equal(isElapsedAnswer(bad), false, JSON.stringify(bad));
  });

  it("counts the same whatever the remote extension host's clock says, once it answered", () => {
    const w = 1_000_000;
    for (const skew of [-3_600_000, -15_000, 0, 15_000, 3_600_000]) {
      // Started at 100 s by the host's clock; the host answers 5 s later; the window gets it at w.
      const startedAt = 100_000 - skew;
      const c = hostCount(elapsedAnswer(ask(startedAt), startedAt + 5_000)!.elapsedMs, w);
      assert.equal(elapsedMs(c, w + 7_000), 12_000, `skew ${skew}`);
      assert.deepEqual(runningView({ startedAt, sentAt: startedAt, estimateMs: 20_000 }, w + 7_000, c), { line: 'running · 12s of about 20s', fraction: 0.6, over: false }, `skew ${skew}`);
    }
  });
});

describe('the running status as the renderer draws it (renderer/runningView.ts)', () => {
  // Sent at the start and drawn at once, on one clock: the time since the start.
  const at = (startedAt: number, more: Partial<RunningData> = {}): RunningData => ({ startedAt, sentAt: startedAt, ...more });

  it('counts the seconds from the start, against the estimate', () => {
    const d = at(1_000_000, { estimateMs: 30_000 });
    const c = firstCount(d, 1_000_000);
    assert.deepEqual(runningView(d, 1_012_400, c), { line: 'running · 12s of about 30s', fraction: 12.4 / 30, over: false });
    assert.deepEqual(runningView(d, 1_045_000, c), { line: 'running · 45s · 15s over about 30s', fraction: 1, over: true });
    assert.deepEqual(runningView(at(1_000_000), 1_007_900, c), { line: 'running · 7s', over: false });
    assert.deepEqual(runningView(at(0, { attempt: 2, attempts: 5 }), 3_000, firstCount(at(0), 0)), { line: 'running · 3s · attempt 2/5', over: false });
    // The window's clock stepped back after the data came: 0s, not a negative time.
    assert.equal(runningView(d, 999_000, c).line, 'running · 0s of about 30s');
  });

  it("before the host answers: a window clock behind the host's (Remote-SSH, WSL) changes nothing", () => {
    // Sent 5 s after the start and drawn at once, at w by the window's clock, 7 s ago.
    const w = 1_000_000;
    for (const behind of [0, 15_000, 3_600_000]) {
      // The window's clock is `behind` ms behind the host's.
      const host: RunningData = { startedAt: w + behind - 5_000, sentAt: w + behind, estimateMs: 20_000 };
      const c = firstCount(host, w);
      assert.equal(elapsedMs(c, w + 7_000), 12_000, `behind ${behind}`);
      assert.deepEqual(runningView(host, w + 7_000, c), { line: 'running · 12s of about 20s', fraction: 0.6, over: false }, `not over early: behind ${behind}`);
      assert.equal(msToNextSecond(c, w + 7_250), 750, `behind ${behind}`);
    }
    // A window clock ahead counts more until the answer (hostCount) puts it right.
  });

  it('redraws when the words change: at the next whole second since the start', () => {
    assert.equal(msToNextSecond(firstCount(at(1_000), 1_000), 13_250), 750);
    assert.equal(msToNextSecond(firstCount(at(1_000), 1_000), 13_000), 1000);
    assert.equal(msToNextSecond(hostCount(0, 5_000), 1_000), 1000);
  });

  it('draws only data it understands', () => {
    assert.equal(isRunningData({ startedAt: 1, sentAt: 2 }), true);
    assert.equal(isRunningData({ startedAt: 1, sentAt: 2, estimateMs: 2, attempt: 1, attempts: 2 }), true);
    for (const bad of [
      null,
      'x',
      {},
      { startedAt: 1 },
      { startedAt: '1', sentAt: 2 },
      { startedAt: 1, sentAt: '2' },
      { startedAt: 1, sentAt: Number.POSITIVE_INFINITY },
      { startedAt: 1, sentAt: 2, estimateMs: 'x' },
      { startedAt: Number.NaN, sentAt: 2 },
    ])
      assert.equal(isRunningData(bad), false, JSON.stringify(bad));
  });

  it('the ended item is never drawn as running: the renderer draws nothing and stops counting', () => {
    const ended: EndedData = { ended: true };
    assert.equal(isEndedData(ended), true);
    assert.equal(isRunningData(ended), false);
    assert.equal(isEndedData({ startedAt: 1, sentAt: 2 }), false);
    assert.equal(isEndedData({ ended: 'true' }), false);
    assert.equal(isEndedData(null), false);
  });
});

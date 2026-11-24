/**
 * An output kept last in a running cell's outputs (runningStatus.ts gives it the running cell's
 * status). Without vscode, so the order of the calls is unit-tested.
 *
 * It holds when the cell started (and when the data was sent), its estimate and the attempt, not
 * the words: the renderer counts the seconds (renderer/runningView.ts). So the output changes only when that data does
 * (a new attempt, the end), never every second. With transientOutputs: false, each output change
 * is a change of the notebook: dirty, and saved again by auto save.
 *
 * A cell's outputs can't be removed one by one: a status that must move below a new output is
 * ended (its item replaced by the ended one, which the renderer draws as nothing) and a new one is
 * appended after that output. Never emptied of all items: VS Code then leaves the old drawing in
 * place, and its timer counted on for hours after the run (renderer/runningView.ts EndedData).
 */

import type { ElapsedAnswer, ElapsedAsk, EndedData } from '../renderer/runningView';

/** The output calls a run makes (vscode.NotebookCellExecution's). */
export interface OutputSink<O, I> {
  appendOutput(out: readonly O[]): Thenable<void>;
  replaceOutputItems(items: readonly I[], output: O): Thenable<void>;
}

/** What the renderer gets (renderer/runningView.ts RunningData). */
export interface RunningData {
  /** When the cell started: epoch ms. */
  startedAt: number;
  /** When this data was sent, by the same clock: the renderer counts from here by its own clock. */
  sentAt: number;
  /** The block's estimate in ms; without one, a counter and no bar. */
  estimateMs?: number;
  /** retry=: the attempt running, and how many it may take. */
  attempt?: number;
  attempts?: number;
}

export class PinnedStatus<O, I> {
  private output: O | undefined;
  private queue: Promise<void> = Promise.resolve();
  private attempt = 1;
  private ended = false;

  constructor(
    private readonly sink: OutputSink<O, I>,
    private readonly make: { output(data: RunningData): O; item(data: RunningData): I; ended(data: EndedData): I },
    private readonly startedAt: number,
    private readonly estimateSeconds: number | undefined,
    private readonly attempts: number,
    /** The extension host's clock (startedAt's). */
    private readonly now: () => number = Date.now,
  ) {}

  /** What the renderer gets now. */
  data(): RunningData {
    const est = this.estimateSeconds;
    return {
      startedAt: this.startedAt,
      sentAt: this.now(),
      ...(est !== undefined && Number.isFinite(est) && est > 0 ? { estimateMs: Math.round(est * 1000) } : {}),
      ...(this.attempts > 1 ? { attempt: this.attempt, attempts: this.attempts } : {}),
    };
  }

  /** Pinned under the outputs so far. */
  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.ended) return;
      this.output = this.make.output(this.data());
      await this.sink.appendOutput([this.output]);
    });
  }

  /** Append `outputs` (a new live output) above the status, which stays last. */
  append(outputs: readonly O[]): Promise<void> {
    return this.enqueue(async () => {
      if (this.ended) return void (await this.sink.appendOutput(outputs));
      await this.empty();
      this.output = this.make.output(this.data());
      await this.sink.appendOutput([...outputs, this.output]);
    });
  }

  /** retry=: attempt `n` starts. The only change while it runs: the renderer counts the time. */
  setAttempt(n: number): void {
    if (n === this.attempt) return;
    this.attempt = n;
    void this.enqueue(async () => {
      if (!this.output || this.ended) return;
      try {
        await this.sink.replaceOutputItems([this.make.item(this.data())], this.output);
      } catch {
        // The outputs were cleared meanwhile: the next append pins a new one.
      }
    });
  }

  /** The run ended: the status goes (the run's status line follows it). Safe to call twice. */
  end(): Promise<void> {
    this.ended = true;
    return this.enqueue(() => this.empty());
  }

  private async empty(): Promise<void> {
    const old = this.output;
    this.output = undefined;
    if (old === undefined) return;
    try {
      await this.sink.replaceOutputItems([this.make.ended({ ended: true })], old);
    } catch {
      // Gone already (the outputs were cleared for a new attempt).
    }
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** A running cell's live output: the output last appended, and the stream it holds. */
export interface LiveOutput<O, S> {
  output: O;
  stream: S | undefined;
}

/**
 * One flush of a running cell's output (controller.ts), each group one stream's text. A group of
 * the live output's stream goes into it; each switch of stream starts a new output. The new
 * outputs are appended together: with the running status, one change of the notebook per flush
 * however often stdout and stderr alternate, not an ended status and a new one per switch.
 */
export async function appendGroups<G extends { stream: S }, O, I, S>(
  groups: readonly G[],
  live: LiveOutput<O, S>,
  ops: {
    item(g: G): I;
    output(items: I[]): O;
    appendItems(items: I[], output: O): Thenable<void>;
    appendOutputs(outputs: O[]): Thenable<void>;
  },
): Promise<LiveOutput<O, S>> {
  const same: I[] = [];
  const fresh: I[][] = [];
  let stream = live.stream;
  for (const g of groups) {
    if (stream === undefined || stream === g.stream) (fresh.at(-1) ?? same).push(ops.item(g));
    else fresh.push([ops.item(g)]);
    stream = g.stream;
  }
  if (same.length > 0) await ops.appendItems(same, live.output);
  if (fresh.length === 0) return { output: live.output, stream };
  const outputs = fresh.map((items) => ops.output(items));
  await ops.appendOutputs(outputs);
  return { output: outputs.at(-1)!, stream };
}

/**
 * The extension host's answer to a running status drawn for the first time in a webview
 * (renderer/runningStatus.ts): how long the cell has run, by the clock its start was taken with.
 * Scrolled back into view, or in a new webview (a split, a moved editor), the renderer can't tell
 * how long ago the data came. Nothing in the notebook changes. Undefined for anything else.
 */
export function elapsedAnswer(message: unknown, now: number): ElapsedAnswer | undefined {
  const m = message as Partial<ElapsedAsk> | null;
  if (typeof m !== 'object' || m === null || m.type !== 'elapsed?') return undefined;
  if (typeof m.id !== 'string' || m.id.length > 200 || typeof m.startedAt !== 'number' || !Number.isFinite(m.startedAt)) return undefined;
  return { type: 'elapsed', id: m.id, elapsedMs: Math.max(0, now - m.startedAt) };
}

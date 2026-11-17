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
 * emptied (an output without items takes no room) and a new one is appended after that output.
 */

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
    private readonly make: { output(data: RunningData): O; item(data: RunningData): I },
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
      await this.sink.replaceOutputItems([], old);
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

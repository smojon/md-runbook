/**
 * An output kept last in a running cell's outputs, redrawn every second (runningStatus.ts gives
 * it the running cell's status). Without vscode, so the order of the calls is unit-tested.
 *
 * A cell's outputs can't be removed one by one: a status that must move below a new output is
 * emptied (an output without items takes no room) and a new one is appended after that output.
 */

import { CellRunStatus, cellRunStatus } from '@md-runbook/core/runStatus';

/** The output calls a run makes (vscode.NotebookCellExecution's). */
export interface OutputSink<O, I> {
  appendOutput(out: readonly O[]): Thenable<void>;
  replaceOutputItems(items: readonly I[], output: O): Thenable<void>;
}

/** What the renderer draws (renderer/runningStatus.ts). */
export interface RunningState {
  text: string;
  attempt?: string;
  fraction?: number;
  over: boolean;
}

export function runningState(s: CellRunStatus): RunningState {
  return { text: s.text, ...(s.attempt ? { attempt: s.attempt } : {}), ...(s.fraction !== undefined ? { fraction: s.fraction } : {}), over: s.over };
}

const TICK_MS = 1000;

export class PinnedStatus<O, I> {
  private output: O | undefined;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private attempt = 1;
  private ended = false;
  private ticking = false;

  constructor(
    private readonly sink: OutputSink<O, I>,
    private readonly make: { output(state: RunningState): O; item(state: RunningState): I },
    private readonly startedAt: number,
    private readonly estimateSeconds: number | undefined,
    private readonly attempts: number,
    private readonly now: () => number = Date.now,
    private readonly tickMs = TICK_MS,
  ) {}

  /** What it says now (core cellRunStatus: the words of every client). */
  state(): RunningState {
    return runningState(
      cellRunStatus({
        elapsedSeconds: (this.now() - this.startedAt) / 1000,
        ...(this.estimateSeconds !== undefined ? { estimateSeconds: this.estimateSeconds } : {}),
        attempt: this.attempt,
        attempts: this.attempts,
      }),
    );
  }

  /** Pinned under the outputs so far; redrawn every second. */
  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.ended) return;
      this.output = this.make.output(this.state());
      await this.sink.appendOutput([this.output]);
      this.timer = setInterval(() => this.tick(), this.tickMs);
      (this.timer as { unref?: () => void }).unref?.();
    });
  }

  /** Append `outputs` (a new live output) above the status, which stays last. */
  append(outputs: readonly O[]): Promise<void> {
    return this.enqueue(async () => {
      if (this.ended) return void (await this.sink.appendOutput(outputs));
      await this.empty();
      this.output = this.make.output(this.state());
      await this.sink.appendOutput([...outputs, this.output]);
    });
  }

  /** retry=: attempt `n` starts. */
  setAttempt(n: number): void {
    if (n === this.attempt) return;
    this.attempt = n;
    this.tick();
  }

  /** The run ended: the status goes (the run's status line follows it). Safe to call twice. */
  end(): Promise<void> {
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this.enqueue(() => this.empty());
  }

  /** Redraw now (the ticker calls it every second). */
  tick(): void {
    // One redraw waiting is enough: a slow window doesn't pile them up.
    if (this.ticking || this.ended) return;
    this.ticking = true;
    void this.enqueue(async () => {
      this.ticking = false;
      if (!this.output || this.ended) return;
      try {
        await this.sink.replaceOutputItems([this.make.item(this.state())], this.output);
      } catch {
        // The outputs were cleared meanwhile: the next append pins a new one.
      }
    });
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

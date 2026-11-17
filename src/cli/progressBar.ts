/**
 * The run's progress pinned on the bottom line of a terminal, as apt shows it: the output scrolls
 * above it (a scroll region, DECSTBM) and the line is redrawn in place. Its words come from the
 * core (runProgressLine), the same as in VS Code and the app; only the bar is drawn here.
 *
 * Only for a terminal: run.ts appends a progress line after each step instead when the output
 * goes to a pipe or a file, when TERM=dumb, and with --no-progress-bar.
 */

import { progressBar, terminalBarWidth } from '@md-runbook/core';

/** The terminal the bar is drawn on: process.stdout, or a fake one in tests. */
export interface BarTerminal {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write(text: string): unknown;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

/** Where the signals come from (process; a fake in tests). */
export interface Signals {
  once(event: 'SIGINT' | 'SIGTERM' | 'exit', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM' | 'exit', listener: () => void): unknown;
}

/** What the bar shows: read again on every redraw, as the time left moves on during a step. */
export type BarRead = () => { text: string; fraction: number };

/** A terminal that draws the pinned line: VT sequences (TERM isn't dumb) and room for it. */
export function canPinBar(term: BarTerminal, env: NodeJS.ProcessEnv): boolean {
  return term.isTTY === true && env.TERM !== 'dumb' && (term.rows ?? 0) >= 4 && (term.columns ?? 0) >= 20;
}

/** The pinned line for a terminal `columns` wide: the words, then the bar; never wrapping. */
export function barLine(text: string, fraction: number, columns: number): string {
  // The last column is left free: a character there may wrap, and scroll the whole screen.
  const max = Math.max(1, columns - 1);
  const line = `${text} ${progressBar(fraction, terminalBarWidth(columns, text.length))}`;
  if (line.length <= max) return line;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const ESC = '\x1b';
/** DECSC / DECRC: the cursor where the output goes on. */
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;

export class PinnedBar {
  private read: BarRead | undefined;
  private active = false;
  /** Stopped: a step starting after Ctrl+C doesn't pin the line again. */
  private closed = false;
  private suspended = false;
  private rows = 0;
  private shown = '';
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly term: BarTerminal,
    private readonly signals: Signals = process,
    private readonly tickMs = 1000,
  ) {}

  /** Show where the run is (`read` is called again every second); pins the line the first time. */
  show(read: BarRead): void {
    if (this.closed) return;
    this.read = read;
    if (!this.active) this.start();
    this.draw();
  }

  /** Give the terminal back while something asks on it; resume() pins the line again. */
  suspend(): void {
    if (!this.active || this.suspended) return;
    this.suspended = true;
    this.release();
  }

  resume(): void {
    if (!this.active || !this.suspended) return;
    this.suspended = false;
    this.reserve();
    this.draw();
  }

  /** The terminal as it was: the whole screen scrolls again, the line is gone. Safe to call twice. */
  stop(): void {
    this.closed = true;
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.term.off?.('resize', this.onResize);
    for (const s of ['SIGINT', 'SIGTERM', 'exit'] as const) this.signals.off(s, this.onSignal);
    if (!this.suspended) this.release();
    this.suspended = false;
  }

  private start(): void {
    this.active = true;
    this.reserve();
    this.term.on?.('resize', this.onResize);
    // Ctrl+C, a kill or an exit with the run still going: the terminal must not stay split.
    for (const s of ['SIGINT', 'SIGTERM', 'exit'] as const) this.signals.once(s, this.onSignal);
    this.timer = setInterval(() => this.draw(), this.tickMs);
    // The ticking must not keep the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private readonly onSignal = (): void => this.stop();

  /**
   * The bottom line out of the scroll region, as apt does: a new line first (the screen scrolls
   * when the cursor is on the last line), the region set (that moves the cursor), the cursor back.
   */
  private reserve(): void {
    this.rows = this.term.rows ?? 24;
    this.shown = '';
    this.term.write(`\n${SAVE}${ESC}[1;${this.rows - 1}r${RESTORE}${ESC}[1A`);
  }

  /**
   * The whole screen scrolls again, and everything below the cursor is erased: the line, wherever
   * a resize moved it (it is always below the output).
   */
  private release(): void {
    this.term.write(`${SAVE}${ESC}[r${RESTORE}${ESC}[J`);
    this.shown = '';
  }

  private readonly onResize = (): void => {
    if (!this.active || this.suspended) return;
    this.release();
    this.reserve();
    this.draw();
  };

  private draw(): void {
    if (!this.active || this.suspended || !this.read) return;
    const { text, fraction } = this.read();
    const line = barLine(text, fraction, this.term.columns ?? 80);
    if (line === this.shown) return;
    this.shown = line;
    this.term.write(`${SAVE}${ESC}[${this.rows};1H${ESC}[2K${line}${RESTORE}`);
  }
}

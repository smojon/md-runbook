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

/**
 * A terminal that draws the pinned line: VT sequences (TERM isn't dumb) and room for it. Not in
 * CI (`CI` set, not false or 0): a job's pseudo-terminal goes to a log, where the sequences are noise.
 */
export function canPinBar(term: BarTerminal, env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI !== undefined && !['', 'false', '0'].includes(env.CI.trim().toLowerCase());
  return term.isTTY === true && env.TERM !== 'dumb' && !ci && (term.rows ?? 0) >= 4 && (term.columns ?? 0) >= 20;
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
/** IND: down a line, scrolling at the bottom, in the same column (a \n becomes \r\n in a terminal). */
const INDEX = `${ESC}D`;
/** SGR 0: the bar in plain text, whatever colour the output left on (DECRC brings that back). */
const PLAIN = `${ESC}[0m`;

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
    this.timer = setInterval(() => this.draw(true), this.tickMs);
    // The ticking must not keep the process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private readonly onSignal = (): void => this.stop();

  /**
   * The bottom line out of the scroll region, as apt does: a line down first (the screen scrolls
   * when the cursor is on the last line), the region set (that moves the cursor), the cursor back.
   * IND, not \n, keeps the column: after a resize in the middle of an output line, the rest of
   * the line goes on after its start instead of over it.
   */
  private reserve(): void {
    this.rows = this.term.rows ?? 24;
    this.shown = '';
    this.term.write(`${INDEX}${SAVE}${ESC}[1;${this.rows - 1}r${RESTORE}${ESC}[1A`);
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

  /**
   * The line, when it changed; `always` (each second): also when it didn't, so that it comes back
   * after a step cleared the screen (`clear`, ESC[2J, ESC[J).
   */
  private draw(always = false): void {
    if (!this.active || this.suspended || !this.read) return;
    const { text, fraction } = this.read();
    const line = barLine(text, fraction, this.term.columns ?? 80);
    if (line === this.shown && !always) return;
    this.shown = line;
    // DECSC saves the output's colours too; plain before the erase (it fills with the background).
    this.term.write(`${SAVE}${ESC}[${this.rows};1H${PLAIN}${ESC}[2K${line}${RESTORE}`);
  }
}

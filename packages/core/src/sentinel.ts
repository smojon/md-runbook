/**
 * The end-of-cell marker of a shell session: after each cell the shell prints
 * `<RS>__MDRB_<id>__ <exit>` on stdout and stderr; this filter passes output through and strips
 * it. Platform-neutral: local sessions (node/session.ts) and remote ones over SSH use it.
 */

/** Starts the sentinel. Not a newline: the output keeps exactly the line endings the cell wrote. */
export const SENTINEL_START = '\x1e';

/**
 * Passes a stream through until the sentinel for one cell, which it strips. Only a trailing
 * piece that could still become the sentinel (from an RS character on) is held back, so complete
 * lines are passed on at once and the other stream can't overtake their newline.
 */
export class SentinelFilter {
  private pending = '';
  private readonly needle: string;
  /** Exit code from the sentinel, once seen. Anything after it is dropped. */
  code: number | undefined;

  constructor(
    marker: string,
    private readonly emit: (text: string) => void,
  ) {
    this.needle = SENTINEL_START + marker + ' ';
  }

  get done(): boolean {
    return this.code !== undefined;
  }

  write(chunk: string): void {
    if (this.done) return;
    let p = this.pending + chunk;
    const at = p.indexOf(this.needle);
    if (at >= 0) {
      this.send(p.slice(0, at));
      p = p.slice(at);
      const end = p.indexOf('\n');
      if (end >= 0) {
        const code = Number.parseInt(p.slice(this.needle.length, end), 10);
        this.code = Number.isNaN(code) ? 1 : code;
        p = '';
      }
      this.pending = p;
      return;
    }
    // The needle has a single RS, at its start: only the text from the last RS can be a prefix.
    const rs = p.lastIndexOf(SENTINEL_START);
    const hold = rs >= 0 && this.needle.startsWith(p.slice(rs)) ? rs : p.length;
    this.send(p.slice(0, hold));
    this.pending = p.slice(hold);
  }

  /** Emit whatever is held back (the process ended without a sentinel). */
  flush(): void {
    this.send(this.pending);
    this.pending = '';
  }

  private send(text: string): void {
    if (text !== '') this.emit(text);
  }
}

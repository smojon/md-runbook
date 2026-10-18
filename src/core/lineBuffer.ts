/**
 * Buffers streamed text into whole lines before passing it on, so a line-oriented transform
 * (live redaction) never sees a secret split across two chunks.
 */
export class LineBuffer {
  private pending = '';

  constructor(
    private readonly emit: (text: string) => void,
    private readonly transform: (text: string) => string = (t) => t,
    /** Flush a partial line once it grows past this many characters. */
    private readonly maxPending = 64 * 1024,
  ) {}

  write(chunk: string): void {
    this.pending += chunk;
    const cut = this.pending.lastIndexOf('\n');
    if (cut >= 0) {
      const ready = this.pending.slice(0, cut + 1);
      this.pending = this.pending.slice(cut + 1);
      this.emit(this.transform(ready));
    }
    if (this.pending.length > this.maxPending) this.flush();
  }

  /** Emit whatever is buffered (end of stream, or a prompt waiting without a newline). */
  flush(): void {
    if (this.pending === '') return;
    const rest = this.pending;
    this.pending = '';
    this.emit(this.transform(rest));
  }
}

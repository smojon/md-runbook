/**
 * Buffers streamed text into whole lines before passing it on, so a line-oriented transform
 * (live redaction) never sees a secret split across two chunks. A private-key block is held
 * until its END line arrives, so the whole block is redacted at once.
 */

/** A BEGIN … PRIVATE KEY line with no END after it. */
const OPEN_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z0-9 ]*PRIVATE KEY-----)/;

export class LineBuffer {
  /** Incomplete last line. */
  private pending = '';
  /** Complete lines held back while a key block is open. */
  private held = '';

  constructor(
    private readonly emit: (text: string) => void,
    private readonly transform: (text: string) => string = (t) => t,
    /** Flush a partial line once it grows past this many characters. */
    private readonly maxPending = 64 * 1024,
    /** Give up holding an unterminated key block after this many characters. */
    private readonly maxHeld = 256 * 1024,
  ) {}

  write(chunk: string): void {
    this.pending += chunk;
    const cut = this.pending.lastIndexOf('\n');
    if (cut >= 0) {
      this.held += this.pending.slice(0, cut + 1);
      this.pending = this.pending.slice(cut + 1);
      if (!OPEN_KEY_BLOCK.test(this.held) || this.held.length > this.maxHeld) this.release(this.held);
    }
    if (this.pending.length > this.maxPending) {
      // Cut at the last whitespace so a token is never split between two transforms.
      const ws = Math.max(this.pending.lastIndexOf(' '), this.pending.lastIndexOf('\t'));
      const at = ws > 0 ? ws + 1 : this.pending.length;
      const part = this.pending.slice(0, at);
      this.pending = this.pending.slice(at);
      this.release(this.held + part);
    }
  }

  /** Emit whatever is buffered (end of stream, or a prompt waiting without a newline). */
  flush(): void {
    this.release(this.held + this.pending);
    this.pending = '';
  }

  private release(text: string): void {
    this.held = '';
    if (text !== '') this.emit(this.transform(text));
  }
}

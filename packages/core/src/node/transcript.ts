/**
 * The transcript file (core/transcript.ts formats it): text appended in batches, so a step that
 * prints thousands of lines is a few writes a second, not one per line. When the file has grown
 * past `maxBytes` it is renamed to `<file>.1` (replacing an older one) and a new file starts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const BATCH_MS = 100;

export class TranscriptFile {
  private pending = '';
  private timer: NodeJS.Timeout | undefined;
  private failed = false;

  constructor(
    readonly file: string,
    /** Called once, on the first write that fails; the transcript stops then. */
    private readonly onError?: (error: Error) => void,
    private readonly maxBytes = MAX_TRANSCRIPT_BYTES,
    private readonly batchMs = BATCH_MS,
  ) {}

  append(text: string): void {
    if (this.failed || text === '') return;
    this.pending += text;
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), this.batchMs);
      this.timer.unref?.();
    }
  }

  /** Write what is pending now (end of a step, end of a run). */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const text = this.pending;
    this.pending = '';
    if (this.failed || text === '') return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        // No file yet.
      }
      if (size > 0 && size + Buffer.byteLength(text) > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, text, 'utf8');
    } catch (e) {
      this.failed = true;
      this.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

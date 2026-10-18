/**
 * Exact secret values seen this session (injected secrets, .env values). They are redacted from
 * live output and from everything written to disk, in addition to the regex patterns.
 */
import { REDACTED } from './core';

const MIN_LENGTH = 4;

class KnownSecrets {
  private values = new Set<string>();

  add(values: Iterable<string>): void {
    for (const v of values) if (v.length >= MIN_LENGTH) this.values.add(v);
  }

  clear(): void {
    this.values.clear();
  }

  redact(text: string): string {
    if (this.values.size === 0) return text;
    // Longest first so a secret containing another is replaced whole.
    let out = text;
    for (const v of [...this.values].sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
    return out;
  }
}

export const knownSecrets = new KnownSecrets();

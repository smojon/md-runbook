/**
 * ssh-keygen's answer on a runbook's signature, cached (the Library view, run reports): by the
 * allowed_signers file (its path, size and time, so an edit by Trusted Signers… or by hand counts)
 * and the text's hash. "Can't check" (no ssh-keygen) is never cached: installing OpenSSH counts
 * at the next check. No vscode import: unit-tested.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { runbookSignerCheck } from '@md-runbook/core/node';

/** Shown where a signature would be checked, when ssh-keygen can't be started. */
export const CANT_CHECK_SIGNATURES = "can't check signatures: ssh-keygen not found (install OpenSSH)";

export interface SignerCheck {
  /** The trusted signer whose key made one of the signatures. */
  signer?: string;
  /** ssh-keygen could not be started: nothing was checked. */
  cantCheck?: true;
}

type Check = (text: string, file: string) => Promise<SignerCheck>;

/** The file as it is now: changes when it is written (or made, or removed). */
export function fileStamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'none';
  }
}

export class SignerCache {
  private readonly answers = new Map<string, string | undefined>();

  constructor(private readonly check: Check = (text, file) => runbookSignerCheck(text, file)) {}

  async signer(text: string, file: string): Promise<SignerCheck> {
    const key = `${file}\n${fileStamp(file)}\n${createHash('sha256').update(text).digest('hex')}`;
    if (this.answers.has(key)) {
      const signer = this.answers.get(key);
      return signer !== undefined ? { signer } : {};
    }
    const got = await this.check(text, file).catch((): SignerCheck => ({}));
    if (got.cantCheck) return got;
    this.answers.set(key, got.signer);
    return got;
  }

  clear(): void {
    this.answers.clear();
  }
}

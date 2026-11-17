/**
 * ssh-keygen's answer on a runbook's signature, cached (the Library view, run reports): by the
 * allowed_signers file (its path, size and time, so an edit by Trusted Signers… or by hand counts)
 * and the text's hash. ssh-keygen gets the file's filtered copy (filteredSigners.ts): only the
 * lines md-runbook reads count. "Can't check" (no ssh-keygen) is never cached: installing OpenSSH
 * counts at the next check. No vscode import: unit-tested.
 */

import { createHash } from 'node:crypto';
import { runbookSignerCheck } from '@md-runbook/core/node';
import { fileStamp, filteredSignersFile } from './filteredSigners';

export { fileStamp };

/** Shown where a signature would be checked, when ssh-keygen can't be started. */
export const CANT_CHECK_SIGNATURES = "can't check signatures: ssh-keygen not found (install OpenSSH)";

export interface SignerCheck {
  /** The trusted signer whose key made one of the signatures. */
  signer?: string;
  /** ssh-keygen could not be started: nothing was checked. */
  cantCheck?: true;
}

type Check = (text: string, file: string) => Promise<SignerCheck>;

/**
 * ssh-keygen's answer on the runbook against `file`, through its filtered copy (filteredSigners.ts):
 * only the lines md-runbook reads count, as Trusted Signers… shows them.
 */
export const signerCheckOf = (text: string, file: string, sshKeygen = 'ssh-keygen'): Promise<SignerCheck> => runbookSignerCheck(text, filteredSignersFile(file), sshKeygen);

export class SignerCache {
  private readonly answers = new Map<string, string | undefined>();

  constructor(private readonly check: Check = (text, file) => signerCheckOf(text, file)) {}

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

/** The same words, for links (src/linkHandler.ts). */
export const SSH_KEYGEN_MISSING = CANT_CHECK_SIGNATURES;

/** The trusted signer of the runbook, or, when there is none, why it couldn't be checked (no ssh-keygen). */
export async function checkSigner(text: string, allowedSigners: string, sshKeygen = 'ssh-keygen'): Promise<{ signer?: string; cantCheck?: string }> {
  const got = await signerCheckOf(text, allowedSigners, sshKeygen).catch((): SignerCheck => ({}));
  if (got.signer !== undefined) return { signer: got.signer };
  return got.cantCheck ? { cantCheck: CANT_CHECK_SIGNATURES } : {};
}

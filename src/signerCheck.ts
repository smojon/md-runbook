/**
 * Whether a runbook's signature is by a trusted signer, and why it can't be told: ssh-keygen
 * missing must not read as "not signed by a trusted signer". No vscode import: unit-tested.
 *
 * Local for now: core's runbookSignerCheck (on another branch) answers cantCheck on ENOENT too.
 * Use it here once it is on main.
 */
import { execFile } from 'node:child_process';
import { trustedRunbookSigner } from '@md-runbook/core/node';
import { readSignature } from '@md-runbook/core/signing';

export const SSH_KEYGEN_MISSING = "can't check signatures: ssh-keygen not found (install OpenSSH)";

/** Whether `sshKeygen` can't be started at all (not on PATH): any answer from it means it is there. */
export function sshKeygenMissing(sshKeygen = 'ssh-keygen'): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(sshKeygen, ['-?'], { timeout: 10_000, windowsHide: true }, (err) => resolve((err as NodeJS.ErrnoException | null)?.code === 'ENOENT'));
  });
}

/** The trusted signer of the runbook, or, when there is none, why it couldn't be checked (cantCheck). */
export async function checkSigner(text: string, allowedSigners: string, sshKeygen = 'ssh-keygen'): Promise<{ signer?: string; cantCheck?: string }> {
  const signer = await trustedRunbookSigner(text, allowedSigners, sshKeygen).catch(() => undefined);
  if (signer !== undefined) return { signer };
  // trustedRunbookSigner swallows ssh-keygen's errors: with a signature to check, tell "missing" apart.
  if (readSignature(text) && (await sshKeygenMissing(sshKeygen))) return { cantCheck: SSH_KEYGEN_MISSING };
  return {};
}

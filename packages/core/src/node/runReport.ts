/**
 * Run reports with OpenSSH's own tool (ssh-keygen -Y, OpenSSH 8.2+), for VS Code, the command line
 * and servers: whether a runbook's signature is by a signer this machine trusts (an
 * allowed_signers file), signing a run summary with the runner's key, and checking a signed
 * summary against an allowed runners file (namespace md-runbook-run). See ../runReport.ts.
 */

import { RUN_SIGNATURE_NAMESPACE, RunEnvelope, canonicalJson, parseRunEnvelope } from '../runReport';
import { armorSignature, readSignature, allSignatures } from '../signing';
import { SignOptions, sshSign, sshVerify } from './sign';

/**
 * The principal of `allowedSigners` (a file) whose key made one of the runbook's signatures, or
 * undefined (no signature, none good, or no ssh-keygen). As md-runbook-gate checks it.
 */
export async function trustedRunbookSigner(text: string, allowedSigners: string, sshKeygen = 'ssh-keygen'): Promise<string | undefined> {
  return (await runbookSignerCheck(text, allowedSigners, sshKeygen)).signer;
}

/**
 * As trustedRunbookSigner, and `cantCheck` when ssh-keygen could not be started (not installed,
 * not on PATH): then no signature was checked, which is not the same as none trusted.
 */
export async function runbookSignerCheck(text: string, allowedSigners: string, sshKeygen = 'ssh-keygen'): Promise<{ signer?: string; cantCheck?: true }> {
  const block = readSignature(text);
  if (!block) return {};
  for (const sig of allSignatures(block)) {
    try {
      return { signer: await sshVerify(block.manifest, sig, allowedSigners, sshKeygen) };
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ENOENT') return { cantCheck: true };
      // the next signature (a co-signer's)
    }
  }
  return {};
}

/** The armored signature (namespace md-runbook-run) of a summary's canonical JSON, made with `key`. */
export async function signRunSummary(summary: unknown, key: string, opts: Omit<SignOptions, 'namespace'> = {}): Promise<string> {
  return armorSignature(await sshSign(canonicalJson(summary), key, { ...opts, namespace: RUN_SIGNATURE_NAMESPACE }));
}

/**
 * Check a signed summary (the envelope's JSON) against an allowed runners file (OpenSSH's
 * allowed_signers format, with namespaces="md-runbook-run"): the runner and the summary, or an
 * error saying what is wrong. The signature must cover the summary's canonical JSON.
 */
export async function verifyRunEnvelope(json: string, allowedRunners: string, sshKeygen = 'ssh-keygen'): Promise<{ signer: string; envelope: RunEnvelope }> {
  const parsed = parseRunEnvelope(json);
  if ('problems' in parsed) throw new Error(`not a signed run summary:\n${parsed.problems.map((p) => `  ${p}`).join('\n')}`);
  const blob = parsed.envelope.signature.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, '').replace(/\s+/g, '');
  const signer = await sshVerify(canonicalJson(parsed.envelope.summary), blob, allowedRunners, sshKeygen, RUN_SIGNATURE_NAMESPACE);
  return { signer, envelope: parsed.envelope };
}

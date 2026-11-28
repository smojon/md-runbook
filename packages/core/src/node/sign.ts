/**
 * Signing and checking runbook manifests with OpenSSH's own tool (`ssh-keygen -Y`, OpenSSH 8.2+):
 * the same signatures md-runbook-gate checks on the servers, with any key ssh-keygen can use (a
 * key file, a FIDO `sk-` key, or a public key file whose private key is in the agent).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Manifest, SIGNATURE_NAMESPACE, armorSignature, unarmorSignature } from '../signing';

/** sha256 of the manifest, hex: what logs show and what a server's `revoked` file lists. */
export function manifestHash(manifest: string): string {
  return createHash('sha256').update(manifest, 'utf8').digest('hex');
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** stdin 'inherit' lets ssh-keygen ask for a key's passphrase or a FIDO touch on the terminal. */
function run(command: string, args: string[], stdin: 'inherit' | string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [stdin === 'inherit' ? 'inherit' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    // `code` stays on the error (ENOENT: not installed), so a caller can tell "can't check" apart.
    child.on('error', (e) => reject(Object.assign(new Error(`${command}: ${e.message} (OpenSSH's ssh-keygen is needed)`), { code: (e as NodeJS.ErrnoException).code })));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== 'inherit') {
      // A command that doesn't read its input (find-principals) may exit before it is written:
      // EPIPE, which unhandled was an uncaught exception. Its exit code and stderr say what went wrong.
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(stdin);
    }
  });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-sign-'));
}

export interface SignOptions {
  sshKeygen?: string;
  /**
   * ssh-keygen may ask for the key's passphrase on the terminal (the command line). Off where
   * there is no terminal (the editor): a key with a passphrase then fails at once instead of
   * waiting; such keys sign through the agent (`key` = the .pub file).
   */
  interactive?: boolean;
  /** The signature's namespace: a runbook's (`md-runbook`, the default) or a run summary's (`md-runbook-run`). */
  namespace?: string;
}

/** Sign `manifest` with `key` (a private key file, or a public one whose key is in the agent); the SSHSIG blob, base64. */
export async function sshSign(manifest: string, key: string, opts: SignOptions = {}): Promise<string> {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'manifest');
    fs.writeFileSync(file, manifest, 'utf8');
    const r = await run(opts.sshKeygen ?? 'ssh-keygen', ['-Y', 'sign', '-q', '-f', key, '-n', opts.namespace ?? SIGNATURE_NAMESPACE, file], opts.interactive === false ? '' : 'inherit');
    if (r.code !== 0 || !fs.existsSync(file + '.sig')) throw new Error(`ssh-keygen could not sign: ${r.stderr.trim() || `exit ${r.code}`}`);
    return unarmorSignature(fs.readFileSync(file + '.sig', 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Check a signature against an `allowed_signers` file, as md-runbook-gate does: the principal
 * whose key made it, or an error saying why not.
 */
export async function sshVerify(manifest: string, signature: string, allowedSigners: string, sshKeygen = 'ssh-keygen', namespace = SIGNATURE_NAMESPACE): Promise<string> {
  const dir = tempDir();
  try {
    const sig = path.join(dir, 'manifest.sig');
    fs.writeFileSync(sig, armorSignature(signature), 'utf8');
    const found = await run(sshKeygen, ['-Y', 'find-principals', '-s', sig, '-f', allowedSigners], '');
    // One allowed_signers line may name several principals (a,b): try each, as the gate does.
    const principals = found.code === 0 ? found.stdout.split(/[\r\n,]+/).filter(Boolean) : [];
    if (principals.length === 0) throw new Error(`no key in ${allowedSigners} made this signature`);
    let why = '';
    for (const p of principals) {
      const r = await run(sshKeygen, ['-Y', 'verify', '-f', allowedSigners, '-I', p, '-n', namespace, '-s', sig], manifest);
      if (r.code === 0) return p;
      why = (r.stderr || r.stdout).trim();
    }
    throw new Error(`the signature does not verify: ${why}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A gate runs a signed cell's commands one by one (Step through, Run lines 1-N): each must be a
 * whole command that bash reads without errors or warnings on its own, else a command could run
 * text the reviewer saw as here-doc data or a function body. Problems as "cell N, command K: …";
 * undefined when `bash` can't be started (not checked).
 */
export async function checkSignedSteps(m: Manifest, bash: string): Promise<string[] | undefined> {
  const problems: string[] = [];
  for (const c of m.cells) {
    if (c.steps.length < 2) continue;
    for (let k = 0; k < c.steps.length; k++) {
      let r: Run;
      try {
        r = await run(bash, ['--norc', '--noprofile', '-n'], c.steps[k]!);
      } catch {
        return undefined;
      }
      const why = r.stderr.trim().split(/\r?\n/)[0];
      if (r.code !== 0 || why) problems.push(`cell ${c.n}, command ${k + 1} (${c.steps[k]!.split('\n')[0]}): ${why || `bash -n exit ${r.code}`}`);
    }
  }
  return problems;
}

/** `type base64` of an OpenSSH public key line, or undefined. */
function publicKeyOf(line: string): string | undefined {
  const [type, b64] = line.trim().split(/\s+/);
  return type && b64 && /^[A-Za-z0-9@._-]+$/.test(type) && /^[A-Za-z0-9+/]+={0,2}$/.test(b64) ? `${type} ${b64}` : undefined;
}

/**
 * The public key of `key` (`type base64`): from the private key (`ssh-keygen -y`, never asking
 * for a passphrase), else its `.pub` file (a key in the agent, or one with a passphrase).
 * undefined when neither works.
 */
export async function keyPublicKey(key: string, sshKeygen = 'ssh-keygen'): Promise<string | undefined> {
  if (!key.endsWith('.pub')) {
    try {
      const r = await run(sshKeygen, ['-y', '-P', '', '-f', key], '');
      const got = r.code === 0 ? publicKeyOf(r.stdout) : undefined;
      if (got) return got;
    } catch {
      // no ssh-keygen: the .pub file below
    }
  }
  try {
    return publicKeyOf(fs.readFileSync(key.endsWith('.pub') ? key : key + '.pub', 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Whether `key` made one of `signatures` of `manifest` (checked with ssh-keygen against its own
 * public key). Signing again reuses the old signature's name, scopes and patterns only then, or
 * when a trusted signer made it: anyone can edit the manifest in the file (review, 2026-11-28).
 */
export async function signedByKey(manifest: string, signatures: readonly string[], key: string, sshKeygen = 'ssh-keygen'): Promise<boolean> {
  const pub = await keyPublicKey(key, sshKeygen);
  if (!pub) return false;
  const dir = tempDir();
  try {
    const file = path.join(dir, 'allowed_signers');
    fs.writeFileSync(file, `signing-key namespaces="${SIGNATURE_NAMESPACE}" ${pub}\n`, 'utf8');
    for (const sig of signatures) {
      try {
        await sshVerify(manifest, sig, file, sshKeygen);
        return true;
      } catch {
        // the next one (a co-signer's)
      }
    }
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The comment of a key's public half (`… user@host`), the default signer name; undefined if none. */
export function keyComment(key: string): string | undefined {
  const pub = key.endsWith('.pub') ? key : key + '.pub';
  try {
    const parts = fs.readFileSync(pub, 'utf8').trim().split(/\s+/);
    return parts.length >= 3 ? parts.slice(2).join(' ') : undefined;
  } catch {
    return undefined;
  }
}

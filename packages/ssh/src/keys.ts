/**
 * Client keys and host-key pins. The app makes its own key with the library (P-256), because the
 * library can't read OpenSSH's own private key format nor the PKCS#8 that macOS's ssh-keygen
 * writes (spike finding); the user adds `publicKeyLine` to `authorized_keys`.
 */

import { KeyPair, SshAlgorithms } from '@microsoft/dev-tunnels-ssh';
import { KeyFormat, exportPrivateKey, exportPublicKey, importKey } from '@microsoft/dev-tunnels-ssh-keys';
import { PasskeyKeyPair, SK_ECDSA_P256 } from './passkey';

/**
 * `KeyFormat` is a const enum: tsc inlines it, but Babel (Metro, Jest) leaves `KeyFormat.Pkcs8`
 * as a read of an export that does not exist at run time. The value, with the type.
 */
const PKCS8 = 5 as KeyFormat;

export async function generateKey(): Promise<KeyPair> {
  const alg = SshAlgorithms.publicKey.ecdsaSha2Nistp256;
  if (!alg) throw new Error('ECDSA P-256 is not available on this platform');
  return alg.generateKeyPair();
}

/** `ecdsa-sha2-nistp256 AAAA… comment` (a passkey: `sk-ecdsa-sha2-nistp256@openssh.com AAAA…`), for `authorized_keys`. */
export async function publicKeyLine(key: KeyPair, comment = 'md-runbook'): Promise<string> {
  // The keys package knows no sk-ecdsa keys.
  if (key instanceof PasskeyKeyPair) return `${SK_ECDSA_P256} ${(await key.getPublicKeyBytes())!.toString('base64')} ${comment}`.trim();
  // The library ends the line with a newline; the comment belongs on the same line.
  return `${(await exportPublicKey(key)).trim()} ${comment}`.trim();
}

/** PKCS#8 PEM, unencrypted: store it in the platform's secure storage, not in a plain file. */
export function privateKeyPem(key: KeyPair): Promise<string> {
  return exportPrivateKey(key, null, PKCS8);
}

export function importPrivateKey(pem: string): Promise<KeyPair> {
  return importKey(pem);
}

/** `type base64` of an OpenSSH public key line, without the comment: what a host-key pin compares. */
export function hostKeyId(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(' ');
}

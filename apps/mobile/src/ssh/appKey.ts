/**
 * The app's own SSH key: made once with the SSH library (P-256, what every OpenSSH server
 * accepts and what the phones' hardware can hold later), kept in the platform's secure storage,
 * never imported from or exported to a file. The user adds its public key line to
 * `authorized_keys` on each host; the private key does not leave the device.
 */
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { generateKey, importPrivateKey, privateKeyPem, publicKeyLine } from '@md-runbook/ssh';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';

const KEY = 'app-key.pkcs8';
const COMMENT = 'md-runbook-app';
let cached: Promise<KeyPair> | undefined;

/** The key, made and stored on the first call. */
export function appKey(): Promise<KeyPair> {
  cached ??= (async () => {
    const pem = await getSecret(KEY);
    if (pem) {
      try {
        return await importPrivateKey(pem);
      } catch {
        // Unreadable (a different format from an older version): make a new one below.
      }
    }
    const key = await generateKey();
    await setSecret(KEY, await privateKeyPem(key));
    return key;
  })().catch((e: unknown) => {
    cached = undefined;
    throw e;
  });
  return cached;
}

/** `ecdsa-sha2-nistp256 AAAA… md-runbook-app`: the line for `authorized_keys`. */
export async function appPublicKeyLine(): Promise<string> {
  return publicKeyLine(await appKey(), COMMENT);
}

/** Throw the key away; the next use makes a new one (hosts then need the new public key). */
export async function resetAppKey(): Promise<void> {
  cached = undefined;
  await deleteSecret(KEY);
}

/**
 * The app's own SSH key (P-256, what every OpenSSH server accepts), never imported from or
 * exported to a file. The user adds its public key line to `authorized_keys` on each host.
 *
 * Where it lives:
 * - phones: made inside the secure hardware (Secure Enclave, Android Keystore) by the native
 *   HardwareKey module; the private key never reaches JavaScript, the hardware signs;
 * - a key made by an earlier version (PKCS#8 in secure storage) is kept: hosts already trust it;
 * - web, or phones where the hardware key fails: made by the SSH library, kept in secure storage
 *   (the browser's storage on the web).
 */
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { ExternalKeyPair, generateKey, importPrivateKey, privateKeyPem, publicKeyLine } from '@md-runbook/ssh';
import { Buffer } from 'buffer';
import { Platform } from 'react-native';
import { HardwareKey } from '../../modules/hardware-key';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';

const KEY = 'app-key.pkcs8';
const ALIAS = 'ssh-app-key';
const COMMENT = 'md-runbook-app';

/** hardware: Secure Enclave / TEE / StrongBox; keystore: the platform keystore without such hardware. */
export type KeyStorage = 'hardware' | 'keystore' | 'secure-store' | 'browser';

export interface AppKey {
  pair: KeyPair;
  storage: KeyStorage;
}

let cached: Promise<AppKey> | undefined;

async function softwareKey(): Promise<AppKey> {
  const storage: KeyStorage = Platform.OS === 'web' ? 'browser' : 'secure-store';
  const pem = await getSecret(KEY);
  if (pem) {
    try {
      return { pair: await importPrivateKey(pem), storage };
    } catch {
      // Unreadable (a different format from an older version): make a new one below.
    }
  }
  const pair = await generateKey();
  await setSecret(KEY, await privateKeyPem(pair));
  return { pair, storage };
}

async function hardwareKey(hw: NonNullable<typeof HardwareKey>): Promise<AppKey> {
  const publicKey = (await hw.publicKey(ALIAS)) ?? (await hw.generate(ALIAS)).publicKey;
  const pair = await ExternalKeyPair.create({
    publicKey: new Uint8Array(Buffer.from(publicKey, 'base64')),
    sign: async (data) => new Uint8Array(Buffer.from(await hw.sign(ALIAS, Buffer.from(data).toString('base64')), 'base64')),
  });
  return { pair, storage: (await hw.isHardware(ALIAS)) ? 'hardware' : 'keystore' };
}

/** The key and where it is kept; made on the first call. */
export function appKeyInfo(): Promise<AppKey> {
  cached ??= (async () => {
    // A key from an earlier version stays: the hosts have its public key.
    if ((await getSecret(KEY)) !== null || !HardwareKey) return softwareKey();
    try {
      return await hardwareKey(HardwareKey);
    } catch {
      return softwareKey();
    }
  })().catch((e: unknown) => {
    cached = undefined;
    throw e;
  });
  return cached;
}

export async function appKey(): Promise<KeyPair> {
  return (await appKeyInfo()).pair;
}

/** `ecdsa-sha2-nistp256 AAAA… md-runbook-app`: the line for `authorized_keys`. */
export async function appPublicKeyLine(): Promise<string> {
  return publicKeyLine(await appKey(), COMMENT);
}

/** Throw the key away; the next use makes a new one (hosts then need the new public key). */
export async function resetAppKey(): Promise<void> {
  cached = undefined;
  await deleteSecret(KEY);
  await HardwareKey?.remove(ALIAS);
}

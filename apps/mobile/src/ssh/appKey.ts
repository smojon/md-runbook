/**
 * The app's own SSH key (P-256, what every OpenSSH server accepts), never imported from or
 * exported to a file. The user adds its public key line to `authorized_keys` on each host.
 *
 * Where it lives:
 * - phones: made inside the secure hardware (Secure Enclave, Android Keystore) by the native
 *   HardwareKey module; the private key never reaches JavaScript, the hardware signs;
 * - a key made by an earlier version (PKCS#8 in secure storage) is kept: hosts already trust it;
 * - web, or phones where the hardware key fails: made by the SSH library, kept in secure storage
 *   (the browser's storage on the web);
 * - web with "Use a passkey" on: a passkey for this site (passkey.ts); the authenticator signs.
 */
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { ExternalKeyPair, allowedSignersLine, generateKey, importPrivateKey, privateKeyPem, publicKeyLine } from '@md-runbook/ssh';
import { Buffer } from 'buffer';
import { Platform } from 'react-native';
import { HardwareKey } from '../../modules/hardware-key';
import { deleteSecret, getSecret, setSecret } from '../storage/secure';
import { createPasskey, forgetPasskey, loadPasskey, passkeysAvailable } from './passkey';
import { loadSettings, outputSettings, setOutputSetting } from '../settings/store';

const KEY = 'app-key.pkcs8';
const ALIAS = 'ssh-app-key';
const COMMENT = 'md-runbook-app';

/** hardware: Secure Enclave / TEE / StrongBox; keystore: the platform keystore without such hardware. */
export type KeyStorage = 'hardware' | 'keystore' | 'secure-store' | 'browser' | 'passkey';

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
  // Made with Hosts & settings' choice: whether each use asks for Face ID or a fingerprint.
  await loadSettings();
  const publicKey = (await hw.publicKey(ALIAS)) ?? (await hw.generate(ALIAS, outputSettings().keyNeedsUser)).publicKey;
  const pair = await ExternalKeyPair.create({
    publicKey: new Uint8Array(Buffer.from(publicKey, 'base64')),
    sign: async (data) => new Uint8Array(Buffer.from(await hw.sign(ALIAS, Buffer.from(data).toString('base64')), 'base64')),
  });
  return { pair, storage: (await hw.isHardware(ALIAS)) ? 'hardware' : 'keystore' };
}

/**
 * The passkey made with "Use a passkey". Never made here: making one asks the person, which only
 * the switch's button may start (Safari refuses WebAuthn without a tap).
 */
async function passkeyKey(): Promise<AppKey> {
  const pair = await loadPasskey();
  if (!pair) throw new Error('no passkey for this site yet: turn "Use a passkey" off and on again to make one');
  return { pair, storage: 'passkey' };
}

/** The key and where it is kept; made on the first call. */
export function appKeyInfo(): Promise<AppKey> {
  cached ??= (async () => {
    if (passkeysAvailable()) {
      await loadSettings();
      // On the web the switch means a passkey: the authenticator asks for the person each time.
      if (outputSettings().keyNeedsUser) return passkeyKey();
    }
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

/**
 * `ecdsa-sha2-nistp256 AAAA… md-runbook-app`: the line for `authorized_keys`. A passkey's starts
 * with `verify-required`, so sshd also refuses a signature made without the person's fingerprint,
 * face or PIN.
 */
export async function appPublicKeyLine(): Promise<string> {
  const { pair, storage } = await appKeyInfo();
  const line = await publicKeyLine(pair, COMMENT);
  return storage === 'passkey' ? `verify-required ${line}` : line;
}

/** Throw the key away; the next use makes a new one (hosts then need the new public key). */
export async function resetAppKey(): Promise<void> {
  cached = undefined;
  await deleteSecret(KEY);
  await HardwareKey?.remove(ALIAS);
  if (passkeysAvailable()) await forgetPasskey();
}

/**
 * Ask for Face ID, Touch ID, a fingerprint or the screen lock on every use of the key, or stop
 * asking. The hardware only enforces it on a key made that way, so this makes a new key: hosts
 * (authorized_keys) and servers' allowed_signers need its public key again. On the web, on means
 * a passkey: call this from a tap, as making one asks the person.
 */
export async function setKeyNeedsUser(on: boolean): Promise<AppKey> {
  if (on && passkeysAvailable()) {
    // Made first: a refused or cancelled passkey leaves the current key and the setting as they were.
    const pair = await createPasskey();
    setOutputSetting('keyNeedsUser', true);
    cached = undefined;
    await deleteSecret(KEY);
    cached = Promise.resolve({ pair, storage: 'passkey' });
    return cached;
  }
  setOutputSetting('keyNeedsUser', on);
  await resetAppKey();
  return appKeyInfo();
}

/** `principal namespaces="md-runbook" ecdsa-sha2-nistp256 AAAA…`: the line for the servers' allowed_signers (signing runbooks). */
export async function appAllowedSignersLine(principal: string): Promise<string> {
  return allowedSignersLine(await appKey(), principal);
}
